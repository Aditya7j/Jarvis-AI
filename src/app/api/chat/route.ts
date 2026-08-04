import { aiService, toErrorPayload } from "@/lib/ai";
import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { aiLogger } from "@/lib/ai/logger";
import {
  DEFAULT_SYSTEM_PROMPT,
  VISION_STRUCTURED_PROMPT,
  buildVisionErrorContext,
  buildVisionSystemContext,
  parseVisionAnalysis,
  summarizeVisionAnalysis,
} from "@/lib/ai/prompts";
import type {
  VisionAnalysisSummary,
  VisionStructuredAnalysis,
} from "@/lib/ai/prompts";
import { classifyVisionDepth } from "@/lib/ai/vision-intent";
import {
  BATTERY_DENIED_REPLY,
  GEOLOCATION_DENIED_REPLY,
  WEATHER_FAILED_REPLY,
  WEATHER_NO_LOCATION_REPLY,
  buildVerifiedFactContext,
  classifyToolIntent,
  toolLabelFor,
  type ToolIntent,
} from "@/lib/ai/intent-router";
import {
  getSystemClock,
  getWeather,
  type BatteryResult,
  type GeolocationResult,
  type SystemClockFact,
} from "@/lib/ai/system-tools";
import { visionCache } from "@/lib/vision/vision-cache";
import {
  LIVE_VISION_STALE_MS,
} from "@/lib/vision/live-vision-engine";
import { CONFIDENCE_MID } from "@/lib/vision/confidence";
import {
  resolveVisualQuestion,
  type VisionRoutingMeta,
} from "@/lib/vision/vision-manager";
import { saveDebugFrame } from "@/lib/vision/debug-frame";
import type { AIMessageInput } from "@/lib/ai/types";

export const runtime = "nodejs";

interface ChatMessageBody {
  role?: string;
  content?: string;
}

interface VisionFrameBody {
  image?: string;
  mimeType?: string;
  source?: "webcam" | "screen";
  width?: number;
  height?: number;
  capturedAt?: number;
}

type VisionState = "off" | "live" | "no-frame";

interface ChatRequestBody {
  messages?: ChatMessageBody[];
  model?: string;
  stream?: boolean;
  vision?: { state?: VisionState; image?: string; mimeType?: string; frames?: VisionFrameBody[] };
  tools?: {
    systemClock?: SystemClockFact;
    geolocation?: GeolocationResult;
    battery?: BatteryResult;
  };
}

interface NormalizedFrame {
  image: string;
  mimeType: string;
  source?: "webcam" | "screen";
  width?: number;
  height?: number;
  capturedAt?: number;
}

interface VisionPlan {
  systemContext: string | null;
  summary: VisionAnalysisSummary | null;
  cancelled?: boolean;
}

interface RoutingTelemetry {
  requestId: string;
  requestType: VisionRoutingMeta["requestType"];
  cacheHit: boolean;
  cacheAgeMs: number | null;
  gemmaInvoked: boolean;
  qwenInvoked: boolean;
  totalLatencyMs: number;
}

interface ToolRouting {
  intent: ToolIntent;
  tool: string;
  latencyMs: number;
  fallbackReason: string | null;
}

type ToolPlan =
  | { kind: "direct"; text: string; routing: ToolRouting }
  | { kind: "naturalize"; systemContext: string; routing: ToolRouting };

type VisualRoute =
  | {
      kind: "direct";
      text: string;
      summary: VisionAnalysisSummary | null;
      meta: VisionRoutingMeta;
    }
  | { kind: "llm"; plan: VisionPlan; gemmaInvoked: boolean; meta: VisionRoutingMeta };

type ChatStreamEvent =
  | { kind: "token"; text: string }
  | { kind: "status"; phase: string }
  | { kind: "vision"; summary: VisionAnalysisSummary }
  | { kind: "routing"; routing: RoutingTelemetry }
  | { kind: "tool"; routing: ToolRouting };

/**
 * Cancels the in-flight Gemma 3 inference of a previous request when a new
 * vision request arrives, so stale analysis never blocks fresh work.
 */
let activeVisionController: AbortController | null = null;

function cancelActiveVision(): void {
  if (activeVisionController) {
    activeVisionController.abort();
    activeVisionController = null;
  }
}

function stripDataUrlPrefix(image: string): string {
  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");
    if (comma >= 0) return image.slice(comma + 1);
  }
  return image;
}

