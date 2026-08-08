import { aiLogger } from "@/lib/ai/logger";
import {
  summarizeVisionAnalysis,
  type VisionAnalysisSummary,
  type VisionStructuredAnalysis,
} from "@/lib/ai/prompts";
import { detectTricolorFlag, sampleBoxColor, sampleRegion, type NamedColor } from "./detect/colors";
import { ByteTrackLite } from "./detect/tracker";
import { getSharedDetector, type YoloResult } from "./detect/yolo-detector";
import {
  HELD_DESK_STRIP_FRACTION,
  pickHeldObject,
  qualifyHeldCandidates,
  type HeldCandidate,
} from "./hold-grounding";
import {
  QUALITY_MAX_AGE_MS,
  pickBestFrame,
  scoreFrameQuality,
  type BufferedVisionFrame,
  type FrameQualityScore,
} from "./frame-quality";
import { getOcrEngine, isOcrAvailable } from "./ocr";
import { visionCache } from "./vision-cache";
import {
  getVisionStateStore,
  type FaceSighting,
  type SceneObject,
  type ScenePerson,
  type VisionFrame,
  type VisionStateSnapshot,
} from "./vision-state";
import sharp from "sharp";
import { randomUUID } from "node:crypto";

/**
 * Server-side real-time vision engine (YOLO pipeline).
 *
 * The client runs a persistent ~25-35 FPS capture loop while the camera is ON
 * and POSTs each meaningfully-changed frame to `/api/vision/live`. This engine:
 *
 *  - decodes the NEWEST frame and runs YOLOv8n (CPU, ONNX Runtime) for real-time
 *    object detection (~30-80ms/frame) with ByteTrack-lite IoU tracking,
 *  - never queues frames: intermediate frames are dropped, only the newest is
 *    processed, and an in-progress pipeline run is superseded by a newer frame,
 *  - runs a high-resolution ROI re-detect on each person's hand region so small
 *    held objects (phone, bottle, cup) are found reliably,
 *  - computes clothing colour + object colours via HSV (no LLM involvement),
 *  - performs an optional pluggable OCR pass (EasyOCR service, off by default),
 *  - continuously writes the global vision state (used by the fast vision router
 *    to answer simple questions in <700ms without any LLM call),
 *  - only runs Gemma on explicit, complex requests from the chat path — never
 *    automatically per frame.
 *
 * The App Router compiles every route handler into its own bundle, so module
 * singletons are NOT shared between `/api/chat` and `/api/vision/live`. Engine
 * state and the vision state therefore live on `globalThis` (shared per Node
 * process); the YOLO session is also shared on `globalThis` so each route uses
 * one model + one inference threadpool.
 */

export const LIVE_VISION_STALE_MS = 1000;
export const LIVE_VISION_RESULT_TTL_MS = 5000;
export const LIVE_VISION_SUBMIT_DEBOUNCE_MS = 200;
const ROI_CONF_THRESHOLD = 0.12;
const MIN_PERSON_HEIGHT_FOR_COLOR = 60;
const FLAG_CHECK_EVERY = 6;
const OCR_CHECK_EVERY = 12;
const FPS_WINDOW_SIZE = 20;

export interface LiveFrameInput {
  /** Base64 JPEG (data-URL prefix stripped). */
  image: string;
  mimeType?: string;
  source?: "webcam" | "screen";
  width?: number;
  height?: number;
  capturedAt?: number;
  /** Client-reported stage timings (ms). */
  captureMs?: number;
  encodeMs?: number;
}

