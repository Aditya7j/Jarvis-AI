import sharp from "sharp";
import type { HeldCandidate } from "./hold-grounding";

/**
 * Lightweight, non-blocking camera-frame quality scoring + best-frame
 * selection for the vision pipeline.
 *
 * The chat path NEVER captures a fresh still at question time — the camera runs
 * continuously (live loop, ~150ms) and the server keeps a small rolling buffer
 * of the most recent ANALYZED frames. When a visual question needs the VLM, the
 * buffer is scored and the newest *sufficiently sharp* frame is chosen, so a
 * motion-blurred latest frame can never be fed to Gemma when a sharper recent
 * frame exists.
 *
 * Cost: one sharp resize to <=96px + a Laplacian variance over the grey image
 * (~1-3ms per analyzed frame, run inside the existing YOLO pipeline — never on
 * the request hot path).
 */

export interface FrameQualityScore {
  /** Variance of the 3x3 Laplacian on the downscaled grey frame (higher = sharper). */
  sharpness: number;
  /** Mean grey luminance, 0..255. */
  brightness: number;
  /** Informational composite 0..1 (selection uses relative sharpness, not this). */
  score: number;
  /** Whether the frame passed the absolute blur/brightness/validity gates. */
  usable: boolean;
  /** Human reason when unusable: "blurry" | "too-dark" | "too-bright" | ... */
  reason: string | null;
}

/** A recent analyzed frame retained in the engine's rolling buffer. */
export interface BufferedVisionFrame {
  frameId: number;
  capturedAt: number;
  /** JPEG data URL of the submitted frame (the pixels the detector analyzed). */
  image: string;
  width: number;
  height: number;
  quality: FrameQualityScore;
  /** Per-frame hand-region evidence so grounding always matches the selected frame. */
  heldCandidates: HeldCandidate[] | null;
  heldCrop: string | null;
  handRegion: { x: number; y: number; width: number; height: number } | null;
  hasPerson: boolean;
}

/** A frame older than this is stale and never selected for the VLM. */
export const QUALITY_MAX_AGE_MS = 2500;
/** Downsample target for the sharpness/brightness scan (max side). */
export const QUALITY_DOWNSAMPLE = 96;
/** Absolute brightness gates (mean grey). */
export const QUALITY_MIN_BRIGHTNESS = 18;
export const QUALITY_MAX_BRIGHTNESS = 240;
/** Absolute sharpness floor on the downscaled Laplacian variance. */
export const QUALITY_MIN_SHARPNESS = 0.15;
/**
 * A candidate is only "sufficiently sharp" when its sharpness is at least this
 * fraction of the sharpest fresh candidate — so a severely blurred newest frame
 * is skipped in favour of a recent sharp one, but a moderately sharp newest
 * frame still wins (prefer freshness, never sacrifice severe quality).
 */
export const QUALITY_RELATIVE_SHARPNESS_FLOOR = 0.5;

const CHANNELS = 3;

/**
 * Score an RGB frame. Downscales to <=96px, converts to grey and measures
 * brightness (mean) and sharpness (variance of the Laplacian). Returns an
 * unusable score for invalid input or decode failure so the caller always falls
 * back to the newest scene frame rather than throwing.
 */
export async function scoreFrameQuality(
  rgb: Buffer,
  width: number,
  height: number
): Promise<FrameQualityScore> {
  if (!rgb || width <= 0 || height <= 0 || rgb.length < width * height * CHANNELS) {
    return {
      sharpness: 0,
      brightness: 0,
      score: 0,
      usable: false,
      reason: "invalid-dimensions",
    };
  }
  const scale = Math.min(1, QUALITY_DOWNSAMPLE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  let grey: Buffer;
  try {
    grey = await sharp(rgb, { raw: { width, height, channels: CHANNELS } })
      .resize(w, h)
      .greyscale()
      .raw()
      .toBuffer();
  } catch {
    return {
      sharpness: 0,
      brightness: 0,
      score: 0,
      usable: false,
      reason: "decode-failed",
    };
  }
  return scoreGreyFrame(grey, w, h);
}

/** Score an already-greyscale buffer (testable without sharp). */
export function scoreGreyFrame(grey: Uint8Array, width: number, height: number): FrameQualityScore {
  const n = grey.length;
  if (n === 0 || width <= 0 || height <= 0) {
    return { sharpness: 0, brightness: 0, score: 0, usable: false, reason: "invalid-dimensions" };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += grey[i];
  const brightness = sum / n;

  const sharpness = laplacianVariance(grey, width, height);

  let reason: string | null = null;
  if (brightness < QUALITY_MIN_BRIGHTNESS) reason = "too-dark";
  else if (brightness > QUALITY_MAX_BRIGHTNESS) reason = "too-bright";
  else if (sharpness < QUALITY_MIN_SHARPNESS) reason = "blurry";
  const usable = reason === null;
  const score = usable ? Math.min(1, Math.max(0, 0.6 * (sharpness / (sharpness + 20)) + 0.4)) : 0;
  return { sharpness, brightness, score, usable, reason };
}

function laplacianVariance(grey: Uint8Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap =
        4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - w] - grey[i + w];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

export interface FrameCandidateMeta {
  frameId: number;
  capturedAt: number;
  quality: FrameQualityScore;
}

export interface BestFramePick {
  frameId: number;
  ageMs: number;
  score: number;
}

/**
 * Pick the newest sufficiently-sharp frame from the candidate set:
 *   1. drop stale + unusable (blurry / dark / invalid) frames;
 *   2. drop frames whose sharpness is < QUALITY_RELATIVE_SHARPNESS_FLOOR of the
 *      sharpest fresh candidate (severe-blur protection);
 *   3. score the rest by 0.5 freshness + 0.3 relative sharpness + 0.2 brightness
 *      and take the max.
 * Returns null when no fresh frame is good enough (caller falls back to the
 * newest scene frame as a last resort, but the decision is logged).
 */
export function pickBestFrame(
  entries: FrameCandidateMeta[],
  now = Date.now(),
  maxAgeMs = QUALITY_MAX_AGE_MS
): BestFramePick | null {
  const fresh = entries.filter(
    (entry) => now - entry.capturedAt <= maxAgeMs && entry.quality.usable
  );
  if (fresh.length === 0) return null;
  const maxSharp = Math.max(
    ...fresh.map((entry) => entry.quality.sharpness),
    QUALITY_MIN_SHARPNESS
  );
  const viable = fresh.filter(
    (entry) => entry.quality.sharpness >= maxSharp * QUALITY_RELATIVE_SHARPNESS_FLOOR
  );
  if (viable.length === 0) return null;

  let best: BestFramePick | null = null;
  for (const entry of viable) {
    const freshness = 1 - (now - entry.capturedAt) / maxAgeMs;
    const relativeSharpness = entry.quality.sharpness / maxSharp;
    const brightnessNorm = 1 - Math.abs(entry.quality.brightness - 128) / 128;
    const score = 0.5 * freshness + 0.3 * relativeSharpness + 0.2 * brightnessNorm;
    if (!best || score > best.score) {
      best = { frameId: entry.frameId, ageMs: now - entry.capturedAt, score };
    }
  }
  return best;
}
