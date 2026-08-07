import type { FlagSighting, NamedColor } from "./detect/colors";
import type { TrackedObject } from "./detect/tracker";
import type { OcrResult } from "./ocr";

/**
 * Global vision state shared across every route bundle in the server process
 * via `globalThis`. The live-vision engine (which runs the YOLO pipeline)
 * writes here continuously; chat and the API routes read it to answer simple
 * questions in <700ms without ever calling an LLM.
 *
 * Object semantics:
 *   - `latestObjects` is keyed by trackingId. An object that disappears from
 *     the tracker is removed, satisfying "gone means gone" (within the
 *     tracker's grace window of ~4 frames / ~150ms).
 *   - `latestPeople` holds the tracked persons with per-person clothing
 *     colours and hand-region hints.
 */

export interface SceneObject extends TrackedObject {
  color?: NamedColor;
}

export interface ScenePerson extends TrackedObject {
  shirtColor?: NamedColor;
  heldHint?: string;
}

export interface FaceSighting {
  trackingId: number;
  box: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface VisionFrame {
  buffer: string; // data URL of the latest processed JPEG
  width: number;
  height: number;
  capturedAt: number;
}

export interface VisionStats {
  framesAnalyzed: number;
  lastInferenceMs: number;
  lastPipelineMs: number;
  lastDetectionMs: number;
  yoloFps: number;
  lastError: string | null;
  source: string;
  roiRuns: number;
  roiHits: number;
}

export interface LastGemmaCall {
  at: number;
  reason: string;
}

export interface VisionStateSnapshot {
  latestObjects: Record<number, SceneObject>;
  latestPeople: ScenePerson[];
  latestColors: Record<string, NamedColor>;
  latestText: OcrResult;
  latestFaces: FaceSighting[];
  latestFrame: VisionFrame | null;
  latestScene: string | null;
  timestamp: number;
  overallConfidence: number;
  activeTrackingIds: number[];
  heldObject: { label: string; confidence: number } | null;
  flag: FlagSighting | null;
  stats: VisionStats;
  lastGemma: LastGemmaCall | null;
  /** Monotonic id of the newest analyzed frame (0 = none analyzed yet). */
  frameId: number;
  /** Owning camera session. Answers from another session are never reused. */
  cameraSessionId: string | null;
}

export interface SceneUpdateInput {
  objects: SceneObject[];
  people: ScenePerson[];
  colors: Record<string, NamedColor>;
  text?: OcrResult;
  faces?: FaceSighting[];
  frame?: VisionFrame | null;
  scene?: string | null;
  confidence?: number;
  heldObject?: { label: string; confidence: number } | null;
  flag?: FlagSighting | null;
  stats?: Partial<VisionStats>;
  frameId?: number;
  cameraSessionId?: string | null;
}

const EMPTY_STATS: VisionStats = {
  framesAnalyzed: 0,
  lastInferenceMs: 0,
  lastPipelineMs: 0,
  lastDetectionMs: 0,
  yoloFps: 0,
  lastError: null,
  source: "yolo-onnx",
  roiRuns: 0,
  roiHits: 0,
};

class VisionStateStore {
  private state: VisionStateSnapshot = {
    latestObjects: {},
    latestPeople: [],
    latestColors: {},
    latestText: { lines: [], engine: "none", latencyMs: 0 },
    latestFaces: [],
    latestFrame: null,
    latestScene: null,
    timestamp: 0,
    overallConfidence: 0,
    activeTrackingIds: [],
    heldObject: null,
    flag: null,
    stats: { ...EMPTY_STATS },
    lastGemma: null,
    frameId: 0,
    cameraSessionId: null,
  };