export interface LiveObject {
  name: string;
  color: string | null;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface LiveVisionResult {
  seq: number;
  state: "live" | "error" | "off";
  source: "webcam" | "screen";
  capturedAt: number;
  analyzedAt: number;
  analysis: VisionStructuredAnalysis | null;
  summary: VisionAnalysisSummary | null;
  systemContext: string | null;
  objects: LiveObject[];
  newObjects: string[];
  goneObjects: string[];
  error: string | null;
  captureMs?: number;
  encodeMs?: number;
  detectMs?: number;
  visionMs?: number;
}

export interface LiveVisionStats {
  active: boolean;
  source: "webcam" | "screen" | null;
  /** Unique id of the current camera session (new id on every open). */
  cameraSessionId: string | null;
  /** True when at least one frame has been analyzed in this session. */
  visionReady: boolean;
  /** Age in ms of the newest analyzed frame; Infinity when none yet. */
  sceneCacheAgeMs: number;
  sessionStartedAt: number;
  framesSubmitted: number;
  framesAnalyzed: number;
  aborted: number;
  errors: number;
  analyzing: boolean;
  lastInferenceMs: number;
  lastPipelineMs: number;
  yoloFps: number;
  modelReady: boolean;
  modelError: string | null;
}

interface PipelineOutcome {
  ok: boolean;
  result: LiveVisionResult | null;
  inferenceMs: number;
  pipelineMs: number;
}

/** Diagnostic per-frame stage timings, populated by runPipeline. */
export interface PipelineTimeline {
  seq: number;
  frameKey: string;
  /** sharp decode (base64 -> raw RGB). */
  preprocessMs: number;
  /** main YOLO inference. */
  yoloMainMs: number;
  /** hand-region ROI re-detect. */
  yoloRoiMs: number;
  /** HSV colour sampling (shirt + objects). */
  colorMs: number;
  /** blur/brightness quality scan. */
  qualityMs: number;
  /** vision-state (Scene Cache) update. */
  cacheUpdateMs: number;
  /** full pipeline. */
  totalMs: number;
}

interface LiveEngineStore {
  active: boolean;
  source: "webcam" | "screen" | null;
  /** Unique id of the current camera session. A new id on every start. */
  cameraSessionId: string | null;
  sessionStartedAt: number;
  latestFrame: LiveFrameInput | null;
  latestFrameKey: string | null;
  lastProcessedKey: string | null;
  lastSubmitAt: number;
  result: LiveVisionResult | null;
  resultSeq: number;
  /** Monotonic id of the newest analyzed frame (1-based within a session). */
  frameSeq: number;
  tracker: ByteTrackLite;
  previousNames: string[];
  framesSubmitted: number;
  framesAnalyzed: number;
  aborted: number;
  errors: number;
  frameCounter: number;
  recentInferenceMs: number[];
  recentPipelineMs: number[];
  modelError: string | null;
  modelReady: boolean;
  lastError: string | null;
  lastTimeline: PipelineTimeline | null;
  /** Per-trackingId vote counts per colour name, for temporal smoothing. */
  colorVotes: Map<number, Map<string, number>>;
  /** Per-trackingId last established (stabilized) colour. */
  colorCache: Map<number, NamedColor>;
  /** Held-label support votes across recent frames (ROI consensus). */
  heldVotes: Map<string, number>;
  /** Rolling buffer of the most recent analyzed frames + their quality/evidence. */
  frameBuffer: BufferedVisionFrame[];
}

const STORE_KEY = "__jarvis_live_vision_engine__";
const log = aiLogger.child("live-vision");

/** Max frames retained in the best-frame buffer. */
const FRAME_BUFFER_MAX = 5;
/** Older buffered frames are dropped when pruning. */
const FRAME_BUFFER_MAX_AGE_MS = 5000;

let pipelineBusy = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStore(): LiveEngineStore {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[STORE_KEY] as LiveEngineStore | undefined;
  if (existing && "active" in existing) return existing;
  const store: LiveEngineStore = {
    active: false,
    source: null,
    cameraSessionId: null,
    sessionStartedAt: 0,
    latestFrame: null,
    latestFrameKey: null,
    lastProcessedKey: null,
    lastSubmitAt: 0,
    result: null,
    resultSeq: 0,
    frameSeq: 0,
    tracker: new ByteTrackLite(),
    previousNames: [],
    framesSubmitted: 0,
    framesAnalyzed: 0,
    aborted: 0,
    errors: 0,
    frameCounter: 0,
    recentInferenceMs: [],
    recentPipelineMs: [],
    modelError: null,
    modelReady: false,
    lastError: null,
    lastTimeline: null,
    colorVotes: new Map(),
    colorCache: new Map(),
    heldVotes: new Map(),
    frameBuffer: [],
  };
  Object.defineProperty(g, STORE_KEY, {
    value: store,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

/**
 * Stable identity for a frame. Two frames with the same capturedAt and encoded
 * size are treated as the same frame so the YOLO pipeline can skip re-analysis.
 */
export function liveFrameKey(frame: {
  capturedAt?: number;
  image: string;
}): string {
  return frame.capturedAt
    ? `t:${frame.capturedAt}:${frame.image.length}`
    : `i:${frame.image.length}:${frame.image.slice(0, 64)}`;
}

function frameKey(frame: LiveFrameInput): string {
  return liveFrameKey(frame);
}

function toDataUrl(image: string, mimeType?: string): string {
  const mime = mimeType || "image/jpeg";
  return image.startsWith("data:") ? image : `data:${mime};base64,${image}`;
}

/**
 * Padded hand/lap region of a person box (frame pixels). This is the region
 * that is cropped for the high-res ROI re-detect AND handed to the focused VLM,
 * so the two always inspect exactly the same pixels. Started at 35% of the
 * person's height the crop missed a phone held up near the chest/face (the ROI
 * came back empty); it now starts at 25% so a chest/face-held object still
 * falls inside while the bottom desk/floor strip stays excluded from "held".
 */
function handRegionFor(person: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x0 = person.x + person.width * 0.15;
  const y0 = person.y + person.height * 0.25;
  const x1 = person.x + person.width * 0.85;
  const y1 = person.y + person.height;
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

function yoloFps(times: number[]): number {
  if (times.length < 2) return 0;
  const first = times[0];
  const last = times[times.length - 1];
  const span = last - first;
  if (span <= 0) return 0;
  return (times.length / span) * 1000;
}

function average(times: number[]): number {
  if (times.length === 0) return 0;
  return times.reduce((sum, t) => sum + t, 0) / times.length;
}

function buildSceneSummary(
  people: ScenePerson[],
  objects: SceneObject[],
  held: { label: string; confidence: number } | null,
): string {
  const parts: string[] = [];
  if (people.length > 0) {
    const person = people[0];
    const who = people.length === 1 ? "I can see 1 person" : `I can see ${people.length} people`;
    if (person.shirtColor) {
      parts.push(`${who} wearing a ${person.shirtColor.name} top`);
    } else {
      parts.push(who);
    }
  }
  for (const object of objects) {
    if (object.label === "person") continue;
    parts.push(`a ${object.label}`);
  }
  if (held && parts.length === 0) {
    parts.push(`a ${held.label} being held`);
  }
  if (parts.length === 0) return "Nothing clearly visible.";
  return `I can see ${parts.join(", ")}.`;
}

function decayVotes(votes: Map<string, number>): void {
  for (const [name, count] of votes) {
    const decayed = count * 0.5;
    if (decayed < 0.5) votes.delete(name);
    else votes.set(name, decayed);
  }
}

/**
 * Temporal colour smoothing keyed by tracker identity. A colour is only
 * "established" once it has accumulated >= 2 votes while holding >= 50% of the
 * window, which removes single-frame HSV flicker. Once established it is kept
 * in `cache` and survives occasional null/bad samples; a persistent change in
 * hue decays the old name and lets the new one win within a few frames.
 */
function stabilizeColor(
  trackingId: number,
  sampled: NamedColor | null,
  votes: Map<number, Map<string, number>>,
  cache: Map<number, NamedColor>,
): NamedColor | null {
  const bucket = votes.get(trackingId) ?? new Map<string, number>();
  if (sampled) {
    bucket.set(sampled.name, (bucket.get(sampled.name) ?? 0) + 1);
    for (const [name, count] of bucket) {
      if (name !== sampled.name) bucket.set(name, count * 0.6);
    }
  } else {
    decayVotes(bucket);
  }
  if (bucket.size === 0) {
    votes.delete(trackingId);
    cache.delete(trackingId);
    return null;
  }

  let best = "";
  let bestCount = 0;
  let total = 0;
  for (const [name, count] of bucket) {
    total += count;
    if (count > bestCount) {
      bestCount = count;
      best = name;
    }
  }
  votes.set(trackingId, bucket);

  const established = bestCount >= 2 && bestCount >= total * 0.5;
  if (established) {
    const resolved = sampled && sampled.name === best ? sampled : cache.get(trackingId);
    if (resolved) cache.set(trackingId, resolved);
    return resolved ?? null;
  }
  return cache.get(trackingId) ?? null;
}

/** Prune colour history for tracking ids that are no longer present. */
function pruneColors(
  store: LiveEngineStore,
  trackedIds: Set<number>,
): void {
  for (const id of [...store.colorVotes.keys()]) {
    if (!trackedIds.has(id)) {
      store.colorVotes.delete(id);
      store.colorCache.delete(id);
    }
  }
}

async function runPipeline(frame: LiveFrameInput): Promise<PipelineOutcome> {
  const startedAt = performance.now();
  const detector = getSharedDetector();
  const timeline: PipelineTimeline = {
    seq: getStore().resultSeq + 1,
    frameKey: frameKey(frame),
    preprocessMs: 0,
    yoloMainMs: 0,
    yoloRoiMs: 0,
    colorMs: 0,
    qualityMs: 0,
    cacheUpdateMs: 0,
    totalMs: 0,
  };

  let rgb: Buffer;
  let width: number;
  let height: number;
  const tPre = performance.now();
  try {
    if (!detector.isReady()) {
      await detector.init();
    }
    const decoded = await sharp(Buffer.from(frame.image, "base64"))
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    rgb = decoded.data;
    width = decoded.info.width;
    height = decoded.info.height;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Live frame decode / YOLO init failed", { message });
    const store = getStore();
    store.modelReady = false;
    store.modelError = message;
    store.lastError = message;
    return { ok: false, result: null, inferenceMs: 0, pipelineMs: performance.now() - startedAt };
  }
  timeline.preprocessMs = performance.now() - tPre;

  // --- Frame quality scan (blur / brightness) ---
  // Cheap (~1-3ms, <=96px downscale + Laplacian variance) and runs inside the
  // pipeline so the request hot path never pays for it. The score feeds the
  // best-frame selector: a blurry newest frame is never sent to the VLM when a
  // sharper recent frame exists.
  const tQuality = performance.now();
  let quality: FrameQualityScore = {
    sharpness: 0,
    brightness: 0,
    score: 0,
    usable: false,
    reason: "decode-failed",
  };
  try {
    quality = await scoreFrameQuality(rgb, width, height);
  } catch {
    // keep the unusable default; selection falls back to the newest scene frame
  }
  timeline.qualityMs = performance.now() - tQuality;

  // --- Main YOLO pass ---
  let main: YoloResult;
  const tMain = performance.now();
  try {
    main = await detector.detectRgb({ rgb, width, height });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("YOLO inference failed", { message });
    return { ok: false, result: null, inferenceMs: 0, pipelineMs: performance.now() - startedAt };
  }
  timeline.yoloMainMs = performance.now() - tMain;

  const inferenceMs = main.inferenceMs;

  // --- Person shirt colour (HSV) ---
  const mainPersons = main.detections
    .filter((det) => det.label === "person" && det.confidence >= 0.3)
    .sort((a, b) => b.confidence - a.confidence);

  // --- ROI high-resolution re-detect on each person's hand region ---
  const roiDetections: {
    label: string;
    confidence: number;
    x: number;
    y: number;
    width: number;
    height: number;
    inDesk: boolean;
  }[] = [];
  let roiRuns = 0;
  let roiHits = 0;
  let roiCrop: { width: number; height: number } | null = null;
  const tRoi = performance.now();
  for (const det of main.detections) {
    if (det.label !== "person" || det.confidence < 0.3) continue;
    const box = det.box;
    if (box.width < 20 || box.height < 60) continue;
    const region = handRegionFor(box);
    if (region.width < 16 || region.height < 16) continue;
    const crop = detector.cropRgb({ rgb, width, height }, region);
    roiCrop = { width: crop.width, height: crop.height };
    roiRuns += 1;
    let roiRun: YoloResult;
    try {
      roiRun = await detector.detectRgb(crop, { confThreshold: ROI_CONF_THRESHOLD });
    } catch {
      continue;
    }
    for (const roiDet of roiRun.detections) {
      if (roiDet.label === "person") continue;
      const absX = region.x + roiDet.box.x;
      const absY = region.y + roiDet.box.y;
      const centerY = absY + roiDet.box.height / 2;
      const inDesk =
        region.height > 0 &&
        (centerY - region.y) / region.height >= HELD_DESK_STRIP_FRACTION;
      roiDetections.push({
        label: roiDet.label,
        confidence: roiDet.confidence,
        x: absX,
        y: absY,
        width: roiDet.box.width,
        height: roiDet.box.height,
        inDesk,
      });
      roiHits += 1;
    }
  }
  timeline.yoloRoiMs = performance.now() - tRoi;

  // --- Tracking ---
  const store = getStore();
  const tracked = store.tracker.update(main.detections, Date.now());

  const sceneObjects: SceneObject[] = [];
  const scenePeople: ScenePerson[] = [];
  const colors: Record<string, NamedColor> = {};
  const tColor = performance.now();

  for (const track of tracked) {
    if (track.label === "person") {
      const person: ScenePerson = { ...track };
      person.handRegion = handRegionFor(track.box);
      if (track.box.height >= MIN_PERSON_HEIGHT_FOR_COLOR) {
        const sampled = sampleRegion(
          { data: rgb, width, height },
          track.box,
          0.25,
          0.28,
          0.75,
          0.6,
        );
        const shirt = stabilizeColor(
          track.trackingId,
          sampled,
          store.colorVotes,
          store.colorCache,
        );
        if (shirt) {
          person.shirtColor = shirt;
          colors[`person-${track.trackingId}-shirt`] = shirt;
        }
      }
      scenePeople.push(person);
      sceneObjects.push(person);
    } else {
      const object: SceneObject = { ...track };
      if (track.box.width * track.box.height >= 800) {
        const sampled = sampleBoxColor({ data: rgb, width, height }, track.box);
        const color = stabilizeColor(
          track.trackingId,
          sampled,
          store.colorVotes,
          store.colorCache,
        );
        if (color) {
          object.color = color;
          colors[`object-${track.trackingId}`] = color;
        }
      }
      sceneObjects.push(object);
    }
  }
  pruneColors(store, new Set(tracked.map((track) => track.trackingId)));
  timeline.colorMs = performance.now() - tColor;

  // --- Held object resolution: grounded in the frame, consensus-protected ---
  // A main-pass small object whose centre is inside the person's hand region is
  // direct YOLO evidence and wins immediately. ROI-only detections need 2-of-3
  // frame consensus so a single-frame false positive (e.g. a mug on the desk)
  // is never reported as held.
  const handRegion = scenePeople[0]?.handRegion ?? null;
  const rawCandidates: HeldCandidate[] = [];
  for (const track of tracked) {
    if (track.label === "person" || track.confidence < 0.3) continue;
    const centerX = track.box.x + track.box.width / 2;
    const centerY = track.box.y + track.box.height / 2;
    const inHandRegion =
      !!handRegion &&
      centerX >= handRegion.x &&
      centerX <= handRegion.x + handRegion.width &&
      centerY >= handRegion.y &&
      centerY <= handRegion.y + handRegion.height;
    if (inHandRegion) {
      const inDeskStrip =
        !!handRegion &&
        handRegion.height > 0 &&
        (centerY - handRegion.y) / handRegion.height >= HELD_DESK_STRIP_FRACTION;
      rawCandidates.push({
        label: track.label,
        confidence: track.confidence,
        source: "main",
        inHandRegion,
        inDeskStrip,
      });
    }
  }
  for (const roiDet of roiDetections) {
    rawCandidates.push({
      label: roiDet.label,
      confidence: roiDet.confidence,
      source: "roi",
      inHandRegion: true,
      inDeskStrip: roiDet.inDesk,
    });
  }
  // Only qualified candidates count as evidence / can become the held object
  // (small class, hands zone, >= HELD_HAND_CONFIDENCE). This is the SAME set
  // stored to the Scene Cache, so the focused VLM can never confirm a weak or
  // desk-strip detection.
  const heldCandidates = qualifyHeldCandidates(rawCandidates);
  const heldPicked = pickHeldObject(heldCandidates, store.heldVotes);
  const heldObject: { label: string; confidence: number } | null = heldPicked
    ? { label: heldPicked.label, confidence: heldPicked.confidence }
    : null;

  // Padded hand-region crop of the newest frame — the exact pixels the ROI
  // pass inspected. Sent to the focused VLM for holding questions so it never
  // scans the whole scene for a "held" object.
  let heldCrop: string | null = null;
  if (handRegion && heldCandidates.length > 0) {
    try {
      const crop = detector.cropRgb({ rgb, width, height }, handRegion);
      const jpeg = await sharp(crop.rgb, {
        raw: { width: crop.width, height: crop.height, channels: 3 },
      })
        .jpeg({ quality: 75 })
        .toBuffer();
      heldCrop = toDataUrl(jpeg.toString("base64"), "image/jpeg");
    } catch {
      heldCrop = null;
    }
  }

  // --- Optional OCR (pluggable, off by default) ---
  const frameCounter = getStore().frameCounter;
  const text =
    isOcrAvailable() && frameCounter % OCR_CHECK_EVERY === 0
      ? await getOcrEngine().recognize({ data: rgb, width, height })
      : undefined;

  // --- Flag detection (conservative tricolor scan) ---
  let flag: ReturnType<typeof detectTricolorFlag> = null;
  if (frameCounter % FLAG_CHECK_EVERY === 0) {
    flag = detectTricolorFlag({ data: rgb, width, height });
  }

  // --- Scene summary + vision state write ---
  const scene = buildSceneSummary(scenePeople, sceneObjects, heldObject);
  const visionFrame: VisionFrame = {
    buffer: toDataUrl(frame.image, frame.mimeType),
    width,
    height,
    capturedAt: frame.capturedAt ?? Date.now(),
  };
  const maxConf = tracked.reduce((max, t) => Math.max(max, t.confidence), 0);
  const visionStore = getVisionStateStore();
  const frameId = ++store.frameSeq;
  const tCache = performance.now();
  visionStore.update({
    objects: sceneObjects,
    people: scenePeople,
    colors,
    text,
    frame: visionFrame,
    scene,
    confidence: maxConf,
    heldObject,
    heldCrop,
    heldCandidates,
    flag,
    faces: scenePeople.map(
      (p): FaceSighting => ({
        trackingId: p.trackingId,
        box: p.box,
        confidence: p.confidence,
      }),
    ),
    stats: {
      framesAnalyzed: store.framesAnalyzed + 1,
      lastInferenceMs: inferenceMs,
      lastPipelineMs: performance.now() - startedAt,
      lastDetectionMs: 0,
      yoloFps: yoloFps(store.recentInferenceMs),
      lastError: null,
      source: "yolo-onnx",
      roiRuns,
      roiHits,
    },
    frameId,
    cameraSessionId: store.cameraSessionId,
  });
  timeline.cacheUpdateMs = performance.now() - tCache;

  // --- Rolling best-frame buffer ---
  // Keep the most recent analyzed frames together with each frame's OWN
  // hand-region evidence so the best-frame selector can hand the VLM a sharp
  // older frame whose grounding (crop + candidates) always matches it.
  store.frameBuffer.push({
    frameId,
    capturedAt: visionFrame.capturedAt,
    image: visionFrame.buffer,
    width,
    height,
    quality,
    heldCandidates: heldCandidates.length > 0 ? heldCandidates : null,
    heldCrop,
    handRegion,
    hasPerson: scenePeople.length > 0,
  });
  const nowTime = Date.now();
  store.frameBuffer = store.frameBuffer
    .filter((entry) => nowTime - entry.capturedAt <= FRAME_BUFFER_MAX_AGE_MS)
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, FRAME_BUFFER_MAX);

  // --- Diff new / gone objects (by label) ---
  const currentNames = tracked.map((track) => track.label);
  const newObjects = currentNames.filter((name) => !store.previousNames.includes(name));
  const goneObjects = store.previousNames.filter((name) => !currentNames.includes(name));
  store.previousNames = currentNames;

  // --- Build LiveVisionResult ---
  const capturedAt = visionFrame.capturedAt;
  const analyzedAt = Date.now();
  const personConfidence = scenePeople.reduce((max, p) => Math.max(max, p.confidence), 0);
  const summary: VisionAnalysisSummary = {
    state: "live",
    source: frame.source ?? "webcam",
    capturedAt,
    confidence: maxConf > 0 ? Math.round(maxConf * 100) : null,
    objectCount: tracked.length,
    personConfidence: Math.round(personConfidence * 100),
    error: null,
  };
  const objects: LiveObject[] = tracked.map((track) => {
    const person = scenePeople.find((p) => p.trackingId === track.trackingId);
    const object = sceneObjects.find((o) => o.trackingId === track.trackingId);
    return {
      name: track.label,
      color: person?.shirtColor?.name ?? object?.color?.name ?? null,
      confidence: track.confidence,
      bbox: track.box,
      firstSeenAt: track.createdAt,
      lastSeenAt: track.lastSeenAt,
    };
  });

  const result: LiveVisionResult = {
    seq: ++store.resultSeq,
    state: "live",
    source: frame.source ?? "webcam",
    capturedAt,
    analyzedAt,
    analysis: null,
    summary,
    systemContext: null,
    objects,
    newObjects,
    goneObjects,
    error: null,
    captureMs: frame.captureMs,
    encodeMs: frame.encodeMs,
    detectMs: inferenceMs,
    visionMs: 0,
  };

  store.result = result;
  store.framesAnalyzed += 1;
  store.modelReady = true;
  store.modelError = null;
  store.lastError = null;
  store.recentInferenceMs.push(inferenceMs);
  if (store.recentInferenceMs.length > FPS_WINDOW_SIZE) store.recentInferenceMs.shift();
  store.recentPipelineMs.push(performance.now() - startedAt);
  if (store.recentPipelineMs.length > FPS_WINDOW_SIZE) store.recentPipelineMs.shift();

  const pipelineMs = performance.now() - startedAt;
  timeline.totalMs = pipelineMs;
  store.lastTimeline = timeline;
  log.info(
    `[YOLO] #${result.seq} · pipe ${pipelineMs.toFixed(1)}ms = decode ${timeline.preprocessMs.toFixed(1)} + yolo ${timeline.yoloMainMs.toFixed(1)} + roi ${timeline.yoloRoiMs.toFixed(1)} + color ${timeline.colorMs.toFixed(1)} + quality ${timeline.qualityMs.toFixed(1)} + cache ${timeline.cacheUpdateMs.toFixed(1)} · objects ${objects.length} · roi ${roiDetections.length}/${roiRuns} (${roiCrop ? `${roiCrop.width}x${roiCrop.height}` : "n/a"}) · held ${heldObject ? heldObject.label : "-"} · quality ${quality.usable ? "ok" : quality.reason} · new ${newObjects.join(",") || "none"} · gone ${goneObjects.join(",") || "none"}`
  );
  if (roiDetections.length > 0) {
    log.info("[ROI] detections", {
      seq: result.seq,
      crop: roiCrop ? `${roiCrop.width}x${roiCrop.height}` : null,
      detections: roiDetections.map((d) => ({
        label: d.label,
        confidence: Math.round(d.confidence * 100) / 100,
        inDesk: d.inDesk,
      })),
    });
  }
  return { ok: true, result, inferenceMs, pipelineMs };
}

/** Serialise pipeline runs so ONNX session calls never interleave. */
async function withPipeline<T>(fn: () => Promise<T>): Promise<T> {
  while (pipelineBusy) {
    await sleep(4);
  }
  pipelineBusy = true;
  try {
    return await fn();
  } finally {
    pipelineBusy = false;
  }
}

async function ensureDetection(): Promise<void> {
  const store = getStore();
  while (store.active) {
    const frame = store.latestFrame;
    if (!frame) break;
    const key = frameKey(frame);
    if (store.lastProcessedKey === key) break;
    const outcome = await withPipeline(() => runPipeline(frame));
    if (!outcome.ok) {
      const message = outcome.result?.error ?? "Vision pipeline failed";
      store.lastError = message;
      store.errors += 1;
      store.result = {
        seq: ++store.resultSeq,
        state: "error",
        source: frame.source ?? "webcam",
        capturedAt: frame.capturedAt ?? Date.now(),
        analyzedAt: Date.now(),
        analysis: null,
        summary: summarizeVisionAnalysis(null, {
          state: "error",
          source: frame.source ?? "webcam",
          capturedAt: frame.capturedAt,
          error: message,
        }),
        systemContext: null,
        objects: [],
        newObjects: [],
        goneObjects: [],
        error: message,
      };
    } else {
      store.lastProcessedKey = key;
    }
    if (store.active && store.latestFrame) {
      const latestKey = frameKey(store.latestFrame);
      if (latestKey === key) break;
    } else {
      break;
    }
  }
}

export function visionReady(): boolean {
  const store = getStore();
  return (
    store.active &&
    store.cameraSessionId !== null &&
    getVisionStateStore().getState().frameId > 0 &&
    getVisionStateStore().matchesSession(store.cameraSessionId)
  );
}

export function currentCameraSessionId(): string | null {
  return getStore().cameraSessionId;
}

export interface BufferedFrameInfo {
  frameId: number;
  ageMs: number;
  sharpness: number;
  brightness: number;
  score: number;
  usable: boolean;
  reason: string | null;
}

/** Quality snapshot of every retained buffered frame, oldest -> newest. */
export function getBufferedFrameCandidates(): BufferedFrameInfo[] {
  const now = Date.now();
  return [...getStore().frameBuffer]
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .map((entry) => ({
      frameId: entry.frameId,
      ageMs: now - entry.capturedAt,
      sharpness: entry.quality.sharpness,
      brightness: entry.quality.brightness,
      score: entry.quality.score,
      usable: entry.quality.usable,
      reason: entry.quality.reason,
    }));
}

/**
 * The best current frame for VLM analysis: the newest sufficiently-sharp frame
 * in the rolling buffer (stale / blurry / dark frames are skipped). Returns the
 * full buffered entry — including that frame's OWN hand-region evidence — so
 * grounding always matches the frame that is actually analyzed. Null when no
 * retained frame passes the quality gate (caller falls back to the newest
 * scene frame as a last resort, but the rejection is logged).
 */
export function selectBestBufferedFrame(
  maxAgeMs = QUALITY_MAX_AGE_MS
): BufferedVisionFrame | null {
  const store = getStore();
  if (store.frameBuffer.length === 0) return null;
  const best = pickBestFrame(store.frameBuffer, Date.now(), maxAgeMs);
  if (!best) return null;
  return store.frameBuffer.find((entry) => entry.frameId === best.frameId) ?? null;
}

export const liveVisionEngine = {
  /**
   * Mark the session active so the engine keeps accepting frames. Starting a
   * new session rotates the camera session id and wipes the previous session's
   * scene cache and Gemma answer cache so nothing stale leaks into the new one.
   * Never blocks the caller: ONNX warm-up runs in the background.
   */
  start(source: "webcam" | "screen"): void {
    const store = getStore();
    store.cameraSessionId = randomUUID();
    store.active = true;
    store.source = source;
    store.sessionStartedAt = Date.now();
    store.frameSeq = 0;
    store.framesSubmitted = 0;
    store.framesAnalyzed = 0;
    store.lastProcessedKey = null;
    store.result = null;
    store.previousNames = [];
    store.tracker.reset();
    store.recentInferenceMs = [];
    store.recentPipelineMs = [];
    store.colorVotes.clear();
    store.colorCache.clear();
    store.heldVotes.clear();
    store.frameBuffer = [];
    store.modelReady = false;
    store.modelError = null;
    store.lastError = null;
    getVisionStateStore().reset();
    visionCache.clear();
    log.info("Live vision session started", { source, cameraSessionId: store.cameraSessionId });
    void getSharedDetector()
      .init()
      .then(() => {
        store.modelReady = true;
        log.info("YOLO model warm-up complete");
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        store.modelError = message;
        store.modelReady = false;
        log.warn("YOLO model warm-up failed", { message });
      });
  },

  /** End the session, clear the tracker and reset all vision state. */
  stop(): void {
    const store = getStore();
    store.active = false;
    store.source = null;
    store.cameraSessionId = null;
    store.latestFrame = null;
    store.latestFrameKey = null;
    store.lastProcessedKey = null;
    store.result = null;
    store.previousNames = [];
    store.tracker.reset();
    store.recentInferenceMs = [];
    store.recentPipelineMs = [];
    store.colorVotes.clear();
    store.colorCache.clear();
    store.heldVotes.clear();
    store.frameBuffer = [];
    getVisionStateStore().reset();
    visionCache.clear();
    log.info("Live vision session stopped");
  },

  /**
   * Store the newest frame and kick the single-flight detection loop.
   * Returns the current result snapshot immediately (partial results).
   */
  submit(frame: LiveFrameInput): LiveVisionResult | null {
    const store = getStore();
    if (!store.active) return null;
    store.latestFrame = frame;
    store.latestFrameKey = frameKey(frame);
    store.lastSubmitAt = Date.now();
    store.framesSubmitted += 1;
    void ensureDetection();
    return store.result;
  },

  /**
   * Run the full YOLO pipeline on a single frame and await the result. Used by
   * the chat path for one-off captured frames (e.g. camera just turned on).
   */
  async analyzeFrame(frame: LiveFrameInput): Promise<LiveVisionResult | null> {
    const store = getStore();
    const key = frameKey(frame);
    const outcome = await withPipeline(() => runPipeline(frame));
    if (outcome.ok) {
      store.lastProcessedKey = key;
    }
    if (!outcome.ok) {
      const message = outcome.result?.error ?? "Vision pipeline failed";
      store.errors += 1;
      store.lastError = message;
      return {
        seq: ++store.resultSeq,
        state: "error",
        source: frame.source ?? "webcam",
        capturedAt: frame.capturedAt ?? Date.now(),
        analyzedAt: Date.now(),
        analysis: null,
        summary: summarizeVisionAnalysis(null, {
          state: "error",
          source: frame.source ?? "webcam",
          capturedAt: frame.capturedAt,
          error: message,
        }),
        systemContext: null,
        objects: [],
        newObjects: [],
        goneObjects: [],
        error: message,
      };
    }
    return outcome.result;
  },

  /** True when the exact frame (capturedAt + size) was already analyzed. */
  hasProcessedFrame(key: string): boolean {
    const store = getStore();
    return store.active && store.lastProcessedKey === key;
  },

  /** Latest completed result, if any. */
  getResult(source?: "webcam" | "screen"): LiveVisionResult | null {
    const store = getStore();
    if (!store.active) return null;
    const result = store.result;
    if (!result) return null;
    if (source && result.source !== source) return null;
    return result;
  },

  /**
   * Latest completed result, only if fresh enough. With the YOLO pipeline the
   * chat fast path uses the vision-state cache instead; this remains for
   * backward compatibility with older callers.
   */
  getFreshResult(
    source?: "webcam" | "screen",
    staleMs = LIVE_VISION_STALE_MS,
    ttlMs = LIVE_VISION_RESULT_TTL_MS
  ): LiveVisionResult | null {
    const store = getStore();
    if (!store.active) return null;
    const activeSource = source ?? store.source;
    const result = store.result;
    if (!result) return null;
    if (activeSource && result.source !== activeSource) return null;
    const nowTime = Date.now();
    if (nowTime - result.analyzedAt > ttlMs) return null;
    if (nowTime - result.capturedAt > staleMs) return null;
    return result;
  },

  /** Per-frame stage timings of the most recently completed pipeline run. */
  getLastTimeline(): PipelineTimeline | null {
    return getStore().lastTimeline;
  },

  isAnalyzing(): boolean {
    return pipelineBusy;
  },

  /** Full vision-state snapshot (objects, people, colours, held object, flags). */
  getSceneState(): VisionStateSnapshot {
    return getVisionStateStore().getState();
  },

  getStats(): LiveVisionStats {
    const store = getStore();
    return {
      active: store.active,
      source: store.source,
      cameraSessionId: store.cameraSessionId,
      visionReady: getVisionStateStore().getState().frameId > 0,
      sceneCacheAgeMs: getVisionStateStore().getAgeMs(),
      sessionStartedAt: store.sessionStartedAt,
      framesSubmitted: store.framesSubmitted,
      framesAnalyzed: store.framesAnalyzed,
      aborted: store.aborted,
      errors: store.errors,
      analyzing: pipelineBusy,
      lastInferenceMs: average(store.recentInferenceMs),
      lastPipelineMs: average(store.recentPipelineMs),
      yoloFps: yoloFps(store.recentInferenceMs),
      modelReady: store.modelReady,
      modelError: store.modelError,
    };
  },
};
