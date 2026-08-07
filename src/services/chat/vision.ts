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
  buildVisionErrorContext,
  buildVisionSystemContext,
  parseVisionAnalysis,
  summarizeVisionAnalysis,
  type VisionAnalysisSummary,
  type VisionStructuredAnalysis,
} from "@/lib/ai/prompts";
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
import type { PipelineModel } from "./pipeline";

const log = aiLogger.child("vision-resolution");

export interface VisionPlan {
  systemContext: string | null;
  summary: VisionAnalysisSummary | null;
  cancelled?: boolean;
}

export type VisionPlanResult =
  | { kind: "direct"; text: string; summary: VisionAnalysisSummary | null }
  | { kind: "cancelled" }
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
  log.info("Frame sent to Gemma 3", {
    width: frame.width ?? null,
    height: frame.height ?? null,
    imageBytes,
    debugFrame,
  });
  try {
    const raw = await model.analyzeCameraFrame?.({
      imageBase64: frame.image,
      mimeType: frame.mimeType,
      prompt: VISION_STRUCTURED_PROMPT,
      signal,
    });
    if (!raw) {
      const error =
        "No vision model is configured — cannot analyze the camera frame.";
      log.error("Vision analysis failed — no vision model", { error });
      return { analysis: null, error };
    }
    log.info("Gemma 3 raw response", {
      chars: raw.length,
      latencyMs: Date.now() - startedAt,
    });
    const analysis = parseVisionAnalysis(raw);
    if (analysis) {
      log.info("Structured JSON created", {
        objects: analysis.visible_objects.length,
        personConfidence: analysis.person.confidence,
        latencyMs: Date.now() - startedAt,
      });
      return { analysis, error: null };
    }
    const error = `Gemma 3 response could not be parsed as structured JSON (received ${raw.length} chars).`;
    log.error("Vision pipeline failed — structured JSON could not be created", {
      raw,
      latencyMs: Date.now() - startedAt,
    });
    return { analysis: null, error };
  } catch (error) {
    const payload = toErrorPayload(error);
    if (signal?.aborted) {
      log.info("Vision analysis cancelled (stale or aborted)", {
        latencyMs: Date.now() - startedAt,
      });
      return { analysis: null, error: "cancelled" };
    }
    const detail = `Gemma 3 frame analysis failed: [${payload.code}] ${payload.message}`;
    log.error("Vision pipeline failed — request to Gemma 3 errored", {
      code: payload.code,
      message: payload.message,
      latencyMs: Date.now() - startedAt,
    });
    return { analysis: null, error: detail };
  }
}

/**
 * Runs one Gemma analysis of the newest frame under the manager-owned
 * cancellation slot (`beginVisionAnalysis`), then caches the grounded plan for
 * reuse by near-identical frames.
 */
async function analyzeAndCachePlan(
  frame: VisionFrameInput,
  model: PipelineModel,
  signal?: AbortSignal
): Promise<VisionPlan> {
  const wf = getCurrentWaterfall();
  wf?.count("gemmaCalls");
  wf?.mark("gemma");
  const run = beginVisionAnalysis(signal);
  try {
    const result = await analyzeNewestFrame(frame, model, run.signal);
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
    cacheVisionResult({
      summary,
      analysis: result.analysis,
      systemContext,
      source: frame.source ?? "webcam",
      capturedAt: frame.capturedAt ?? Date.now(),
      analyzedAt: Date.now(),
    });
    return { systemContext, summary };
  } finally {
    wf?.end("gemma");
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
  const { prompt, depth, visionState, frames, model, signal, language } = input;
  getCurrentWaterfall()?.count("visionCalls");
  const resolution = await resolveVisualQuestion({
    prompt,
    depth,
    visionState,
    frames,
  });
  switch (resolution.kind) {
    case "cached":
    case "no-camera":
    case "no-frame": {
      let text = resolution.text;
      if (language !== "english") {
        if (resolution.kind === "no-camera") {
          text = localizeReply(language, "noCamera");
        } else if (resolution.kind === "no-frame") {
          text = localizeReply(language, "noFrame");
        }
      }
      return {
        kind: "direct",
        text,
        summary: resolution.summary,
      };
    }
    case "gemma": {
      const newest = resolution.frame;
      const cached = cachedVisionPlan(newest.source, newest);
      if (cached) {
        return { kind: "llm", plan: withConfidenceHedge(cached) };
      }
      const plan = await analyzeAndCachePlan(newest, model, signal);
      if (plan.cancelled) return { kind: "cancelled" };
      return { kind: "llm", plan: withConfidenceHedge(plan) };
    }
  }
}
