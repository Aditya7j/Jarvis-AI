import { describe, it, expect, beforeEach, vi } from "vitest";
import { VISION_HOLDING_PROMPT, VISION_STRUCTURED_PROMPT } from "@/lib/ai/prompts";

/**
 * Regression suite for the focused / full VLM call parameters.
 *
 * Root causes fixed here:
 *   1. On CPU-only Ollama hardware a camera-frame analysis used to take 50-77s
 *      because (1) no num_predict was sent (defaulting to the model's full
 *      context) and (2) full-res frames mean 4-9x more vision tokens. The chat
 *      service now bounds each call with a small `maxTokens` budget that must
 *      actually reach the provider.
 *   2. The focused holding VLM used to see the WHOLE frame with no detector
 *      evidence, so it invented objects ("notebook") that YOLO never observed.
 *      It now inspects the hand-region crop and its label is accepted only when
 *      the detector observed the same object in the hand region of the frame.
 */
const engineState = vi.hoisted(() => ({
  active: true,
  sessionId: "sess-1" as string | null,
  bufferedFrame: null as {
    frameId: number;
    capturedAt: number;
    image: string;
    width: number;
    height: number;
    quality: { score: number; sharpness: number; brightness: number };
    heldCandidates: unknown;
    heldCrop: string | null;
    handRegion: unknown;
    hasPerson: boolean;
  } | null,
}));

vi.mock("@/lib/vision/live-vision-engine", () => ({
  liveVisionEngine: {
    getStats: () => ({ active: engineState.active }),
  },
  currentCameraSessionId: () => engineState.sessionId,
  visionReady: () => engineState.active,
  LIVE_VISION_STALE_MS: 1000,
  selectBestBufferedFrame: () => engineState.bufferedFrame,
  getBufferedFrameCandidates: () => [],
}));

import { resolveVisionPlan } from "@/services/chat/vision";
import { getVisionStateStore } from "@/lib/vision/vision-state";
import { visionCache } from "@/lib/vision/vision-cache";
import type { PipelineModel } from "@/services/chat/pipeline";

const FOCUSED_JSON = JSON.stringify({
  held: "phone",
  certain: true,
  reasoning: "A phone is clearly visible in the person's hand.",
});

const INVENTED_JSON = JSON.stringify({
  held: "notebook",
  certain: true,
  reasoning: "The person appears to be holding a notebook.",
});

const FULL_JSON = JSON.stringify({
  visible_objects: [{ name: "cell phone", color: null, confidence: 85 }],
  person: { shirt_color: null, shirt_type: null, pants_visible: false, pants_description: null, confidence: 0 },
  uncertain: false,
  reasoning: "A phone is on the desk.",
});

type FrameCall = {
  prompt?: string;
  maxTokens?: number;
  imageBase64: string;
};

function seedScene(overrides: Record<string, unknown> = {}): void {
  getVisionStateStore().update({
    objects: [],
    people: [
      {
        trackingId: 1,
        label: "person",
        classId: 0,
        box: { x: 0, y: 0, width: 200, height: 400 },
        confidence: 0.92,
        hits: 3,
        misses: 0,
        age: 2,
        createdAt: Date.now() - 1000,
        lastSeenAt: Date.now(),
        lastConfidence: 0.92,
        handRegion: { x: 30, y: 140, width: 140, height: 260 },
      },
    ],
    colors: {},
    frame: {
      buffer: "data:image/jpeg;base64,ZmFrZWltYWdl",
      width: 640,
      height: 480,
      capturedAt: Date.now(),
    },
    scene: "test scene",
    confidence: 0.9,
    frameId: 7,
    cameraSessionId: "sess-1",
    heldCrop: "data:image/jpeg;base64,Y3JvcGZyYW1l",
    heldCandidates: [
      { label: "cell phone", confidence: 0.7, source: "main", inHandRegion: true },
    ],
    ...overrides,
  });
}

function makeModel(respond: (opts: FrameCall) => Promise<string> | string): {
  model: PipelineModel;
  calls: FrameCall[];
} {
  const calls: FrameCall[] = [];
  const model: PipelineModel = {
    async *streamText() {},
    analyzeCameraFrame: vi.fn(async (opts) => {
      const recorded: FrameCall = {
        prompt: opts.prompt,
        maxTokens: opts.maxTokens,
        imageBase64: opts.imageBase64,
      };
      calls.push(recorded);
      return respond(recorded);
    }),
  };
  return { model, calls };
}

beforeEach(() => {
  getVisionStateStore().reset();
  visionCache.clear();
});

