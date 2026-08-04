import { describe, it, expect } from "vitest";
import {
  decodeYoloOutput,
  mapLetterboxBox,
  nmsClassAware,
} from "@/lib/vision/detect/postprocess";
import type { RawDetection } from "@/lib/vision/detect/postprocess";

describe("mapLetterboxBox", () => {
  it("maps a letterboxed box back to source coordinates with padding", () => {
    // 16:9 source letterboxed into 640x640 → padY = 140 at scale 0.5.
    const box = mapLetterboxBox(320, 320, 100, 100, 640, 1280, 720);
    expect(box).toEqual({ x: 540, y: 260, width: 200, height: 200 });
  });
});

describe("decodeYoloOutput", () => {
  it("decodes a channel-major tensor, applies the confidence floor and NMS", () => {
    const inputSize = 640;
    const n = 90; // predictions (anchors) — must exceed channels for channel-major
    const channels = 84;
    const output = new Float32Array(channels * n);

    const setBox = (anchor: number, cx: number, cy: number, w: number, h: number) => {
      output[anchor] = cx;
      output[n + anchor] = cy;
      output[n * 2 + anchor] = w;
      output[n * 3 + anchor] = h;
    };
    const setScore = (anchor: number, classId: number, score: number) => {
      output[(4 + classId) * n + anchor] = score;
    };

    setBox(0, 320, 320, 100, 100);
    setScore(0, 0, 0.9);
    setBox(1, 330, 330, 100, 100);
    setScore(1, 0, 0.95);
    setBox(2, 500, 500, 50, 50);
    setScore(2, 5, 0.8);

    const detections = decodeYoloOutput(
      output,
      [1, channels, n],
      0.5,
      640,
      640,
      inputSize
    );

    // NMS collapses the two overlapping person-0 boxes into the higher-score one.
    expect(detections).toHaveLength(2);
    const class0 = detections.find((d) => d.classId === 0);
    const class5 = detections.find((d) => d.classId === 5);
    expect(class0?.confidence).toBeCloseTo(0.95, 5);
    expect(class0?.box.x).toBeCloseTo(280, 5);
    expect(class5?.confidence).toBeCloseTo(0.8, 5);
  });

  it("converts unbounded logits to probabilities", () => {
    const n = 100;
    const channels = 84;
    const output = new Float32Array(channels * n);
    output[0] = 320;
    output[n] = 320;
    output[n * 2] = 50;
    output[n * 3] = 50;
    output[(4 + 0) * n] = 10; // raw logit
    const detections = decodeYoloOutput(output, [1, channels, n], 0.5, 640, 640, 640);
    expect(detections[0].confidence).toBeCloseTo(1 / (1 + Math.exp(-10)), 5);
  });

  it("throws on an unexpected shape", () => {
    expect(() => decodeYoloOutput(new Float32Array(0), [1, 84], 0.5, 640, 640)).toThrow();
  });
});

describe("nmsClassAware", () => {
  it("suppresses lower-confidence overlapping boxes of the same class", () => {
    const base: Omit<RawDetection, "confidence" | "box"> = {
      label: "person",
      classId: 0,
    };
    const detections: RawDetection[] = [
      { ...base, confidence: 0.6, box: { x: 0, y: 0, width: 100, height: 100 } },
      { ...base, confidence: 0.9, box: { x: 10, y: 10, width: 100, height: 100 } },
    ];
    const kept = nmsClassAware(detections);
    expect(kept).toHaveLength(1);
    expect(kept[0].confidence).toBe(0.9);
  });

  it("keeps boxes of different classes even when overlapping", () => {
    const detections: RawDetection[] = [
      { label: "person", classId: 0, confidence: 0.9, box: { x: 0, y: 0, width: 100, height: 100 } },
      { label: "cat", classId: 15, confidence: 0.8, box: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    expect(nmsClassAware(detections)).toHaveLength(2);
  });
});
