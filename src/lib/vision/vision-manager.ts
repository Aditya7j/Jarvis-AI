import { aiLogger } from "@/lib/ai/logger";
import {
  summarizeVisionAnalysis,
  type VisionAnalysisSummary,
} from "@/lib/ai/prompts";
import type { VisionDepth } from "@/lib/ai/vision-intent";
import { getCurrentWaterfall } from "@/lib/metrics/waterfall";
import {
  currentCameraSessionId,
  LIVE_VISION_STALE_MS,
  visionReady,
} from "./live-vision-engine";
import { answerFromVisionCache } from "./vision-answer";
import { visionCache, type CachedVisionResult } from "./vision-cache";
import { getVisionStateStore } from "./vision-state";

/**
 * Vision Manager — the single gateway for EVERY visual question.
 *
 * Routing contract (enforced here, not via prompt patches):
 *   - Qwen (or any reasoning model) NEVER answers questions about camera
 *     content directly. The only way the chat path may call Qwen for a visual
 *     question is with a grounded Gemma analysis in the system context.
 *   - Simple visual questions are answered straight from the Scene Cache
 *     (written continuously by the live YOLO engine) when the cache belongs to
 *     the CURRENT camera session. No Gemma, no Qwen, no inline YOLO, no
 *     blocking wait on the camera — the Scene Cache is the only source of truth.
 *   - Complex / OCR questions and cache gaps (e.g. clothing colour not
 *     established by YOLO) go to Gemma Vision with the NEWEST frame only.
 *   - No camera => direct refusal. Camera on but no frame yet => warming reply.
 *   - Closing the camera (or opening a new one) rotates the camera session id,
 *     which invalidates every cached answer and every scene-cache entry from the
 *     previous session.
 *
 * Every decision is logged via the `vision-routing` log entry with request
 * type, cache hit/miss, cache age, whether Gemma/Qwen were invoked, and total
 * latency.
 */

/** Maximum Scene Cache age (ms) for a direct cache answer. */
export const VISION_CACHE_FRESH_MS = 1000;
export { CONFIDENCE_HIGH, CONFIDENCE_LOW } from "./confidence";

export const NO_CAMERA_TEXT =
  "I can't see your camera feed — no camera or screen source is connected. Turn one on and ask me again.";
export const NO_FRAME_TEXT =
  "I don't have a frame to look at right now — your camera is on but no video is coming through. Give it a moment and try again.";
