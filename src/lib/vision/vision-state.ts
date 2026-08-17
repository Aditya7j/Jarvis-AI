import type { FlagSighting, NamedColor } from "./detect/colors";
import type { TrackedObject } from "./detect/tracker";
import type { HeldCandidate } from "./hold-grounding";
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
  /** Padded hand/lap region (frame pixels) used for held-object detection. */
  handRegion?: { x: number; y: number; width: number; height: number };
  /** VLM-determined garment type (t-shirt, hoodie, jacket, …). Undefined = never checked; null = checked but unknown. */
  garmentType?: string | null;
  /** Timestamp (ms) when garmentType was last determined by the VLM. Used for TTL on "checked, still unknown". */
  garmentTypeCheckedAt?: number;
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
  /**
   * Padded hand-region crop (JPEG data URL) of the newest frame when the
   * detector gathered hand-region evidence. Sent to the focused VLM for
   * "what am I holding?" so it inspects the actual hand region, never the
   * whole scene.
   */
  heldCrop: string | null;
  /** Detector evidence for the hand region of the newest frame (main + ROI). */
  heldCandidates: HeldCandidate[] | null;
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
  heldCrop?: string | null;
  heldCandidates?: HeldCandidate[] | null;
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

/**
 * TTL for a "checked but unknown" garment type before re-escalating to the VLM.
 * Avoids hammering the VLM every turn when it genuinely can't determine the type,
 * while still re-checking if the scene changes enough to warrant a new attempt.
 */
const GARMENT_TYPE_TTL_MS = 15_000;

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
    heldCrop: null,
    heldCandidates: null,
  };

  /**
   * VLM-determined garment types persisted across frame updates. Keyed by
   * person trackingId. Entries are cleaned up when the person disappears from
   * the tracker or when the state is reset.
   */
  private garmentTypes: Map<number, { garmentType: string | null; checkedAt: number }> = new Map();

  update(input: SceneUpdateInput): VisionStateSnapshot {
    const objects: Record<number, SceneObject> = {};
    for (const o of input.objects) {
      objects[o.trackingId] = { ...o, color: input.colors[`object-${o.trackingId}`] ?? o.color };
    }
    const people = input.people.map((p) => {
      const cached = this.garmentTypes.get(p.trackingId);
      return {
        ...p,
        shirtColor: input.colors[`person-${p.trackingId}-shirt`] ?? p.shirtColor,
        garmentType: cached ? cached.garmentType : p.garmentType,
        garmentTypeCheckedAt: cached ? cached.checkedAt : p.garmentTypeCheckedAt,
      };
    });

    // Clean up garment type entries for people who are no longer tracked.
    const activeIds = new Set(input.people.map((p) => p.trackingId));
    for (const id of this.garmentTypes.keys()) {
      if (!activeIds.has(id)) this.garmentTypes.delete(id);
    }

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
      heldCrop: input.heldCrop !== undefined ? input.heldCrop : this.state.heldCrop,
      heldCandidates:
        input.heldCandidates !== undefined
          ? input.heldCandidates
          : this.state.heldCandidates,
    };
    return this.state;
  }

  /** Clear the entire scene. Called when the camera closes or a new session starts. */
  reset(): void {
    this.garmentTypes.clear();
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
      heldCrop: null,
      heldCandidates: null,
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

  /**
   * Cache a VLM-determined garment type for a tracked person. Persists across
   * frame updates so subsequent "what am I wearing?" calls answer instantly
   * without re-escalating to the VLM. A null value means "checked, still
   * unknown" and expires after GARMENT_TYPE_TTL_MS.
   */
  setGarmentType(trackingId: number, garmentType: string | null): void {
    this.garmentTypes.set(trackingId, { garmentType, checkedAt: Date.now() });
    // Also update the current snapshot so the next read sees it immediately.
    const people = this.state.latestPeople.map((p) => {
      if (p.trackingId !== trackingId) return p;
      return { ...p, garmentType, garmentTypeCheckedAt: Date.now() };
    });
    this.state = { ...this.state, latestPeople: people };
  }

  /** Whether the garment type cache for a person has expired (or was never set). */
  garmentTypeExpired(trackingId: number): boolean {
    const entry = this.garmentTypes.get(trackingId);
    if (!entry) return true;
    if (entry.garmentType !== null) return false; // positive result never expires
    return Date.now() - entry.checkedAt > GARMENT_TYPE_TTL_MS;
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