function normalizeFrames(
  vision?: ChatRequestBody["vision"]
): NormalizedFrame[] {
  const frames: NormalizedFrame[] = [];
  if (vision?.frames?.length) {
    for (const frame of vision.frames.slice(0, 3)) {
      const image = frame.image ? stripDataUrlPrefix(frame.image) : null;
      if (image) {
        frames.push({
          image,
          mimeType: frame.mimeType || "image/jpeg",
          source: frame.source,
          width: frame.width,
          height: frame.height,
          capturedAt: frame.capturedAt,
        });
      }
    }
  }
  if (frames.length === 0 && vision?.image) {
    const image = stripDataUrlPrefix(vision.image);
    if (image) {
      frames.push({ image, mimeType: vision.mimeType || "image/jpeg" });
    }
  }
  // Order by descending encoded size: for a fixed resolution/quality the larger
  // JPEG is the sharper, more detailed frame, so frames[0] (used for both the
  // YOLO refresh and Gemma) is always the best candidate — never the newest
  // merely because it is newest.
  return frames.sort((a, b) => b.image.length - a.image.length);
}

function withDefaultSystem(messages: AIMessageInput[]): AIMessageInput[] {
  if (messages.some((m) => m.role === "system")) return messages;
  return [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...messages];
}

function injectSystemBlock(
  messages: AIMessageInput[],
  systemBlock: string
): AIMessageInput[] {
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) {
    const copy = messages.slice();
    copy[index] = {
      ...copy[index],
      content: `${copy[index].content}\n\n${systemBlock}`,
    };
    return copy;
  }
  return [
    { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${systemBlock}` },
    ...messages,
  ];
}

function toSSE(
  stream: AsyncGenerator<ChatStreamEvent>,
  signal?: AbortSignal,
  requestId?: string,
  onFinal?: (text: string) => void,
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let chars = 0;
  let full = "";
  const log = aiLogger.child("chat");
  const aborted = () => {
    stream.return(undefined).catch(() => {});
  };
  signal?.addEventListener("abort", aborted, { once: true });
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (signal?.aborted) break;
          if (event.kind === "status") {
            controller.enqueue(
              encoder.encode(
                `event: vision_state\ndata: ${JSON.stringify({
                  phase: event.phase,
                })}\n\n`
              )
            );
            continue;
          }
          if (event.kind === "vision") {
            controller.enqueue(
              encoder.encode(
                `event: vision\ndata: ${JSON.stringify({
                  vision: event.summary,
                })}\n\n`
              )
            );
            continue;
          }
          if (event.kind === "routing") {
            controller.enqueue(
              encoder.encode(
                `event: routing\ndata: ${JSON.stringify(event.routing)}\n\n`
              )
            );
            continue;
          }
          if (event.kind === "tool") {
            controller.enqueue(
              encoder.encode(
                `event: tool\ndata: ${JSON.stringify(event.routing)}\n\n`
              )
            );
            continue;
          }
          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
            log.info("Streaming started", {
              requestId,
              ttftMs: firstTokenAt - startedAt,
            });
          }
          chars += event.text.length;
          full += event.text;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ token: event.text })}\n\n`)
          );
        }
        if (!signal?.aborted) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`)
          );
          log.info("Streaming finished", {
            requestId,
            chars,
            ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null,
            totalMs: Date.now() - startedAt,
          });
          onFinal?.(full);
        } else {
          log.info("Streaming aborted", {
            requestId,
            chars,
            totalMs: Date.now() - startedAt,
          });
        }
      } catch (error) {
        const payload = toErrorPayload(error);
        log.warn("Streaming error", {
          requestId,
          code: payload.code,
          message: payload.message,
          totalMs: Date.now() - startedAt,
        });
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: payload })}\n\n`
          )
        );
      } finally {
        signal?.removeEventListener("abort", aborted);
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return invalidRequest("Invalid JSON request body.");
  }

  const messages = (body.messages ?? [])
    .map((m) => ({
      role: (m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user") as
        | "system"
        | "user"
        | "assistant",
      content: m.content ?? "",
    }))
    .filter((m) => m.content.length > 0);

  if (messages.length === 0) {
    return invalidRequest("No message content provided.");
  }

  const options = { messages, model: body.model };
  const log = aiLogger.child("chat");
  const requestId = crypto.randomUUID();
  // Aborts in-flight LLM/Gemma work when the caller disconnects. request.signal
  // does not reliably fire on client disconnect in Next.js route handlers, so
  // the response stream's cancel() is also wired into this controller (see the
  // toSSE onCancel hook below).
  const requestAbort = new AbortController();
  request.signal.addEventListener("abort", () => requestAbort.abort(), { once: true });
  const frames = normalizeFrames(body.vision);
  const visionState: VisionState =
    body.vision?.state === "live" || body.vision?.state === "no-frame"
      ? body.vision.state
      : "off";
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const prompt = lastUserMessage?.content ?? "";
  const toolIntent = classifyToolIntent(prompt);
  const needsVision = toolIntent === "vision" || toolIntent === "ocr";

  log.info("Chat request started", {
    requestId,
    messages: messages.length,
    stream: body.stream !== false,
    model: body.model ?? "auto",
    vision: visionState,
    frames: frames.length,
    intent: toolIntent,
    tool: toolLabelFor(toolIntent),
  });

  async function analyzeNewestFrame(
    frame: NormalizedFrame,
    signal?: AbortSignal
  ): Promise<{ analysis: VisionStructuredAnalysis | null; error: string | null }> {
    const startedAt = Date.now();
    const imageBytes = Math.round(frame.image.length * 0.75);
    const debugFrame = saveDebugFrame(frame.image, frame.mimeType);
    log.info("✓ Frame sent to Gemma 3", {
      requestId,
      width: frame.width ?? null,
      height: frame.height ?? null,
      imageBytes,
      debugFrame,
    });
    log.info("✓ Prompt sent to Gemma 3", {
      requestId,
      prompt: VISION_STRUCTURED_PROMPT,
    });
    try {
      const raw = await aiService.analyzeCameraFrame({
        imageBase64: frame.image,
        mimeType: frame.mimeType,
        prompt: VISION_STRUCTURED_PROMPT,
        signal,
      });
      log.info("✓ Gemma 3 raw response", {
        requestId,
        chars: raw.length,
        raw: raw.slice(0, 2000),
        latencyMs: Date.now() - startedAt,
      });
      const analysis = parseVisionAnalysis(raw);
      if (analysis) {
        log.info("✓ Structured JSON created", {
          requestId,
          objects: analysis.visible_objects.length,
          personConfidence: analysis.person.confidence,
          latencyMs: Date.now() - startedAt,
        });
        return { analysis, error: null };
      }
      const error = `Gemma 3 response could not be parsed as structured JSON (received ${raw.length} chars).`;
      log.error("✕ Vision pipeline failed — structured JSON could not be created", {
        requestId,
        raw,
        latencyMs: Date.now() - startedAt,
      });
      return { analysis: null, error };
    } catch (error) {
      const payload = toErrorPayload(error);
      if (signal?.aborted) {
        log.info("Vision analysis cancelled (stale or aborted)", {
          requestId,
          latencyMs: Date.now() - startedAt,
        });
        return { analysis: null, error: "cancelled" };
      }
      const detail = `Gemma 3 frame analysis failed: [${payload.code}] ${payload.message}`;
      log.error("✕ Vision pipeline failed — request to Gemma 3 errored", {
        requestId,
        code: payload.code,
        message: payload.message,
        latencyMs: Date.now() - startedAt,
      });
      return { analysis: null, error: detail };
    }
  }

  /**
   * The cached analysis may only be reused when the frame it was built from is
   * still the current one. If the request carries a NEWER frame (capturedAt
   * ahead of the cached frame by more than the skew window) the scene may have
   * changed, so the cache is skipped and the new frame is re-analyzed. This is
   * what prevents "fresh frame capture, stale answer".
   */
  const VISION_CACHE_FRAME_SKEW_MS = 250;

  function cachedVisionPlan(
    source: NormalizedFrame["source"],
    newest?: NormalizedFrame
  ): VisionPlan | null {
    const cached = visionCache.get(source);
    if (!cached) return null;
    if (Date.now() - cached.capturedAt > LIVE_VISION_STALE_MS) {
      log.info("Vision cache entry is stale (frame older than 1s); re-analyzing", {
        requestId,
        ageMs: Date.now() - cached.capturedAt,
      });
      return null;
    }
    if (newest?.capturedAt && newest.capturedAt - cached.capturedAt > VISION_CACHE_FRAME_SKEW_MS) {
      log.info("Vision cache entry is from an older frame; re-analyzing", {
        requestId,
        cachedAt: cached.capturedAt,
        frameAt: newest.capturedAt,
        skewMs: newest.capturedAt - cached.capturedAt,
      });
      return null;
    }
    log.info("✓ Vision result reused from cache", {
      requestId,
      ageMs: Date.now() - cached.analyzedAt,
      summary: cached.summary,
    });
    return { systemContext: cached.systemContext, summary: cached.summary };
  }

  /**
   * Aborts any previous request's Gemma inference and returns an AbortSignal
   * for this one. `done()` unlinks the caller's abort signal and clears the
   * module slot so a stale request cannot cancel a newer one.
   */
  function beginVisionAnalysis(): { signal: AbortSignal; done: () => void } {
    cancelActiveVision();
    const controller = new AbortController();
    activeVisionController = controller;
    const onAbort = () => controller.abort();
    requestAbort.signal.addEventListener("abort", onAbort, { once: true });
    return {
      signal: controller.signal,
      done: () => {
        requestAbort.signal.removeEventListener("abort", onAbort);
        if (activeVisionController === controller) {
          activeVisionController = null;
        }
      },
    };
  }

  async function analyzeAndCachePlan(
    frame: NormalizedFrame
  ): Promise<VisionPlan> {
    const run = beginVisionAnalysis();
    try {
      const result = await analyzeNewestFrame(frame, run.signal);
      if (!result.analysis) {
        if (result.error === "cancelled") {
          return { systemContext: null, summary: null, cancelled: true };
        }
        return {
          systemContext: buildVisionErrorContext(
            result.error ?? "Unknown vision pipeline error"
          ),
          summary: summarizeVisionAnalysis(null, {
            state: "error",
            source: frame.source,
            capturedAt: frame.capturedAt,
            error: result.error,
          }),
        };
      }
      const systemContext = buildVisionSystemContext(result.analysis);
      const summary = summarizeVisionAnalysis(result.analysis, {
        state: "live",
        source: frame.source,
        capturedAt: frame.capturedAt,
      });
      visionCache.set({
        summary,
        analysis: result.analysis,
        systemContext,
        source: frame.source ?? "webcam",
        capturedAt: frame.capturedAt ?? Date.now(),
        analyzedAt: Date.now(),
      });
      return { systemContext, summary };
    } finally {
      run.done();
    }
  }

  /**
   * Enforce the <70% follow-up contract on Gemma-grounded answers: when the
   * overall vision confidence is below CONFIDENCE_MID the LLM is instructed to
   * hedge and invite repositioning instead of asserting details.
   */
  function withConfidenceHedge(plan: VisionPlan): VisionPlan {
    const confidence = plan.summary?.confidence;
    if (confidence === null || confidence === undefined || confidence >= CONFIDENCE_MID) {
      return plan;
    }
    if (!plan.systemContext) return plan;
    const hedge = `\n\nOverall vision confidence is low (${confidence}%, below ${CONFIDENCE_MID}%). If the user asked about anything currently visible, answer with a clear uncertainty hedge and invite them to reposition the camera or move closer — never assert visual details you are not sure about.`;
    return { ...plan, systemContext: `${plan.systemContext}${hedge}` };
  }

  /**
   * Route one visual question through the Vision Manager — the single choke
   * point for every camera question. The manager decides cache/refusal vs
   * Gemma; Qwen only ever sees grounded vision facts, never the raw frame.
   */
  async function routeVisual(
    prompt: string,
    depth: "simple" | "complex"
  ): Promise<VisualRoute> {
    const resolution = await resolveVisualQuestion({
      prompt,
      depth,
      visionState,
      frames,
    });
    switch (resolution.kind) {
      case "cached":
      case "no-camera":
      case "no-frame":
        return {
          kind: "direct",
          text: resolution.text,
          summary: resolution.summary,
          meta: resolution.meta,
        };
      case "gemma": {
        const newest = resolution.frame;
        const cached = cachedVisionPlan(newest.source, newest);
        if (cached) {
          return {
            kind: "llm",
            plan: withConfidenceHedge(cached),
            gemmaInvoked: false,
            meta: resolution.meta,
          };
        }
        const plan = await analyzeAndCachePlan(newest);
        return {
          kind: "llm",
          plan: withConfidenceHedge(plan),
          gemmaInvoked: true,
          meta: resolution.meta,
        };
      }
    }
  }

  const streamQwen = async function* (
    contextualMessages: AIMessageInput[]
  ): AsyncGenerator<ChatStreamEvent> {
    for await (const token of aiService.streamText({
      ...options,
      signal: requestAbort.signal,
      messages: withDefaultSystem(contextualMessages),
    })) {
      yield { kind: "token", text: token };
    }
  };

  function routingTelemetry(
    meta: VisionRoutingMeta,
    qwenInvoked: boolean,
    startedAt: number
  ): RoutingTelemetry {
    return {
      requestId,
      requestType: meta.requestType,
      cacheHit: meta.cacheHit,
      cacheAgeMs: meta.cacheAgeMs,
      gemmaInvoked: meta.gemmaInvoked,
      qwenInvoked,
      totalLatencyMs: Date.now() - startedAt,
    };
  }

  /**
   * Route a non-vision, non-LLM request through its verified system tool. The
   * tool output is the ONLY source of truth. `naturalize` answers still go
   * through the LLM, but the verified fact is injected as immutable system
   * context. `direct` answers (tool denied/unavailable) never touch the LLM.
   */
  async function resolveToolPlan(): Promise<ToolPlan> {
    const startedAt = Date.now();
    const intent = toolIntent;
    const tool = toolLabelFor(intent);
    const routing = (fallbackReason: string | null): ToolRouting => ({
      intent,
      tool,
      latencyMs: Date.now() - startedAt,
      fallbackReason,
    });
    const clientTools = body.tools;
    switch (intent) {
      case "system-clock": {
        const fact = clientTools?.systemClock ?? getSystemClock();
        return {
          kind: "naturalize",
          routing: routing(null),
          systemContext: buildVerifiedFactContext(
            tool,
            "the current time, date and timezone",
            fact
          ),
        };
      }
      case "geolocation": {
        const location = clientTools?.geolocation;
        if (location?.granted) {
          return {
            kind: "naturalize",
            routing: routing(null),
            systemContext: buildVerifiedFactContext(
              tool,
              "your current location",
              location
            ),
          };
        }
        return {
          kind: "direct",
          routing: routing(
            location ? "geolocation_permission_denied" : "no_location_data"
          ),
          text: GEOLOCATION_DENIED_REPLY,
        };
      }
      case "battery": {
        const battery = clientTools?.battery;
        if (battery?.granted) {
          return {
            kind: "naturalize",
            routing: routing(null),
            systemContext: buildVerifiedFactContext(
              tool,
              "your device's battery status",
              battery
            ),
          };
        }
        return {
          kind: "direct",
          routing: routing(
            battery ? "battery_unavailable" : "no_battery_data"
          ),
          text: BATTERY_DENIED_REPLY,
        };
      }
      case "weather": {
        const location = clientTools?.geolocation;
        if (!location?.granted) {
          return {
            kind: "direct",
            routing: routing(
              location ? "geolocation_permission_denied" : "no_location_data"
            ),
            text: WEATHER_NO_LOCATION_REPLY,
          };
        }
        try {
          const weather = await getWeather(
            location.latitude,
            location.longitude
          );
          return {
            kind: "naturalize",
            routing: routing(null),
            systemContext: buildVerifiedFactContext(
              tool,
              "the current weather",
              weather
            ),
          };
        } catch (error) {
          log.warn("Weather API failed", {
            requestId,
            message: error instanceof Error ? error.message : String(error),
          });
          return {
            kind: "direct",
            routing: routing("weather_api_failed"),
            text: WEATHER_FAILED_REPLY,
          };
        }
      }
      default: {
        // Vision/LLM intents are handled by the caller — never reached.
        return {
          kind: "direct",
          routing: routing("unhandled_intent"),
          text: "I can't answer that right now.",
        };
      }
    }
  }

  async function* createStream(): AsyncGenerator<ChatStreamEvent> {
    if (needsVision) {
      const depth = classifyVisionDepth(prompt);
      const startedAt = Date.now();
      const route = await routeVisual(prompt, depth);
      if (route.kind === "direct") {
        const telemetry = routingTelemetry(route.meta, false, startedAt);
        log.info("[routing]", { ...telemetry });
        if (route.summary) yield { kind: "vision", summary: route.summary };
        yield { kind: "status", phase: "cached" };
        yield { kind: "token", text: route.text };
        yield { kind: "routing", routing: telemetry };
        return;
      }
      const plan = route.plan;
      if (plan.cancelled) {
        yield { kind: "status", phase: "cancelled" };
        const telemetry = routingTelemetry(route.meta, false, startedAt);
        log.info("[routing]", { ...telemetry });
        yield { kind: "routing", routing: telemetry };
        return;
      }
      if (plan.summary) yield { kind: "vision", summary: plan.summary };
      yield { kind: "status", phase: "answering" };
      log.info("✓ Vision JSON passed to reasoning model", {
        requestId,
        state: visionState,
        summary: plan.summary,
      });
      yield* streamQwen(
        plan.systemContext
          ? injectSystemBlock(messages, plan.systemContext)
          : messages
      );
      const telemetry = routingTelemetry(route.meta, true, startedAt);
      log.info("[routing]", { ...telemetry });
      yield { kind: "routing", routing: telemetry };
      return;
    }

    if (toolIntent !== "llm") {
      const plan = await resolveToolPlan();
      log.info("[tool-routing]", { requestId, ...plan.routing });
      yield { kind: "tool", routing: plan.routing };
      if (plan.kind === "direct") {
        yield { kind: "status", phase: "tool" };
        yield { kind: "token", text: plan.text };
        return;
      }
      yield { kind: "status", phase: "answering" };
      yield* streamQwen(injectSystemBlock(messages, plan.systemContext));
      return;
    }

    yield { kind: "status", phase: "text" };
    yield* streamQwen(messages);
  }

  if (body.stream === false) {
    try {
      const startedAt = Date.now();
      if (needsVision) {
        const route = await routeVisual(prompt, classifyVisionDepth(prompt));
        if (route.kind === "direct") {
          const telemetry = routingTelemetry(route.meta, false, startedAt);
          log.info("[routing]", { ...telemetry });
          return Response.json({
            text: route.text,
            vision: route.summary,
            cached: true,
            routing: telemetry,
          });
        }
        const plan = route.plan;
        if (plan.cancelled) {
          const telemetry = routingTelemetry(route.meta, false, startedAt);
          log.info("[routing]", { ...telemetry });
          return jsonError(new Error("Vision analysis cancelled."), 499);
        }
        const contextualMessages = plan.systemContext
          ? injectSystemBlock(messages, plan.systemContext)
          : messages;
        if (plan.summary) {
          log.info("✓ Vision JSON passed to reasoning model", {
            requestId,
            state: visionState,
            summary: plan.summary,
          });
        }
        const text = await aiService.generateText({
          ...options,
          signal: requestAbort.signal,
          messages: withDefaultSystem(contextualMessages),
        });
        const telemetry = routingTelemetry(route.meta, true, startedAt);
        log.info("[routing]", { ...telemetry });
        log.info("Final answer", {
          requestId,
          chars: text.length,
          text,
          latencyMs: Date.now() - startedAt,
        });
        return Response.json({ text, vision: plan.summary, routing: telemetry });
      }
      if (toolIntent !== "llm") {
        const plan = await resolveToolPlan();
        log.info("[tool-routing]", { requestId, ...plan.routing });
        if (plan.kind === "direct") {
          return Response.json({ text: plan.text, toolRouting: plan.routing });
        }
        const text = await aiService.generateText({
          ...options,
          signal: requestAbort.signal,
          messages: withDefaultSystem(
            injectSystemBlock(messages, plan.systemContext)
          ),
        });
        log.info("Final answer", {
          requestId,
          chars: text.length,
          text,
          latencyMs: Date.now() - startedAt,
        });
        return Response.json({ text, toolRouting: plan.routing });
      }
      log.info("Text-only request — vision skipped", { requestId });
      const text = await aiService.generateText({
        ...options,
        signal: requestAbort.signal,
        messages: withDefaultSystem(messages),
      });
      return Response.json({ text, vision: null });
    } catch (error) {
      return jsonError(error, 502);
    }
  }

  return new Response(
    toSSE(
      createStream(),
      requestAbort.signal,
      requestId,
      (text) => {
        log.info("Final answer", { requestId, chars: text.length, text });
      },
      () => requestAbort.abort()
    ),
    {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }
  );
}
