import { aiService, toErrorPayload } from "@/lib/ai";
import { invalidRequest, jsonError } from "@/lib/api-helpers";
import { aiLogger } from "@/lib/ai/logger";
import type { VisionAnalysisSummary } from "@/lib/ai/prompts";
import {
  runPipeline,
  type PipelineEvent,
  type PipelineOptions,
} from "@/services/chat";

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
  vision?: {
    state?: VisionState;
    image?: string;
    mimeType?: string;
    frames?: VisionFrameBody[];
  };
  tools?: PipelineOptions["clientTools"];
}

interface NormalizedFrame {
  image: string;
  mimeType: string;
  source?: "webcam" | "screen";
  width?: number;
  height?: number;
  capturedAt?: number;
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

/**
 * Map the pipeline's typed events onto the SSE contract the client parses:
 *   event: vision_state  data: { phase }
 *   event: vision        data: { vision: summary }
 *   event: tool          data: { intent, tool, latencyMs, ok, fallbackReason }
 *   data: { token }  |  data: { done: true }  |  event: error data: { error }
 */
function toSSE(
  stream: AsyncGenerator<PipelineEvent>,
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
          if (event.kind === "tool") {
            controller.enqueue(
              encoder.encode(
                `event: tool\ndata: ${JSON.stringify({
                  intent: event.intent,
                  tool: event.tool,
                  latencyMs: event.latencyMs,
                  ok: event.ok,
                  fallbackReason: event.fallbackReason,
                })}\n\n`
              )
            );
            continue;
          }
          if (event.kind === "fact") continue;
          if (event.kind === "plan") continue;
          if (event.kind === "source") continue;
          if (event.kind === "done") break;
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
  const prompt =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  log.info("Chat request started", {
    requestId,
    messages: messages.length,
    stream: body.stream !== false,
    model: body.model ?? "auto",
    vision: visionState,
    frames: frames.length,
    prompt: prompt.slice(0, 120),
  });

  const stream = runPipeline(prompt, messages, aiService, {
    signal: requestAbort.signal,
    model: body.model,
    clientTools: body.tools,
    vision: { state: visionState, frames },
  });

  if (body.stream === false) {
    try {
      const startedAt = Date.now();
      let text = "";
      let summary: VisionAnalysisSummary | null = null;
      let source: string | null = null;
      let toolRouting: {
        intent: string;
        tool: string;
        latencyMs: number;
        ok: boolean;
        fallbackReason?: string;
      } | null = null;
      for await (const event of stream) {
        if (event.kind === "token") text += event.text;
        else if (event.kind === "vision") summary = event.summary;
        else if (event.kind === "source") source = event.source;
        else if (event.kind === "tool") {
          toolRouting = {
            intent: event.intent,
            tool: event.tool,
            latencyMs: event.latencyMs,
            ok: event.ok,
            fallbackReason: event.fallbackReason,
          };
        }
      }
      log.info("Final answer", {
        requestId,
        chars: text.length,
        text,
        source,
        latencyMs: Date.now() - startedAt,
      });
      return Response.json({ text, vision: summary, toolRouting, source });
    } catch (error) {
      return jsonError(error, 502);
    }
  }

  return new Response(
    toSSE(
      stream,
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
