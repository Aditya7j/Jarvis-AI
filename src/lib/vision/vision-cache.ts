import type {
  VisionAnalysisSummary,
  VisionStructuredAnalysis,
} from "@/lib/ai/prompts";

/**
 * Reuse the latest analyzed frame for VISION_CACHE_TTL_MS instead of
 * re-running Gemma 3 on near-identical frames.
 *
 * Every entry is bound to the camera session that produced it. Closing the
 * camera (or starting a new one) assigns a fresh session id, so stale answers
 * from a previous session can never be served to the new one.
 *
 * Next.js App Router compiles each route handler into its own bundle, so
 * module-scoped singletons are NOT shared between `/api/chat`, `/api/vision/live`
 * and the Fastify server. The cache lives on `globalThis` (shared per process)
 * so every consumer reads/writes the same entry.
 */

export const VISION_CACHE_TTL_MS = 2500;

export interface CachedVisionResult {
  summary: VisionAnalysisSummary;
  analysis: VisionStructuredAnalysis;
  systemContext: string;
  source: "webcam" | "screen";
  capturedAt: number;
  analyzedAt: number;
  /** Owning camera session. Entries from another session are never reused. */
  cameraSessionId: string | null;
  /** Monotonic frame id this analysis was produced from. */
  frameId: number;
}

const STORE_KEY = "__jarvis_vision_cache__";

interface VisionCacheStore {
  entry: CachedVisionResult | null;
}

function getStore(): VisionCacheStore {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[STORE_KEY] as VisionCacheStore | undefined;
  if (existing && "entry" in existing) return existing;
  const store: VisionCacheStore = { entry: null };
  Object.defineProperty(g, STORE_KEY, {
    value: store,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

class VisionCache {
  /**
   * Returns the cached result only if it is fresh, matches the source, and was
   * produced by the given camera session (strict equality — a closed/reopened
   * camera gets a new session id, so its answers are invisible to this lookup).
   */
  get(
    source?: "webcam" | "screen",
    cameraSessionId?: string | null
  ): CachedVisionResult | null {
    const entry = getStore().entry;
    if (!entry) return null;
    if (source && entry.source !== source) return null;
    if (cameraSessionId !== undefined && entry.cameraSessionId !== cameraSessionId)
      return null;
    if (Date.now() - entry.analyzedAt > VISION_CACHE_TTL_MS) return null;
    return entry;
  }

  set(result: CachedVisionResult): void {
    getStore().entry = result;
  }

  clear(): void {
    getStore().entry = null;
  }
}

export const visionCache = new VisionCache();
