import type {
  VisionAnalysisSummary,
  VisionStructuredAnalysis,
} from "@/lib/ai/prompts";

/**
 * Reuse the latest analyzed frame for VISION_CACHE_TTL_MS instead of
 * re-running Gemma 3 on near-identical frames.
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
  /** Returns the cached result only if it is fresh and matches the source. */
  get(source?: "webcam" | "screen"): CachedVisionResult | null {
    const entry = getStore().entry;
    if (!entry) return null;
    if (source && entry.source !== source) return null;
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