  update(input: SceneUpdateInput): VisionStateSnapshot {
    const objects: Record<number, SceneObject> = {};
    for (const o of input.objects) {
      objects[o.trackingId] = { ...o, color: input.colors[`object-${o.trackingId}`] ?? o.color };
    }
    const people = input.people.map((p) => ({
      ...p,
      shirtColor: input.colors[`person-${p.trackingId}-shirt`] ?? p.shirtColor,
    }));

    this.state = {
      latestObjects: objects,
      latestPeople: people,
      latestColors: input.colors,
      latestText: input.text ?? this.state.latestText,
      latestFaces: input.faces ?? [],
      latestFrame: input.frame ?? this.state.latestFrame,
      latestScene: input.scene ?? this.state.latestScene,
      timestamp: Date.now(),
      overallConfidence: input.confidence ?? this.state.overallConfidence,
      activeTrackingIds: Object.keys(objects).map(Number),
      heldObject: input.heldObject ?? this.state.heldObject,
      flag: input.flag ?? this.state.flag,
      lastGemma: this.state.lastGemma,
      stats: { ...this.state.stats, ...input.stats },
      frameId: input.frameId ?? this.state.frameId,
      cameraSessionId:
        input.cameraSessionId !== undefined
          ? input.cameraSessionId
          : this.state.cameraSessionId,
    };
    return this.state;
  }

  /** Clear the entire scene. Called when the camera closes or a new session starts. */
  reset(): void {
    this.state = {
      latestObjects: {},
      latestPeople: [],
      latestColors: {},
      latestText: { lines: [], engine: "none", latencyMs: 0 },
      latestFaces: [],
      latestFrame: null,
      latestScene: null,
      timestamp: 0,
      overallConfidence: 0,
      activeTrackingIds: [],
      heldObject: null,
      flag: null,
      stats: { ...EMPTY_STATS },
      lastGemma: null,
      frameId: 0,
      cameraSessionId: null,
    };
  }

  getState(): VisionStateSnapshot {
    return this.state;
  }

  /** Age of the newest analyzed frame in ms. Infinity when none is present. */
  getAgeMs(): number {
    return this.state.timestamp > 0 ? Date.now() - this.state.timestamp : Infinity;
  }

  /** True when the cache was written by the given camera session. */
  matchesSession(sessionId: string | null): boolean {
    return this.state.cameraSessionId === sessionId;
  }

  markGemma(reason: string): void {
    this.state = {
      ...this.state,
      lastGemma: { at: Date.now(), reason },
    };
  }

  /** Snapshot of the currently visible objects with counts. */
  getVisibleObjects(): { name: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const o of Object.values(this.state.latestObjects)) {
      counts.set(o.label, (counts.get(o.label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  getPeople(): ScenePerson[] {
    return this.state.latestPeople;
  }

  getObject(name: string): { name: string; count: number; confidence: number } | null {
    const matches = Object.values(this.state.latestObjects).filter(
      (o) => o.label === name.toLowerCase() || o.label === name,
    );
    if (matches.length === 0) return null;
    const confidence =
      matches.reduce((sum, o) => sum + o.confidence, 0) / matches.length;
    return { name: matches[0].label, count: matches.length, confidence };
  }

  getCurrentFrame(): VisionFrame | null {
    return this.state.latestFrame;
  }

  getSceneSummary(): string | null {
    return this.state.latestScene;
  }

  getHeldObject(): { label: string; confidence: number } | null {
    return this.state.heldObject;
  }

  isFresh(maxAgeMs = 1000): boolean {
    return this.state.timestamp > 0 && Date.now() - this.state.timestamp <= maxAgeMs;
  }
}

const globalStore = globalThis as unknown as {
  __jarvis_vision_state__?: VisionStateStore;
};

export function getVisionStateStore(): VisionStateStore {
  if (!globalStore.__jarvis_vision_state__) {
    globalStore.__jarvis_vision_state__ = new VisionStateStore();
  }
  return globalStore.__jarvis_vision_state__;
}

/** Count persons currently tracked. */
export function countPeople(state = getVisionStateStore().getState()): number {
  return state.latestPeople.length;
}
