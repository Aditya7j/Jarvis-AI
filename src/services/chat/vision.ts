/**
 * Vision resolution for the chat pipeline.
 *
 * Every visual question funnels through the Vision Manager (cache-first,
 * Gemma-only-for-complex, hard refusal when no camera/frame). This module owns
 * the per-request Gemma analysis: the structured prompt, cache reuse with frame
 * skew protection, stale-analysis cancellation and the <70% confidence hedge.
 * The reasoning model (Qwen) only ever sees grounded vision facts injected as
 * system context — never a raw frame.
 */

import { toErrorPayload } from "@/lib/ai/errors";
import { aiLogger } from "@/lib/ai/logger";
import {
  VISION_STRUCTURED_PROMPT,
  VISION_WEARING_PROMPT,
  buildFocusedHoldingPrompt,
  buildVisionErrorContext,
  buildVisionSystemContext,
  parseFocusedVisionAnalysis,
  parseVisionAnalysis,
  parseWearingVisionAnalysis,
  summarizeVisionAnalysis,
  type FocusedVisionResult,
  type VisionAnalysisSummary,
  type VisionStructuredAnalysis,
} from "@/lib/ai/prompts";
import { stripDataUrlPrefix } from "@/lib/ai/image-resize";
import {
  groundHeldVlmTiered,
  type HeldObjectEvidence,
} from "@/lib/vision/hold-grounding";
import type { VisionDepth } from "@/lib/ai/vision-intent";
import { CONFIDENCE_MID } from "@/lib/vision/confidence";
import { getCurrentWaterfall } from "@/lib/metrics/waterfall";
import { localizeReply } from "@/lib/lang/replies";
import type { SpokenLanguage } from "@/lib/lang/detect";
import { saveDebugFrame } from "@/lib/vision/debug-frame";
import {
  beginVisionAnalysis,
  cachedVisionPlan,
  cacheVisionResult,
  resolveVisualQuestion,
  type VisionFrameInput,
} from "@/lib/vision/vision-manager";
import { getVisionStateStore } from "@/lib/vision/vision-state";
import type { PipelineModel } from "./pipeline";

const log = aiLogger.child("vision-resolution");

/**
 * Hard interactive timeout for a single Gemma frame analysis. Vision must feel
 * conversational: if Gemma cannot answer within this window we return a direct,
 * grounded failure instead of making the user wait through a full model
 * timeout.
 *
 * 30s (not 8s): on CPU-only Ollama boxes a full-res frame used to take 50-77s.
 * The frame is now downscaled to <=512px and num_predict is capped per call
 * (96 focused / 384 full), so gemma3:4b finishes within this window on modest
 * hardware — and when it truly cannot, we still degrade to the honest cache
 * text rather than a hallucinated answer.
 */
export const VISION_INTERACTIVE_TIMEOUT_MS = 30_000;

export interface VisionGrounding {
  source: "scene-cache" | "latest-frame-vlm";
  frameId: number;
  observedAt: number | null;
  frameAgeMs: number | null;
  confidence: number | null;
  evidence: string | null;
}

export interface VisionPlan {
  systemContext: string | null;
  summary: VisionAnalysisSummary | null;
  cancelled?: boolean;
  /** Gemma exceeded the interactive timeout — answer with a direct failure. */
  timeout?: boolean;
  /** Honest cache-grounded text to degrade to when the VLM cannot answer. */
  fallbackText?: string | null;
  /** Direct, grounded final answer (no reasoning-model hop) when available. */
  text?: string | null;
}

export type VisionPlanResult =
  | {
      kind: "direct";
      text: string;
      summary: VisionAnalysisSummary | null;
      grounding?: VisionGrounding | null;
    }
  | { kind: "cancelled" }
  | {
      kind: "direct-vlm";
      text: string;
      summary: VisionAnalysisSummary | null;
      grounding?: VisionGrounding | null;
    }
  | { kind: "llm"; plan: VisionPlan };

export interface VisionPlanInput {
  prompt: string;
  depth: VisionDepth;
  visionState: "off" | "live" | "no-frame";
  frames: VisionFrameInput[];
  model: PipelineModel;
  signal?: AbortSignal;
  /** Detected user language — localizes the direct refusals. */
  language: SpokenLanguage;
  /** Trace id for the debug logs. */
  requestId?: string;
}