export const WARMING_UP_TEXT =
  "I just started looking — give me a second for the camera feed to come through, then ask me again.";
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
  yoloInvoked: boolean;
  cameraSessionId: string | null;
  frameId: number;
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
    }
  | {
      kind: "warming";
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

/** Age of the newest analyzed frame in ms. Infinity when none is present. */
function cacheAgeMs(): number {
  return getVisionStateStore().getAgeMs();
}

/**
 * Compact summary of the Scene Cache for the UI `vision` SSE event. Only built
 * when the cache belongs to the current camera session.
 */
export function buildCacheSummary(): VisionAnalysisSummary | null {
  const state = getVisionStateStore().getState();
  if (state.timestamp === 0) return null;
  if (state.cameraSessionId !== currentCameraSessionId()) return null;
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
 * direct, grounded answer (Scene Cache / refusal / warming) or a directive to
 * invoke Gemma Vision on a single specific frame.
 *
 * This function NEVER waits on the camera, never runs YOLO, and never calls any
 * LLM by itself — simple questions are served from the continuously-updated
 * Scene Cache (kept fresh by the background engine), so a question arriving
 * while the camera is opening or during heavy YOLO load still returns fast.
 */
export async function resolveVisualQuestion(
  input: VisionManagerInput
): Promise<VisionResolution> {
  const { prompt, depth, visionState, frames } = input;
  const startedAt = performance.now();
  const wf = getCurrentWaterfall();
  wf?.mark("vision_cache_lookup");
  const requestType = classifyRequestType(prompt, depth);
  const sessionId = currentCameraSessionId();
  const state = getVisionStateStore().getState();
  const age = cacheAgeMs();
  const sceneBelongsToSession = state.cameraSessionId === sessionId;
  const sceneUsable = sceneBelongsToSession && state.frameId > 0;
  const cacheHit = age <= VISION_CACHE_FRESH_MS;
  const newestClient =
    [...frames].sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))[0] ??
    null;

  if (visionState === "off") {
    wf?.end("vision_cache_lookup");
    log.info("[Vision] no camera", {
      requestType,
      depth,
      latencyMs: performance.now() - startedAt,
    });
    return {
      kind: "no-camera",
      text: NO_CAMERA_TEXT,
      summary: summarizeVisionAnalysis(null, { state: "off" }),
      meta: {
        requestType,
        cacheHit: false,
        cacheAgeMs: age,
        gemmaInvoked: false,
        yoloInvoked: false,
        cameraSessionId: sessionId,
        frameId: 0,
      },
    };
  }

  // Simple questions: Scene Cache only. Never Gemma for detections, never a
  // blocking YOLO refresh — the background engine already keeps this fresh.
  // The scene is the single source of truth and is only trusted when it belongs
  // to the current camera session.
  if (depth === "simple") {
    if (!sceneUsable) {
      wf?.end("vision_cache_lookup");
      log.info("[Vision] warming up (no frame for current session yet)", {
        requestType,
        depth,
        sessionId,
        sceneBelongsToSession,
        latencyMs: performance.now() - startedAt,
      });
      return {
        kind: "warming",
        text: WARMING_UP_TEXT,
        summary: summarizeVisionAnalysis(null, { state: "no-frame" }),
        meta: {
          requestType,
          cacheHit: false,
          cacheAgeMs: age,
          gemmaInvoked: false,
          yoloInvoked: false,
          cameraSessionId: sessionId,
          frameId: state.frameId,
        },
      };
    }
    const answer = answerFromVisionCache(prompt);
    if (!answer.needsGemma) {
      wf?.end("vision_cache_lookup");
      log.info("[Vision] answered from Scene Cache", {
        requestType,
        depth,
        cacheAgeMs: age,
        frameId: state.frameId,
        sessionId,
        latencyMs: performance.now() - startedAt,
        text: answer.text.slice(0, 80),
      });
      return {
        kind: "cached",
        text: answer.text,
        confidence: answer.confidence,
        cacheAgeMs: age,
        summary: buildCacheSummary(),
        meta: {
          requestType,
          cacheHit: age <= VISION_CACHE_FRESH_MS,
          cacheAgeMs: age,
          gemmaInvoked: false,
          yoloInvoked: false,
          cameraSessionId: sessionId,
          frameId: state.frameId,
        },
      };
    }
    // Attribute gap (e.g. shirt colour not established by YOLO): fall through
    // to Gemma with the newest frame — clothing/colour is a legitimate Gemma
    // task, and Gemma never runs for plain detections.
  }

  // Cache insufficient (stale, complex, OCR, or an attribute gap): Gemma Vision
  // with the NEWEST frame only — the newest client frame, or the Scene Cache's
  // latest frame as fallback. The scene frame is only usable when it belongs to
  // the current session.
  const sceneFrame = sceneUsable ? state.latestFrame : null;
  const gemmaFrame: VisionFrameInput | null = newestClient
    ? newestClient
    : sceneFrame
      ? {
          image: stripDataUrlPrefix(sceneFrame.buffer),
          mimeType: "image/jpeg",
          source: undefined,
          width: sceneFrame.width,
          height: sceneFrame.height,
          capturedAt: sceneFrame.capturedAt,
        }
      : null;

  if (!gemmaFrame) {
    wf?.end("vision_cache_lookup");
    log.info("[Vision] warming up (no frame available for current session)", {
      requestType,
      depth,
      cacheAgeMs: age,
      sessionId,
      latencyMs: performance.now() - startedAt,
    });
    return {
      kind: "warming",
      text: WARMING_UP_TEXT,
      summary: summarizeVisionAnalysis(null, { state: "no-frame" }),
      meta: {
        requestType,
        cacheHit: false,
        cacheAgeMs: age,
        gemmaInvoked: false,
        yoloInvoked: false,
        cameraSessionId: sessionId,
        frameId: state.frameId,
      },
    };
  }

  log.info("[Vision] sending newest frame to Gemma", {
    requestType,
    depth,
    cacheAgeMs: age,
    frameId: state.frameId,
    sessionId,
    source: newestClient ? "client" : "scene-cache",
    capturedAt: gemmaFrame.capturedAt,
  });
  wf?.end("vision_cache_lookup");
  return {
    kind: "gemma",
    frame: gemmaFrame,
    cacheAgeMs: age,
    meta: {
      requestType,
      cacheHit,
      cacheAgeMs: age,
      gemmaInvoked: true,
      yoloInvoked: false,
      cameraSessionId: sessionId,
      frameId: state.frameId,
    },
  };
}

