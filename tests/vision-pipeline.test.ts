import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Engine is mocked so routing tests never touch sharp/onnxruntime. The engine
 * itself is responsible for the continuous background YOLO loop and frame
 * superseding; here we only control `active` and the camera session id so the
 * Vision Manager's routing contract is exercised in isolation.
 */
const engineState = vi.hoisted(() => ({
  active: false,
  sessionId: null as string | null,
}));

vi.mock("@/lib/vision/live-vision-engine", () => ({
  liveVisionEngine: {
    getStats: () => ({ active: engineState.active }),
  },
  currentCameraSessionId: () => engineState.sessionId,
  visionReady: () => engineState.active,
  LIVE_VISION_STALE_MS: 1000,
}));

import {
  resolveVisualQuestion,
  cachedVisionPlan,
  cacheVisionResult,
  VISION_CACHE_FRESH_MS,
} from "@/lib/vision/vision-manager";
import { getVisionStateStore } from "@/lib/vision/vision-state";
import type {
  SceneObject,
  ScenePerson,
} from "@/lib/vision/vision-state";
import type { NamedColor } from "@/lib/vision/detect/colors";
import { answerFromVisionCache } from "@/lib/vision/vision-answer";
import { visionCache } from "@/lib/vision/vision-cache";

const box = { x: 0, y: 0, width: 100, height: 200 };
const now = () => Date.now();

function makePerson(overrides: Partial<ScenePerson> = {}): ScenePerson {
  return {
    trackingId: 1,
    label: "person",
    classId: 0,
    box,
    confidence: 0.92,
    hits: 3,
    misses: 0,
    age: 2,
    createdAt: now() - 1000,
    lastSeenAt: now(),
    lastConfidence: 0.92,
    ...overrides,
  };
}

function makeObject(
  label: string,
  overrides: Partial<SceneObject> = {}
): SceneObject {
  return {
    trackingId: 2,
    label,
    classId: 1,
    box,
    confidence: 0.8,
    hits: 3,
    misses: 0,
    age: 2,
    createdAt: now() - 1000,
    lastSeenAt: now(),
    lastConfidence: 0.8,
    ...overrides,
  };
}

/** Seed the authoritative Scene Cache as if the background engine analyzed a frame. */
function seedScene(sessionId: string | null, people: ScenePerson[] = [], objects: SceneObject[] = []): void {
  getVisionStateStore().update({
    objects,
    people,
    colors: {},
    frame: {
      buffer: "data:image/jpeg;base64,ZmFrZWltYWdl",
      width: 640,
      height: 480,
      capturedAt: now(),
    },
    scene: "test scene",
    confidence: 0.9,
    frameId: 7,
    cameraSessionId: sessionId,
  });
}

function frames(overrides: Partial<{ capturedAt: number }> = {}) {
  return [
    {
      image: "data:image/jpeg;base64,Y2xpZW50ZnJhbWU=",
      mimeType: "image/jpeg",
      source: "webcam" as const,
      width: 640,
      height: 480,
      capturedAt: overrides.capturedAt ?? now(),
    },
  ];
}

beforeEach(() => {
  getVisionStateStore().reset();
  visionCache.clear();
  engineState.active = false;
  engineState.sessionId = null;
});