/**
 * Runs one model call under the interactive budget. The timeout now aborts a
 * REAL AbortController (previously `signal.abort()` was called on an
 * AbortSignal instance, which has no instance `abort()` — a silent no-op that
 * let a "bounded" Gemma call run for minutes). The caller's abort signal is
 * forwarded onto the controller so both the interactive timeout and the
 * request's own cancellation path work.
 *
 * Returns `{ ok: true, value }` on success, or `{ ok: false, error }` where
 * error is "timeout" | "cancelled" | a descriptive string.
 */
async function withInteractiveBound<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, VISION_INTERACTIVE_TIMEOUT_MS);
  try {
    const value = await run(controller.signal);
    clearTimeout(timeout);
    return { ok: true, value };
  } catch (error) {
    clearTimeout(timeout);
    if (timedOut) {
      return { ok: false, error: "timeout" };
    }
    if (signal?.aborted) {
      return { ok: false, error: "cancelled" };
    }
    return {
      ok: false,
      error: `vision request failed: [${toErrorPayload(error).code}] ${toErrorPayload(error).message}`,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Cancels the in-flight Gemma inference of a previous request when a new
 * vision request arrives, so stale analysis never blocks fresh work.
 */
async function analyzeNewestFrame(
  frame: VisionFrameInput,
  model: PipelineModel,
  signal?: AbortSignal
): Promise<{ analysis: VisionStructuredAnalysis | null; error: string | null }> {
  const startedAt = Date.now();
  const imageBytes = Math.round(frame.image.length * 0.75);
  const debugFrame = saveDebugFrame(frame.image, frame.mimeType);
  log.info("[Vision] frame sent to Gemma 3", {
    width: frame.width ?? null,
    height: frame.height ?? null,
    imageBytes,
    debugFrame,
  });
  const result = await withInteractiveBound(signal, (boundSignal) =>
    model.analyzeCameraFrame?.({
      imageBase64: frame.image,
      mimeType: frame.mimeType,
      prompt: VISION_STRUCTURED_PROMPT,
      signal: boundSignal,
      maxTokens: 384,
    }) ?? Promise.resolve(null)
  );
  if (!result.ok) {
    const error = result.error;
    if (error === "timeout") {
      log.warn("[Vision] Gemma analysis timed out", {
        timeoutMs: VISION_INTERACTIVE_TIMEOUT_MS,
        latencyMs: Date.now() - startedAt,
      });
      return { analysis: null, error: "timeout" };
    }
    if (error === "cancelled") {
      log.info("[Vision] analysis cancelled (stale or aborted)", {
        latencyMs: Date.now() - startedAt,
      });
      return { analysis: null, error: "cancelled" };
    }
    log.error("[Vision] request to Gemma 3 errored", {
      message: error,
      latencyMs: Date.now() - startedAt,
    });
    return { analysis: null, error };
  }
  const raw = result.value;
  if (!raw) {
    const error = "No vision model is configured — cannot analyze the camera frame.";
    log.error("[Vision] analysis failed — no vision model", { error });
    return { analysis: null, error };
  }
  log.info("[Vision] Gemma 3 raw response", {
    chars: raw.length,
    latencyMs: Date.now() - startedAt,
  });
  const analysis = parseVisionAnalysis(raw);
  if (analysis) {
    log.info("[Vision] structured JSON created", {
      objects: analysis.visible_objects.length,
      personConfidence: analysis.person.confidence,
      latencyMs: Date.now() - startedAt,
    });
    return { analysis, error: null };
  }
  const error = `Gemma 3 response could not be parsed as structured JSON (received ${raw.length} chars).`;
  log.error("[Vision] structured JSON could not be created", {
    raw,
    latencyMs: Date.now() - startedAt,
  });
  return { analysis: null, error };
}

/**
 * One bounded, focused VLM call for a simple attribute gap (holding / wearing).
 * A tiny prompt means a tiny answer — the final text is derived directly from
 * the VLM result, so the reasoning model is never invoked after it.
 *
 * For "what am I holding?" the VLM inspects the hand-region CROP of the newest
 * frame (never the whole scene) and is told exactly which objects the detector
 * observed there. Its answer is then cross-checked against that same detector
 * evidence: a label the detector never saw in the hand region is rejected and
 * falls back to the honest "can't identify" text.
 */
async function analyzeFocusedFrame(
  frame: VisionFrameInput,
  model: PipelineModel,
  signal: AbortSignal | undefined,
  focus: "holding" | "wearing",
  vlmContext?: { heldCrop?: string | null; evidence?: HeldObjectEvidence | null }
): Promise<{ result: FocusedVisionResult | null; error: string | null }> {
  const startedAt = Date.now();
  const evidence = vlmContext?.evidence ?? null;
  const useCrop = focus === "holding" && !!vlmContext?.heldCrop;
  const imageBase64 = useCrop
    ? stripDataUrlPrefix(vlmContext!.heldCrop!)
    : frame.image;
  const prompt =
    focus === "holding" ? buildFocusedHoldingPrompt(evidence) : VISION_WEARING_PROMPT;
  const debugFrame = saveDebugFrame(imageBase64, frame.mimeType);
  log.info("[Vision] focused frame sent to Gemma 3", {
    focus,
    width: frame.width ?? null,
    height: frame.height ?? null,
    crop: useCrop,
    evidence: evidence && evidence.labels.size > 0 ? [...evidence.labels] : null,
    debugFrame,
  });
  const result = await withInteractiveBound(signal, (boundSignal) =>
    model.analyzeCameraFrame?.({
      imageBase64,
      mimeType: frame.mimeType,
      prompt,
      signal: boundSignal,
      maxTokens: 96,
    }) ?? Promise.resolve(null)
  );
  if (!result.ok) {
    if (result.error === "timeout") {
      log.warn("[Vision] focused Gemma analysis timed out", {
        focus,
        timeoutMs: VISION_INTERACTIVE_TIMEOUT_MS,
        latencyMs: Date.now() - startedAt,
      });
      return { result: null, error: "timeout" };
    }
    if (result.error === "cancelled") {
      log.info("[Vision] focused analysis cancelled (stale or aborted)", {
        focus,
        latencyMs: Date.now() - startedAt,
      });
      return { result: null, error: "cancelled" };
    }
    log.error("[Vision] focused request to Gemma 3 errored", {
      focus,
      message: result.error,
      latencyMs: Date.now() - startedAt,
    });
    return { result: null, error: result.error };
  }
  const raw = result.value;
  if (!raw) {
    return { result: null, error: "No vision model is configured." };
  }
  log.info("[Vision] focused Gemma 3 raw response", {
    focus,
    chars: raw.length,
    latencyMs: Date.now() - startedAt,
  });
  let parsed = focus === "holding" ? parseFocusedVisionAnalysis(raw, "held") : parseWearingVisionAnalysis(raw);
  if (!parsed) {
    return {
      result: null,
      error: `Focused Gemma 3 response could not be parsed (received ${raw.length} chars).`,
    };
  }
  // Grounding verdict for holding: the VLM may only name an object the detector
  // observed in the hand region of this exact frame (detector tier), OR — when
  // the detector has no hand-region evidence at all — a certain, specific,
  // plausible off-vocabulary object (pen, keys, earbuds) on the lower-confidence
  // vlm-only tier, which the answer layer reports with an explicit hedge. A
  // confident-but-ungrounded COCO label ("notebook" that was never detected) is
  // rejected -> honest fallback.
  if (focus === "holding") {
    const verdict = groundHeldVlmTiered(parsed.value, parsed.certain, parsed.reasoning, evidence);
    log.info("[VisionProof] holding grounding verdict", {
      vlmValue: parsed.value,
      canonical: verdict.canonical,
      accepted: verdict.accepted,
      tier: verdict.tier,
      reason: verdict.reason,
      evidence: evidence && evidence.labels.size > 0 ? [...evidence.labels] : null,
      evidenceConfidence:
        evidence?.labelConfidence && evidence.labelConfidence.size > 0
          ? Object.fromEntries(evidence.labelConfidence)
          : null,
      hasPerson: evidence?.hasPerson ?? null,
    });
    if (!verdict.accepted) {
      parsed = {
        value: null,
        certain: false,
        reasoning: verdict.canonical
          ? `The detector did not observe "${verdict.canonical}" in the hand region of this frame.`
          : "The detector observed nothing in the hand region of this frame.",
      };
    } else {
      parsed = { ...parsed, tier: verdict.tier };
    }
  }
  return { result: parsed, error: null };
}

/**
 * Runs one Gemma analysis of the newest frame under the manager-owned
 * cancellation slot (`beginVisionAnalysis`), then caches the grounded plan for
 * reuse by near-identical frames. The cached entry is bound to the current
 * camera session and analyzed frame id so it can never serve a stale answer.
 */
async function analyzeAndCachePlan(
  frame: VisionFrameInput,
  model: PipelineModel,
  signal: AbortSignal | undefined,
  cameraSessionId: string | null,
  frameId: number,
  focus?: "holding" | "wearing",
  fallbackText?: string | null,
  vlmContext?: { heldCrop?: string | null; evidence?: HeldObjectEvidence | null }
): Promise<VisionPlan> {
  const wf = getCurrentWaterfall();
  wf?.count("gemmaCalls");
  wf?.mark("gemma");
  const run = beginVisionAnalysis(signal);
  try {
    // Focused attribute gap: tiny prompt, direct text, still cached (with
    // text) so a follow-up on the same frame never re-hits the VLM.
    if (focus) {
      const focused = await analyzeFocusedFrame(frame, model, run.signal, focus, vlmContext);
      if (!focused.result) {
        if (focused.error === "timeout") {
          return {
            systemContext: null,
            summary: null,
            cancelled: true,
            timeout: true,
            fallbackText,
          };
        }
        if (focused.error === "cancelled") {
          return { systemContext: null, summary: null, cancelled: true };
        }
        return {
          systemContext: null,
          summary: null,
          fallbackText,
        };
      }
      const directText =
        focus === "holding"
          ? focused.result.certain && focused.result.value
            ? focused.result.tier === "vlm-only"
              ? `It looks like you're holding ${article(focused.result.value)} — I can't fully confirm that with my object detector, but that's what I can see.`
              : `You're holding ${article(focused.result.value)}.`
            : (fallbackText ?? "I can't identify the object clearly from the current frame.")
          : focused.result.certain && focused.result.value
            ? `You're wearing a ${focused.result.value} ${focused.result.garmentType ?? "top"}.`
            : (fallbackText ?? "I can see you, but I can't make out what you're wearing clearly yet.");
      const summary = summarizeVisionAnalysis(null, {
        state: "live",
        source: frame.source,
        capturedAt: frame.capturedAt,
      });
      // Detector-grounded answers land in the high band; a vlm-only (hedged)
      // answer stays below CONFIDENCE_MID so the reported confidence matches the
      // uncertainty in the text.
      const certainConfidence = focused.result.tier === "vlm-only" ? CONFIDENCE_MID - 10 : 75;
      const cachedSummary = {
        ...summary,
        confidence: focused.result.certain ? Math.max(summary.confidence ?? 0, certainConfidence) : summary.confidence,
      };
      const systemContext = `The last camera analysis is focused on what the user is ${focus === "holding" ? "holding" : "wearing"}.\n${focused.result.reasoning}`;
      cacheVisionResult({
        summary: cachedSummary,
        analysis: null,
        systemContext,
        text: directText,
        source: frame.source ?? "webcam",
        capturedAt: frame.capturedAt ?? Date.now(),
        analyzedAt: Date.now(),
        cameraSessionId,
        frameId,
      });
      // Cache the VLM result on the person state so subsequent "what am I
      // wearing?" calls answer instantly from the cache without re-escalating.
      if (focus === "wearing") {
        const store = getVisionStateStore();
        const people = store.getState().latestPeople;
        const person = people[0];
        if (person) {
          const shirtColor = focused.result.value
            ? store.getState().latestColors[`person-${person.trackingId}-shirt`] ?? person.shirtColor
            : person.shirtColor;
          store.setGarmentType(person.trackingId, focused.result.garmentType ?? null);
          // Also persist the shirt colour from the VLM if it wasn't already cached.
          if (focused.result.value && !person.shirtColor) {
            store.update({
              objects: Object.values(store.getState().latestObjects),
              people: [{ ...person, shirtColor: shirtColor ?? undefined }],
              colors: store.getState().latestColors,
              frameId: store.getState().frameId,
              cameraSessionId: store.getState().cameraSessionId,
            });
          }
        }
      }
      return { systemContext, summary: cachedSummary, text: directText };
    }
    const result = await analyzeNewestFrame(frame, model, run.signal);
    if (!result.analysis) {
      if (result.error === "timeout") {
        return {
          systemContext: null,
          summary: null,
          cancelled: true,
          timeout: true,
          fallbackText,
        };
      }
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
        fallbackText,
      };
    }
    const systemContext = buildVisionSystemContext(result.analysis);
    const summary = summarizeVisionAnalysis(result.analysis, {
      state: "live",
      source: frame.source,
      capturedAt: frame.capturedAt,
    });
    cacheVisionResult({
      summary,
      analysis: result.analysis,
      systemContext,
      source: frame.source ?? "webcam",
      capturedAt: frame.capturedAt ?? Date.now(),
      analyzedAt: Date.now(),
      cameraSessionId,
      frameId,
    });
    return { systemContext, summary };
  } finally {
    wf?.end("gemma");
    run.done();
  }
}

/** Minimal indefinite-article helper for grounded direct answers. Plural
 *  everyday objects ("keys", "earbuds", "glasses") take no article. */
function article(noun: string): string {
  const trimmed = noun.trim();
  if (/s$/i.test(trimmed) && trimmed.length > 2) return trimmed;
  return /^[aeiou]/i.test(trimmed) ? `an ${trimmed}` : `a ${trimmed}`;
}

/**
 * Enforce the <70% follow-up contract on Gemma-grounded answers: when the
 * overall vision confidence is below CONFIDENCE_MID the LLM is instructed to
 * hedge and invite repositioning instead of asserting details.
 */
function withConfidenceHedge(plan: VisionPlan): VisionPlan {
  const confidence = plan.summary?.confidence;
  if (
    confidence === null ||
    confidence === undefined ||
    confidence >= CONFIDENCE_MID
  ) {
    return plan;
  }
  if (!plan.systemContext) return plan;
  const hedge = `\n\nOverall vision confidence is low (${confidence}%, below ${CONFIDENCE_MID}%). If the user asked about anything currently visible, answer with a clear uncertainty hedge and invite them to reposition the camera or move closer — never assert visual details you are not sure about.`;
  return { ...plan, systemContext: `${plan.systemContext}${hedge}` };
}

/**
 * Route one visual question to a ready-to-use plan. Returns a direct refusal /
 * cache answer, a cancellation, or an LLM plan whose system context is
 * grounded in a Gemma analysis of the current frame.
 */
export async function resolveVisionPlan(
  input: VisionPlanInput
): Promise<VisionPlanResult> {
  const { prompt, depth, visionState, frames, model, signal, language, requestId } = input;
  const startedAt = Date.now();
  getCurrentWaterfall()?.count("visionCalls");
  log.info("[VisionRequest]", {
    requestId,
    depth,
    visionState,
    frames: frames.length,
    prompt: prompt.slice(0, 120),
  });
  const resolution = await resolveVisualQuestion({
    prompt,
    depth,
    visionState,
    frames,
  });
  const trace = { requestId, latencyMs: Date.now() - startedAt };
  const logFinal = (source: string, answer: string | null, confidence: number | null): void => {
    log.info("[Final]", {
      requestId,
      source,
      answer: answer ? answer.slice(0, 120) : null,
      confidence,
      latencyMs: Date.now() - startedAt,
    });
  };
  switch (resolution.kind) {
    case "cached":
    case "no-camera":
    case "no-frame":
    case "warming": {
      let text = resolution.text;
      if (language !== "english") {
        if (resolution.kind === "no-camera") {
          text = localizeReply(language, "noCamera");
        } else if (resolution.kind === "no-frame") {
          text = localizeReply(language, "noFrame");
        } else if (resolution.kind === "warming") {
          text = localizeReply(language, "visionWarming");
        }
      }
      log.info("[VisionResult]", {
        ...trace,
        source: resolution.kind,
        kind: "direct",
        text: text.slice(0, 80),
      });
      logFinal(resolution.kind, text, resolution.meta.confidence);
      return {
        kind: "direct",
        text,
        summary: resolution.summary,
        grounding:
          resolution.kind === "cached"
            ? {
                source: "scene-cache",
                frameId: resolution.meta.frameId,
                observedAt: resolution.meta.observedAt ?? null,
                frameAgeMs: resolution.meta.frameAgeMs ?? null,
                confidence: resolution.meta.confidence ?? null,
                evidence: resolution.meta.evidence ?? null,
              }
            : null,
      };
    }
    case "gemma": {
      const newest = resolution.frame;
      const meta = resolution.meta;
      const grounding: VisionGrounding = {
        source: "latest-frame-vlm",
        frameId: meta.frameId,
        observedAt: newest.capturedAt ?? null,
        frameAgeMs: meta.frameAgeMs ?? null,
        confidence: meta.confidence ?? null,
        evidence: meta.evidence ?? null,
      };
      const focus = resolution.focus;
      const fallbackText = resolution.fallbackText ?? null;
      const vlmContext =
        focus === "holding" &&
        (resolution.heldCrop !== undefined || resolution.evidence !== undefined)
          ? { heldCrop: resolution.heldCrop ?? null, evidence: resolution.evidence ?? null }
          : undefined;
      const cached =
        focus !== undefined
          ? undefined
          : cachedVisionPlan(newest.source, newest, meta.cameraSessionId);
      if (cached) {
        log.info("[VisionResult]", {
          ...trace,
          kind: "cached-plan",
          source: "vision-cache",
          text: cached.text ? cached.text.slice(0, 80) : undefined,
        });
        if (cached.text) {
          return {
            kind: "direct-vlm",
            text: cached.text,
            summary: cached.summary,
            grounding,
          };
        }
        return { kind: "llm", plan: withConfidenceHedge(cached) };
      }
      const plan = await analyzeAndCachePlan(
        newest,
        model,
        signal,
        meta.cameraSessionId,
        meta.frameId,
        focus,
        fallbackText,
        vlmContext
      );
      if (plan.timeout) {
        const text =
          fallbackText ??
          (language === "english"
            ? "I couldn't analyze the visual quickly enough — try again or ask something simpler."
            : localizeReply(language, "visionFailed"));
        log.warn("[VisionResult]", {
          ...trace,
          kind: "timeout",
          fallback: text.slice(0, 80),
        });
        logFinal("timeout", text, null);
        return { kind: "direct", text, summary: null, grounding };
      }
      if (plan.cancelled) return { kind: "cancelled" };
      log.info("[VLM]", {
        requestId,
        invoked: focus ? "focused-vlm" : "full-vlm",
        inputFrameId: meta.frameId,
        capturedAt: newest.capturedAt ?? null,
        latencyMs: Date.now() - startedAt,
      });
      log.info("[VisionProof]", {
        requestId,
        kind: focus ? "focused-vlm" : "full-vlm",
        frameId: meta.frameId,
        observedAt: newest.capturedAt ?? null,
        frameAgeMs: meta.frameAgeMs ?? null,
        vlmInput: focus === "holding" && vlmContext?.heldCrop ? "hand-region-crop" : "full-frame",
        evidence: vlmContext?.evidence && vlmContext.evidence.labels.size > 0
          ? [...vlmContext.evidence.labels]
          : null,
        evidenceConfidence:
          vlmContext?.evidence?.labelConfidence && vlmContext.evidence.labelConfidence.size > 0
            ? Object.fromEntries(vlmContext.evidence.labelConfidence)
            : null,
        finalText: plan.text ?? null,
        fallbackText: fallbackText ?? null,
      });
      log.info("[VisionResult]", {
        ...trace,
        kind: focus ? "focused-vlm" : "full-vlm",
        source: "latest-frame-vlm",
        text: plan.text ? plan.text.slice(0, 80) : undefined,
      });
      if (plan.text) {
        logFinal("latest-frame-vlm", plan.text, meta.confidence ?? null);
        return {
          kind: "direct-vlm",
          text: plan.text,
          summary: plan.summary,
          grounding,
        };
      }
      logFinal("latest-frame-vlm", null, meta.confidence ?? null);
      return { kind: "llm", plan: withConfidenceHedge(plan) };
    }
  }
}