describe("focused holding VLM call is bounded and grounded", () => {
  it("sends the hand-region crop with a tiny 96-token budget and detector evidence", async () => {
    engineState.sessionId = "sess-1";
    seedScene();
    const { model, calls } = makeModel(() => FOCUSED_JSON);

    const result = await resolveVisionPlan({
      prompt: "what am I holding?",
      depth: "simple",
      visionState: "live",
      frames: [],
      model,
      language: "english",
      requestId: "test-holding",
    });

    expect(calls).toHaveLength(1);
    // The VLM inspects the hand-region crop, not the whole scene.
    expect(calls[0].imageBase64).toBe("Y3JvcGZyYW1l");
    // The prompt carries the base holding prompt plus the detector evidence.
    expect(calls[0].prompt).toContain(VISION_HOLDING_PROMPT);
    expect(calls[0].prompt).toContain("cell phone");
    expect(calls[0].maxTokens).toBe(96);

    // "phone" normalizes to "cell phone", which the detector observed in the
    // hand region -> verdict accepted -> grounded answer.
    expect(result.kind).toBe("direct-vlm");
    if (result.kind === "direct-vlm") {
      expect(result.text).toBe("You're holding a phone.");
    }
  });

  it("rejects a VLM label the detector never observed in the hand region", async () => {
    engineState.sessionId = "sess-1";
    seedScene({
      heldCandidates: [{ label: "cell phone", confidence: 0.7, source: "main", inHandRegion: true }],
    });
    const { model, calls } = makeModel(() => INVENTED_JSON);

    const result = await resolveVisionPlan({
      prompt: "what am I holding?",
      depth: "simple",
      visionState: "live",
      frames: [],
      model,
      language: "english",
      requestId: "test-invented",
    });

    expect(calls).toHaveLength(1);
    // "notebook" normalizes to "book" but the detector only saw "cell phone" ->
    // verdict rejected -> honest fallback, never an invented object.
    expect(result.kind).toBe("direct-vlm");
    if (result.kind === "direct-vlm") {
      expect(result.text).toBe("I can't identify the object clearly from the current frame.");
      expect(result.text).not.toContain("notebook");
    }
  });

  it("with no detector evidence the VLM is told to answer null and cannot invent", async () => {
    engineState.sessionId = "sess-1";
    seedScene({ heldCandidates: null, heldCrop: null });
    const { model, calls } = makeModel(() => INVENTED_JSON);

    const result = await resolveVisionPlan({
      prompt: "what am I holding?",
      depth: "simple",
      visionState: "live",
      frames: [],
      model,
      language: "english",
      requestId: "test-no-evidence",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].imageBase64).toBe("ZmFrZWltYWdl"); // full scene frame, no crop
    expect(calls[0].prompt).toContain("found NO objects near the person's hands");
    expect(result.kind).toBe("direct-vlm");
    if (result.kind === "direct-vlm") {
      expect(result.text).not.toContain("notebook");
    }
  });

  it("uses the selected best buffered frame + its own evidence, not the latest blurry one", async () => {
    engineState.sessionId = "sess-1";
    // Latest scene frame is fresh but the buffered selector picked an earlier,
    // sharp frame that detected the phone in the hand region.
    engineState.bufferedFrame = {
      frameId: 6,
      capturedAt: Date.now() - 400,
      image: "data:image/jpeg;base64,YnVmZmVyYmVzdGZ0YW1l",
      width: 640,
      height: 480,
      quality: { score: 0.9, sharpness: 42, brightness: 120 },
      heldCandidates: [
        { label: "cell phone", confidence: 0.8, source: "main", inHandRegion: true },
      ],
      heldCrop: "data:image/jpeg;base64,YnVmZmVyY3JvcA==",
      handRegion: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    seedScene({
      // The NEWEST scene frame has no held evidence / crop at all.
      heldCandidates: null,
      heldCrop: null,
    });
    const { model, calls } = makeModel(() => FOCUSED_JSON);

    const result = await resolveVisionPlan({
      prompt: "what am I holding?",
      depth: "simple",
      visionState: "live",
      frames: [],
      model,
      language: "english",
      requestId: "test-buffered-best",
    });

    // The VLM inspects the BUFFERED frame's hand-region crop (not the latest
    // frame), grounded against the buffered frame's own detector evidence.
    expect(calls).toHaveLength(1);
    expect(calls[0].imageBase64).toBe("YnVmZmVyY3JvcA==");
    expect(calls[0].prompt).toContain("cell phone");
    expect(result.kind).toBe("direct-vlm");
    if (result.kind === "direct-vlm") {
      expect(result.text).toBe("You're holding a phone.");
    }
    engineState.bufferedFrame = null;
  });

  it("sends the full structured prompt with a 384-token output budget", async () => {
    engineState.sessionId = "sess-1";
    seedScene();
    const { model, calls } = makeModel(() => FULL_JSON);

    const result = await resolveVisionPlan({
      prompt: "describe what you see on my desk",
      depth: "complex",
      visionState: "live",
      frames: [],
      model,
      language: "english",
      requestId: "test-full",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe(VISION_STRUCTURED_PROMPT);
    expect(calls[0].maxTokens).toBe(384);
    expect(result.kind).toBe("llm");
  });
});
