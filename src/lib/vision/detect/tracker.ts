import type { Box, RawDetection } from "./postprocess";

/**
 * ByteTrack-lite: a lightweight IoU-based multi-object tracker (no re-ID
 * network, which is what DeepSORT would require). Greedy cost-matrix matching
 * per class id, exponential box smoothing, and a miss grace window so briefly
 * blurred / occluded objects keep a stable tracking id.
 *
 * Tuning targets (frame cadence ~25-30fps):
 *   - `maxMisses` ~4 frames -> an object disappears ~150ms after truly leaving
 *     the scene, satisfying the "gone means gone" requirement.
 *   - `requireHits` >=2 -> only report new objects that survived two frames,
 *     so transient false positives are suppressed.
 */
export interface TrackedObject {
  trackingId: number;
  label: string;
  classId: number;
  box: Box;
  /** Smoothed confidence over the track's life. */
  confidence: number;
  hits: number;
  misses: number;
  age: number;
  createdAt: number;
  lastSeenAt: number;
  /** Confidence of the most recent detection (used for "is it really there?"). */
  lastConfidence: number;
}

export interface TrackerOptions {
  iouThreshold?: number;
  maxMisses?: number;
  requireHits?: number;
  boxAlpha?: number;
  maxAgeFrames?: number;
}

interface InternalTrack {
  trackingId: number;
  label: string;
  classId: number;
  box: Box;
  confidence: number;
  hits: number;
  misses: number;
  age: number;
  createdAt: number;
  lastSeenAt: number;
  lastConfidence: number;
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

export class ByteTrackLite {
  private tracks = new Map<number, InternalTrack>();
  private nextId = 1;

  constructor(private opts: TrackerOptions = {}) {}

  update(detections: RawDetection[], now = Date.now()): TrackedObject[] {
    const {
      iouThreshold = 0.35,
      maxMisses = 4,
      requireHits = 2,
      boxAlpha = 0.3,
      maxAgeFrames = 300,
    } = this.opts;

    const matchedTracks = new Set<number>();
    const takenDetections = new Set<RawDetection>();

    // Greedy assignment: iterate detections by confidence, match each to the
    // best available same-class track by IoU.
    const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
    for (const det of sorted) {
      let bestTrack: InternalTrack | null = null;
      let bestIoU = iouThreshold;
      for (const track of this.tracks.values()) {
        if (matchedTracks.has(track.trackingId)) continue;
        if (track.label !== det.label || track.classId !== det.classId) continue;
        const overlap = iou(track.box, det.box);
        if (overlap > bestIoU) {
          bestIoU = overlap;
          bestTrack = track;
        }
      }
      if (bestTrack) {
        const alpha = boxAlpha;
        bestTrack.box = {
          x: det.box.x * alpha + bestTrack.box.x * (1 - alpha),
          y: det.box.y * alpha + bestTrack.box.y * (1 - alpha),
          width: det.box.width * alpha + bestTrack.box.width * (1 - alpha),
          height: det.box.height * alpha + bestTrack.box.height * (1 - alpha),
        };
        bestTrack.confidence =
          bestTrack.confidence * 0.85 + det.confidence * 0.15;
        bestTrack.lastConfidence = det.confidence;
        bestTrack.hits++;
        bestTrack.misses = 0;
        bestTrack.age++;
        bestTrack.lastSeenAt = now;
        matchedTracks.add(bestTrack.trackingId);
        takenDetections.add(det);
      }
    }

    // New tracks from unmatched detections.
    for (const det of sorted) {
      if (takenDetections.has(det)) continue;
      const track: InternalTrack = {
        trackingId: this.nextId++,
        label: det.label,
        classId: det.classId,
        box: { ...det.box },
        confidence: det.confidence,
        hits: 1,
        misses: 0,
        age: 1,
        createdAt: now,
        lastSeenAt: now,
        lastConfidence: det.confidence,
      };
      this.tracks.set(track.trackingId, track);
    }

    // Age out: increment misses for unmatched tracks, prune stale tracks.
    for (const track of this.tracks.values()) {
      if (!matchedTracks.has(track.trackingId)) {
        track.misses++;
        track.age++;
      }
    }
    for (const [id, track] of this.tracks) {
      if (track.misses > maxMisses || track.age > maxAgeFrames) {
        this.tracks.delete(id);
      }
    }

    // Report only objects that have been seen enough to be trusted.
    const result: TrackedObject[] = [];
    for (const track of this.tracks.values()) {
      if (track.hits >= requireHits) {
        result.push({
          trackingId: track.trackingId,
          label: track.label,
          classId: track.classId,
          box: { ...track.box },
          confidence: track.confidence,
          hits: track.hits,
          misses: track.misses,
          age: track.age,
          createdAt: track.createdAt,
          lastSeenAt: track.lastSeenAt,
          lastConfidence: track.lastConfidence,
        });
      }
    }
    return result;
  }

  reset(): void {
    this.tracks.clear();
    this.nextId = 1;
  }
}