describe("camera open must never block chat (no inline YOLO / no Gemma for simple)", () => {
  it("answers simple questions purely from the Scene Cache", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()], [makeObject("cell phone")]);

    const t0 = performance.now();
    const resolution = await resolveVisualQuestion({
      prompt: "can you see me?",
      depth: "simple",
      visionState: "live",
      frames: [],
    });
    const elapsed = performance.now() - t0;

    expect(resolution.kind).toBe("cached");
    if (resolution.kind === "cached") {
      expect(resolution.text).toContain("Yes, I can see you");
      expect(resolution.meta.gemmaInvoked).toBe(false);
      expect(resolution.meta.yoloInvoked).toBe(false);
      expect(resolution.meta.cacheHit).toBe(true);
      expect(elapsed).toBeLessThan(300);
    }
  });

  it("serves holding questions from the cache without any LLM", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    const person = makePerson();
    seedScene("sess-1", [person], []);
    getVisionStateStore().update({
      objects: [],
      people: [person],
      colors: {},
      heldObject: { label: "cell phone", confidence: 0.9 },
      frameId: 8,
      cameraSessionId: "sess-1",
    });

    const resolution = await resolveVisualQuestion({
      prompt: "what am I holding?",
      depth: "simple",
      visionState: "live",
      frames: [],
    });

    expect(resolution.kind).toBe("cached");
    if (resolution.kind === "cached") {
      expect(resolution.text).toContain("cell phone");
      expect(resolution.meta.gemmaInvoked).toBe(false);
    }
  });

  it("repeated simple questions never run YOLO or Gemma (no per-question analysis)", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()]);

    for (let i = 0; i < 3; i++) {
      const resolution = await resolveVisualQuestion({
        prompt: "how many people are there?",
        depth: "simple",
        visionState: "live",
        frames: [],
      });
      expect(resolution.kind).toBe("cached");
      if (resolution.kind === "cached") {
        expect(resolution.meta.yoloInvoked).toBe(false);
        expect(resolution.meta.gemmaInvoked).toBe(false);
      }
    }
  });
});

describe("scene freshness & no-stale-answer", () => {
  it("answers from a scene changed by the background loop, never a stale one", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()], [makeObject("bottle")]);

    const before = await resolveVisualQuestion({
      prompt: "is there a bottle?",
      depth: "simple",
      visionState: "live",
      frames: [],
    });
    expect(before.kind).toBe("cached");

    // The object is removed -> background loop updates the cache.
    seedScene("sess-1", [makePerson()], []);

    const after = await resolveVisualQuestion({
      prompt: "is there a bottle?",
      depth: "simple",
      visionState: "live",
      frames: [],
    });
    expect(after.kind).toBe("cached");
    if (after.kind === "cached") {
      expect(after.text).toContain("don't see any bottle");
    }
  });

  it("does not serve answers when the scene belongs to a different session", async () => {
    // Previous session's scene is still in the cache store.
    seedScene("old-session", [makePerson()]);
    engineState.active = true;
    engineState.sessionId = "new-session";

    const resolution = await resolveVisualQuestion({
      prompt: "can you see me?",
      depth: "simple",
      visionState: "live",
      frames: [],
    });

    expect(resolution.kind).toBe("warming");
    if (resolution.kind === "warming") {
      expect(resolution.meta.gemmaInvoked).toBe(false);
    }
  });

  it("refuses (warming) when the camera is on but no frame arrived yet", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    getVisionStateStore().reset();

    const resolution = await resolveVisualQuestion({
      prompt: "what do you see?",
      depth: "complex",
      visionState: "live",
      frames: [],
    });

    expect(resolution.kind).toBe("warming");
    expect(resolution.meta.gemmaInvoked).toBe(false);
  });

  it("refuses when the camera is off — no camera, no Gemma, no Qwen", async () => {
    engineState.active = false;
    const resolution = await resolveVisualQuestion({
      prompt: "what do you see?",
      depth: "complex",
      visionState: "off",
      frames: [],
    });
    expect(resolution.kind).toBe("no-camera");
    if (resolution.kind === "no-camera") {
      expect(resolution.meta.gemmaInvoked).toBe(false);
      expect(resolution.meta.cameraSessionId).toBe(null);
    }
  });
});

describe("complex questions: newest frame only, session-scoped", () => {
  it("routes complex questions to Gemma with the newest frame", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()]);

    const resolution = await resolveVisualQuestion({
      prompt: "describe the scene in detail",
      depth: "complex",
      visionState: "live",
      frames: frames({ capturedAt: now() }),
    });

    expect(resolution.kind).toBe("gemma");
    if (resolution.kind === "gemma") {
      expect(resolution.meta.gemmaInvoked).toBe(true);
      expect(resolution.frame.image).toContain("Y2xpZW50ZnJhbWU");
      expect(resolution.meta.cameraSessionId).toBe("sess-1");
    }
  });

  it("falls back to the Scene Cache frame when no client frame is supplied", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()]);

    const resolution = await resolveVisualQuestion({
      prompt: "describe the scene",
      depth: "complex",
      visionState: "live",
      frames: [],
    });

    expect(resolution.kind).toBe("gemma");
    if (resolution.kind === "gemma") {
      expect(resolution.frame.image).toContain("ZmFrZWltYWdl");
    }
  });

  it("never sends more than one frame to Gemma (latest-frame-only)", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()]);

    const newestCapturedAt = now();
    const resolution = await resolveVisualQuestion({
      prompt: "what is happening right now?",
      depth: "complex",
      visionState: "live",
      frames: [
        { ...frames()[0], capturedAt: now() - 2000 },
        { ...frames()[0], capturedAt: newestCapturedAt },
      ],
    });

    expect(resolution.kind).toBe("gemma");
    if (resolution.kind === "gemma") {
      expect(resolution.frame.capturedAt).toBe(newestCapturedAt);
    }
  });
});