/**
 * Gemma analysis cache — the single authority for reuse rules. The chat layer
 * runs the analysis; this manager owns the freshness decisions (1s stale,
 * 250 ms frame skew) and the stale-analysis cancellation so every vision path
 * shares one set of rules. Entries are bound to the camera session that
 * produced them: a closed/reopened camera gets a new session id, so its
 * answers can never be reused.
 */

export const VISION_CACHE_STALE_MS = LIVE_VISION_STALE_MS;
export const VISION_CACHE_FRAME_SKEW_MS = 250;

export interface CachedVisionPlan {
  systemContext: string;
  summary: VisionAnalysisSummary;
}

let activeVisionController: AbortController | null = null;

function cancelActiveVision(): void {
  if (activeVisionController) {
    activeVisionController.abort();
    activeVisionController = null;
  }
}

/**
 * Aborts any previous request's Gemma inference and returns an AbortSignal
 * for this one. `done()` unlinks the caller's abort signal and clears the
 * module slot so a stale request cannot cancel a newer one.
 */
export function beginVisionAnalysis(signal?: AbortSignal): {
  signal: AbortSignal;
  done: () => void;
} {
  cancelActiveVision();
  const controller = new AbortController();
  activeVisionController = controller;
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      signal?.removeEventListener("abort", onAbort);
      if (activeVisionController === controller) {
        activeVisionController = null;
      }
    },
  };
}

/**
 * The cached analysis may only be reused when the frame it was built from is
 * still the current one AND belongs to the current camera session. If the
 * request carries a NEWER frame (capturedAt ahead of the cached frame by more
 * than the skew window) the scene may have changed, so the cache is skipped
 * and the new frame is re-analyzed. This is what prevents "fresh frame
 * capture, stale answer" and "answer from a closed camera".
 */
export function cachedVisionPlan(
  source: VisionFrameInput["source"],
  newest?: VisionFrameInput,
  cameraSessionId?: string | null
): CachedVisionPlan | null {
  const cached = visionCache.get(source, cameraSessionId);
  if (!cached) return null;
  if (Date.now() - cached.capturedAt > VISION_CACHE_STALE_MS) {
    log.info("Vision cache entry is stale (frame older than 1s); re-analyzing", {
      ageMs: Date.now() - cached.capturedAt,
    });
    return null;
  }
  if (
    newest?.capturedAt &&
    newest.capturedAt - cached.capturedAt > VISION_CACHE_FRAME_SKEW_MS
  ) {
    log.info("Vision cache entry is from an older frame; re-analyzing", {
      cachedAt: cached.capturedAt,
      frameAt: newest.capturedAt,
      skewMs: newest.capturedAt - cached.capturedAt,
    });
    return null;
  }
  log.info("Vision result reused from cache", {
    ageMs: Date.now() - cached.analyzedAt,
    summary: cached.summary,
  });
  return { systemContext: cached.systemContext, summary: cached.summary };
}

export function cacheVisionResult(result: CachedVisionResult): void {
  visionCache.set(result);
}

/** Whether the vision pipeline has a live, session-matched scene available. */
export function isVisionReady(): boolean {
  return visionReady();
}
