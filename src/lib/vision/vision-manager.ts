import { aiLogger } from "@/lib/ai/logger";
import {
  summarizeVisionAnalysis,
  type VisionAnalysisSummary,
} from "@/lib/ai/prompts";
import type { VisionDepth } from "@/lib/ai/vision-intent";
import { liveFrameKey, liveVisionEngine } from "./live-vision-engine";
import { answerFromVisionCache } from "./vision-answer";
import { getVisionStateStore } from "./vision-state";

/**
 * Vision Manager — the single gateway for EVERY visual question.
 *
 * Routing contract (enforced here, not via prompt patches):
 *   - Qwen (or any reasoning model) NEVER answers questions about camera
 *     content directly. The only way the chat path may call Qwen for a visual
 *     question is with a grounded Gemma analysis in the system context.
 *   - Simple visual questions are answered straight from the Scene Cache when
 *     the cache is fresh (< 300 ms) and detections are confident.
 *   - Complex / OCR questions and cache misses go to Gemma Vision with the
 *     latest frame only.
 *   - No camera / no frame => the manager returns a direct refusal; no LLM is
 *     ever asked to "guess" what the camera sees.
 *
 * Every decision is logged via the `vision-routing` log entry with request
 * type, cache hit/miss, cache age, whether Gemma/Qwen were invoked, and total
 * latency.
 */

/** Maximum Scene Cache age (ms) for a direct cache answer. */
export const VISION_CACHE_FRESH_MS = 300;
export { CONFIDENCE_HIGH, CONFIDENCE_LOW } from "./confidence";

export const NO_CAMERA_TEXT =
  "I can't see your camera feed — no camera or screen source is connected. Turn one on and ask me again.";
export const NO_FRAME_TEXT =
  "I don't have a frame to look at right now — your camera is on but no video is coming through. Give it a moment and try again.";
export const UNCERTAIN_GEMMA_TEXT =
  "I can't make that out confidently right now — could you reposition the camera or move closer?";
export const LOW_CONFIDENCE_TEXT =
  "I can't see that clearly enough to answer — could you move into view or reposition the camera?";

export interface VisionFrameInput {
  image: string;
  mimeType: string;
  source?: "webcam" | "screen";
  width?: number;
  height?: number;
  capturedAt?: number;
}

export interface VisionManagerInput {
  prompt: string;
  depth: VisionDepth;
  visionState: "off" | "live" | "no-frame";
  frames: VisionFrameInput[];
}

export interface VisionRoutingMeta {
  requestType: "simple" | "complex" | "ocr";
  cacheHit: boolean;
  cacheAgeMs: number | null;
  gemmaInvoked: boolean;
}

export type VisionResolution =
  | {
      kind: "cached";
      text: string;
      confidence: number;
      cacheAgeMs: number;
      summary: VisionAnalysisSummary | null;
      meta: VisionRoutingMeta;
    }
  | {
      kind: "gemma";
      frame: VisionFrameInput;
      cacheAgeMs: number;
      meta: VisionRoutingMeta;
    }
  | {
      kind: "no-camera";
      text: string;
      summary: VisionAnalysisSummary;
      meta: VisionRoutingMeta;
    }
  | {
      kind: "no-frame";
      text: string;
      summary: VisionAnalysisSummary;
      meta: VisionRoutingMeta;
    };

const log = aiLogger.child("vision-manager");

function stripDataUrlPrefix(image: string): string {
  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");
    if (comma >= 0) return image.slice(comma + 1);
  }
  return image;
}

function classifyRequestType(prompt: string, depth: VisionDepth): "simple" | "complex" | "ocr" {
  if (depth === "complex") {
    if (/\b(read|reads|says?|text|sign|label|ocr|letter|word|spell)\b/i.test(prompt)) {
      return "ocr";
    }
    return "complex";
  }
  return "simple";
}

function cacheAgeMs(): number {
  const state = getVisionStateStore().getState();
  return state.timestamp > 0 ? Date.now() - state.timestamp : Infinity;
}