describe("Gemma answer cache is camera-session scoped", () => {
  it("reuses a cached plan only for the same session and same frame generation", () => {
    const summary = {
      state: "live" as const,
      source: "webcam" as const,
      capturedAt: now(),
      confidence: 90,
      objectCount: 1,
      personConfidence: 90,
      error: null,
    };
    cacheVisionResult({
      summary,
      analysis: {
        visible_objects: [],
        person: {
          shirt_color: "blue",
          shirt_type: null,
          pants_visible: false,
          pants_description: null,
          confidence: 0.9,
        },
        text: "",
        uncertain: false,
        reasoning: "seen",
      },
      systemContext: "grounded",
      source: "webcam",
      capturedAt: now(),
      analyzedAt: now(),
      cameraSessionId: "sess-1",
      frameId: 7,
    });

    expect(cachedVisionPlan("webcam", undefined, "sess-1")).not.toBeNull();
    expect(cachedVisionPlan("webcam", undefined, "sess-2")).toBeNull();
    expect(cachedVisionPlan("webcam", undefined)).not.toBeNull();
  });

  it("a closed+reopened camera (new session) never reuses the old Gemma answer", async () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson()]);

    // Complex question stores a Gemma plan for sess-1.
    const first = await resolveVisualQuestion({
      prompt: "describe the scene in detail",
      depth: "complex",
      visionState: "live",
      frames: [],
    });
    expect(first.kind).toBe("gemma");

    // Camera closes and reopens -> new session id, cache wiped by the engine.
    visionCache.clear();
    engineState.sessionId = "sess-2";
    seedScene("sess-2", [makePerson()]);

    expect(cachedVisionPlan("webcam", undefined, "sess-2")).toBeNull();
    const second = await resolveVisualQuestion({
      prompt: "describe the scene in detail",
      depth: "complex",
      visionState: "live",
      frames: [],
    });
    expect(second.kind).toBe("gemma");
  });
});

describe("no hallucinated attributes (YOLO never invents what it didn't detect)", () => {
  it("a visible person with no established shirt colour escalates to Gemma, never guesses", () => {
    engineState.active = true;
    engineState.sessionId = "sess-1";
    seedScene("sess-1", [makePerson({ shirtColor: undefined })]);

    const answer = answerFromVisionCache("what color is my shirt?");
    expect(answer.needsGemma).toBe(true);
    expect(answer.fromCache).toBe(false);
  });

  it("an established shirt colour is answered from the cache without Gemma", () => {
    const color: NamedColor = {
      name: "blue",
      hex: "#0000ff",
      hsv: { h: 240, s: 100, v: 100 },
      confidence: 0.9,
    };
    seedScene("sess-1", [makePerson({ shirtColor: color })], []);

    const answer = answerFromVisionCache("what color is my shirt?");
    expect(answer.needsGemma).toBe(false);
    expect(answer.text).toContain("blue");
  });

  it("when no person is visible the router refuses from cache — no Gemma, no hallucination", () => {
    const resolution = answerFromVisionCache("what color is my shirt?");
    expect(resolution.needsGemma).toBe(false);
    expect(resolution.text).toContain("I can't see you");
  });
});

describe("hard timeout contract", () => {
  it("vision freshness windows stay interactive (simple answers well under 2s budget)", () => {
    expect(VISION_CACHE_FRESH_MS).toBeLessThan(2000);
  });
});
