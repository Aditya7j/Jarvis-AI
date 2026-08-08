import { describe, it, expect } from "vitest";
import {
  scoreGreyFrame,
  pickBestFrame,
  QUALITY_MAX_AGE_MS,
  type FrameQualityScore,
} from "@/lib/vision/frame-quality";

/**
 * Best-frame selection for vision questions.
 *
 * The chat path never captures a still at question time — the camera runs
 * continuously and the engine keeps a rolling buffer of the most recent
 * ANALYZED frames with blur/brightness scores. When the VLM is needed the
 * buffer is scored and the newest *sufficiently sharp* frame is chosen, so a
 * motion-blurred latest frame can never reach Gemma when a sharp recent frame
 * exists.
 */

/** Constant grey buffer (completely blurred). */
function flat(w: number, h: number, value: number): Uint8Array {
  return new Uint8Array(w * h).fill(value);
}

/** Checkerboard -> high contrast -> high sharpness. */
function checkerboard(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const cell = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 40 : 220;
    }
  }
  return out;
}

const entry = (
  frameId: number,
  capturedAt: number,
  quality: FrameQualityScore,
  now: number
) => ({ frameId, capturedAt, quality });

describe("scoreGreyFrame", () => {
  it("flags a completely blurred (flat) frame as unusable", () => {
    const score = scoreGreyFrame(flat(32, 32, 128), 32, 32);
    expect(score.usable).toBe(false);
    expect(score.reason).toBe("blurry");
  });

  it("scores a sharp checkerboard as usable", () => {
    const score = scoreGreyFrame(checkerboard(32, 32), 32, 32);
    expect(score.usable).toBe(true);
    expect(score.sharpness).toBeGreaterThan(0);
  });

  it("flags a too-dark frame as unusable regardless of sharpness", () => {
    const score = scoreGreyFrame(flat(32, 32, 2), 32, 32);
    expect(score.usable).toBe(false);
    expect(score.reason).toBe("too-dark");
  });

  it("flags a too-bright frame as unusable", () => {
    const score = scoreGreyFrame(flat(32, 32, 252), 32, 32);
    expect(score.usable).toBe(false);
    expect(score.reason).toBe("too-bright");
  });

  it("rejects invalid dimensions", () => {
    const score = scoreGreyFrame(new Uint8Array(0), 0, 0);
    expect(score.usable).toBe(false);
  });
});

describe("pickBestFrame", () => {
  const now = 10_000;
  const sharp = scoreGreyFrame(checkerboard(32, 32), 32, 32);
  const blurry = scoreGreyFrame(flat(32, 32, 128), 32, 32);

  it("prefers the newest sufficiently-sharp frame", () => {
    const olderSharp = entry(1, now - 800, sharp, now);
    const newerSharp = entry(2, now - 100, sharp, now);
    const pick = pickBestFrame([olderSharp, newerSharp], now);
    expect(pick?.frameId).toBe(2);
  });

  it("skips a severely-blurred newest frame and picks a recent sharp one", () => {
    const recentBlurry = entry(1, now - 50, blurry, now);
    const olderSharp = entry(2, now - 600, sharp, now);
    const pick = pickBestFrame([olderSharp, recentBlurry], now);
    // blurry newest never reaches the VLM; the sharp frame wins.
    expect(pick?.frameId).toBe(2);
  });

  it("rejects stale frames outright", () => {
    const stale = entry(1, now - QUALITY_MAX_AGE_MS - 1, sharp, now);
    expect(pickBestFrame([stale], now)).toBeNull();
  });

  it("returns null when every fresh frame is unusable", () => {
    const bad = entry(1, now - 100, blurry, now);
    expect(pickBestFrame([bad], now)).toBeNull();
  });

  it("returns null for an empty candidate set", () => {
    expect(pickBestFrame([], now)).toBeNull();
  });

  it("selects the only viable sharp frame when the newest is merely dark", () => {
    const darkNewest = entry(1, now - 100, scoreGreyFrame(flat(32, 32, 4), 32, 32), now);
    const sharpOlder = entry(2, now - 700, sharp, now);
    const pick = pickBestFrame([sharpOlder, darkNewest], now);
    expect(pick?.frameId).toBe(2);
  });

  it("a moderately-sharp newest frame still wins over a slightly older one (prefer freshness)", () => {
    const moderate = { ...sharp, sharpness: sharp.sharpness * 0.7, score: 0.5 };
    const newest = entry(1, now - 80, moderate, now);
    const older = entry(2, now - 900, sharp, now);
    const pick = pickBestFrame([older, newest], now);
    expect(pick?.frameId).toBe(1);
  });
});