/** Compact summary of the Scene Cache for the UI `vision` SSE event. */
export function buildCacheSummary(): VisionAnalysisSummary | null {
  const state = getVisionStateStore().getState();
  if (state.timestamp === 0) return null;
  const personConfidence = state.latestPeople.reduce(
    (max, person) => Math.max(max, person.confidence),
    0
  );
  return {
    state: "live",
    capturedAt: state.timestamp,
    confidence:
      state.overallConfidence > 0
        ? Math.round(state.overallConfidence * 100)
        : null,
    objectCount: Object.keys(state.latestObjects).length,
    personConfidence: Math.round(personConfidence * 100),
    error: null,
  };
}

/**
 * Route one visual question through the Vision Manager. Returns either a
 * direct, grounded answer (cache / refusal) or a directive to invoke Gemma
 * Vision on a single specific frame.
 */
export async function resolveVisualQuestion(
  input: VisionManagerInput
): Promise<VisionResolution> {
  const { prompt, depth, visionState, frames } = input;
  const requestType = classifyRequestType(prompt, depth);

  if (visionState === "off") {
    return {
      kind: "no-camera",
      text: NO_CAMERA_TEXT,
      summary: summarizeVisionAnalysis(null, { state: "off" }),
      meta: { requestType, cacheHit: false, cacheAgeMs: null, gemmaInvoked: false },
    };
  }

  // Simple questions: refresh the Scene Cache from the newest client frame so a
  // fresh, confident cache can answer directly without any LLM. Frames that
  // were already analyzed (same capturedAt + size) are skipped, so repeated
  // questions never pay for a redundant YOLO pass.
  let age = cacheAgeMs();
  if (depth === "simple" && frames.length > 0) {
    const frame = frames[0];
    const key = liveFrameKey({
      image: frame.image,
      capturedAt: frame.capturedAt,
    });
    if (!liveVisionEngine.hasProcessedFrame(key)) {
      await liveVisionEngine.analyzeFrame({
        image: frame.image,
        mimeType: frame.mimeType,
        source: frame.source,
        width: frame.width,
        height: frame.height,
        capturedAt: frame.capturedAt,
      });
    }
    age = cacheAgeMs();
  }

  const state = getVisionStateStore().getState();
  const cacheHit = state.timestamp > 0 && age <= VISION_CACHE_FRESH_MS;

  if (depth === "simple" && cacheHit) {
    const answer = answerFromVisionCache(prompt);
    if (!answer.needsGemma) {
      return {
        kind: "cached",
        text: answer.text,
        confidence: answer.confidence,
        cacheAgeMs: age,
        summary: buildCacheSummary(),
        meta: { requestType, cacheHit: true, cacheAgeMs: age, gemmaInvoked: false },
      };
    }
  }

  // Cache insufficient (stale, complex, or OCR): Gemma Vision with the latest
  // frame only — the newest client frame, or the Scene Cache's latest frame.
  const latest = state.latestFrame;
  const gemmaFrame: VisionFrameInput | null = frames[0]
    ? frames[0]
    : latest
      ? {
          image: stripDataUrlPrefix(latest.buffer),
          mimeType: "image/jpeg",
          source: undefined,
          width: latest.width,
          height: latest.height,
          capturedAt: latest.capturedAt,
        }
      : null;

  if (!gemmaFrame) {
    return {
      kind: "no-frame",
      text: NO_FRAME_TEXT,
      summary: summarizeVisionAnalysis(null, { state: "no-frame" }),
      meta: { requestType, cacheHit: false, cacheAgeMs: age, gemmaInvoked: false },
    };
  }

  log.info("Gemma Vision selected (cache insufficient or complex/OCR)", {
    requestType,
    depth,
    cacheAgeMs: age,
    source: gemmaFrame.source ?? "scene-cache",
  });
  return {
    kind: "gemma",
    frame: gemmaFrame,
    cacheAgeMs: age,
    meta: { requestType, cacheHit, cacheAgeMs: age, gemmaInvoked: true },
  };
}
