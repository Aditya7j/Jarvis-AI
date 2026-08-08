import { SMALL_OBJECT_CLASSES } from "./detect/coco-classes";

/**
 * Held-object grounding: pure, testable helpers that keep the "what am I
 * holding?" answer anchored to what the detector ACTUALLY observed in the
 * current frame's hand region.
 *
 * Problem being fixed: the held object used to be the single highest-confidence
 * ROI detection of one frame (a mug on the desk could beat a phone that was
 * held outside the ROI crop), and the focused VLM was given the whole frame
 * with no detector evidence, so it invented plausible objects ("notebook")
 * that were never seen by YOLO.
 *
 * Rules enforced here:
 *   - A main-pass small object whose centre is inside the hand region is the
 *     strongest evidence and wins immediately (>= HELD_MAIN_CONFIDENCE).
 *   - ROI-only (and weaker main-pass) detections need temporal consensus (seen
 *     on >= 2 of the last 3 frames) before being reported as held.
 *   - Objects whose centre falls in the bottom strip of the hand-region crop
 *     (HELD_DESK_STRIP_FRACTION) sit on the desk/floor — they are never held.
 *   - Only COCO small-object classes can ever be "held".
 *   - A VLM label is accepted only when it normalizes to a COCO label that the
 *     detector reported in the hand region of the same frame.
 *   - A consensus-established held object is reported at >= HELD_REPORT_CONFIDENCE
 *     so the cache answer names it with an honesty hedge instead of degrading to
 *     a low-confidence reposition prompt.
 */

export interface HeldCandidate {
  label: string;
  confidence: number;
  source: "main" | "roi";
  inHandRegion: boolean;
  /** Centre is in the bottom (desk/floor) strip of the hand-region crop. */
  inDeskStrip?: boolean;
}

export type HeldPick = {
  label: string;
  confidence: number;
  source: HeldCandidate["source"];
};

export const HELD_CONSENSUS_FRAMES = 3;
export const HELD_MIN_VOTES = 2;
/**
 * Main-pass small object whose centre is inside the hand region wins
 * immediately at >= this confidence. The main pass itself already runs at
 * confThreshold 0.35, so this effectively admits every real main-pass
 * in-hand observation while keeping sub-0.35 noise out of the instant path.
 */
export const HELD_MAIN_CONFIDENCE = 0.35;
/**
 * Hands-zone detections (ROI or main) need >= this confidence to count as
 * evidence and to participate in consensus. The ROI pass runs at confThreshold
 * 0.12 so a weak-but-real phone is surfaced; only detections >= this floor can
 * ever become the held object, and only with 2-of-3 temporal consensus.
 */
export const HELD_HAND_CONFIDENCE = 0.2;
/**
 * Reported-confidence floor. A consensus-established held object is reported
 * at >= 70% so the cache answer lands in the "uncertain" band: it names the
 * object with an honesty hedge ("I'm not completely sure") instead of being
 * downgraded to the low-band reposition prompt by the raw per-frame score.
 */
export const HELD_REPORT_CONFIDENCE = 0.7;
/**
 * Bottom fraction of the hand-region crop treated as desk/floor. A detection
 * whose centre falls in this strip is sitting on the desk — it is never "held".
 */
export const HELD_DESK_STRIP_FRACTION = 0.85;

/**
 * Evidence the detector gathered for the hand region of the newest frame. Used
 * both to constrain the focused VLM prompt and to cross-check its answer.
 */
export interface HeldObjectEvidence {
  /** COCO labels the detector observed in the hand region this frame. */
  labels: Set<string>;
  /** Person's hand region in frame pixels (null when no person is tracked). */
  region: { x: number; y: number; width: number; height: number } | null;
  hasPerson: boolean;
}

/**
 * Increment the winning held label's support and decay everything else, so a
 * label must be seen repeatedly to survive and a disappearing object decays
 * within `maxFrames`.
 */
export function voteHeld(
  votes: Map<string, number>,
  label: string | null,
  maxFrames = HELD_CONSENSUS_FRAMES
): void {
  for (const [key, value] of votes) {
    if (key !== label) votes.set(key, value - 1);
  }
  if (label) {
    votes.set(label, Math.min(maxFrames, (votes.get(label) ?? 0) + 1));
  }
  for (const [key, value] of votes) {
    if (value <= 0) votes.delete(key);
  }
}

/**
 * The subset of detector hand-region observations that count as "held"
 * evidence for THIS frame. This drives both the evidence handed to the focused
 * VLM and the consensus pool, so a weak or desk-strip detection can never be
 * confirmed by a VLM or become the held object:
 *   - only COCO small-object classes,
 *   - never the desk/floor strip of the crop,
 *   - main-pass objects must actually be inside the hand region,
 *   - confidence >= HELD_HAND_CONFIDENCE.
 */
export function qualifyHeldCandidates(
  candidates: HeldCandidate[]
): HeldCandidate[] {
  return candidates.filter(
    (candidate) =>
      SMALL_OBJECT_CLASSES.has(candidate.label) &&
      !candidate.inDeskStrip &&
      (candidate.source !== "main" || candidate.inHandRegion) &&
      candidate.confidence >= HELD_HAND_CONFIDENCE
  );
}

/**
 * Resolve the frame's held object from detector evidence:
 *   1. best main-pass small object inside the hand region (>= HELD_MAIN_CONFIDENCE)
 *      wins immediately;
 *   2. otherwise the best remaining qualified detection — but only after
 *      HELD_MIN_VOTES of temporal consensus, so a single-frame false positive
 *      is never reported.
 * Only COCO small-object classes qualify, and desk-strip objects never do. A
 * picked object is reported at >= HELD_REPORT_CONFIDENCE.
 */
export function pickHeldObject(
  candidates: HeldCandidate[],
  votes: Map<string, number>
): HeldPick | null {
  const allowed = qualifyHeldCandidates(candidates);
  const inHandMain = allowed
    .filter(
      (candidate) =>
        candidate.source === "main" &&
        candidate.confidence >= HELD_MAIN_CONFIDENCE
    )
    .sort((a, b) => b.confidence - a.confidence);
  if (inHandMain.length > 0) {
    const best = inHandMain[0];
    voteHeld(votes, best.label);
    return {
      label: best.label,
      confidence: Math.max(best.confidence, HELD_REPORT_CONFIDENCE),
      source: "main",
    };
  }

  const pooled = [...allowed].sort((a, b) => b.confidence - a.confidence);
  if (pooled.length > 0) {
    const best = pooled[0];
    voteHeld(votes, best.label);
    if ((votes.get(best.label) ?? 0) >= HELD_MIN_VOTES) {
      return {
        label: best.label,
        confidence: Math.max(best.confidence, HELD_REPORT_CONFIDENCE),
        source: best.source,
      };
    }
    return null;
  }

  voteHeld(votes, null);
  return null;
}

/**
 * Map free-form / VLM phrasing onto the canonical COCO label so detector
 * evidence and VLM answers can be compared. Returns null for phrasings that do
 * not correspond to any known object class.
 */
const OBJECT_ALIASES: Record<string, string> = {
  "cell phone": "cell phone",
  phone: "cell phone",
  cellphone: "cell phone",
  mobile: "cell phone",
  smartphone: "cell phone",
  iphone: "cell phone",
  android: "cell phone",
  "android phone": "cell phone",
  handphone: "cell phone",
  cup: "cup",
  mug: "cup",
  "coffee mug": "cup",
  "coffee cup": "cup",
  teacup: "cup",
  "tea cup": "cup",
  glass: "cup",
  bottle: "bottle",
  "water bottle": "bottle",
  tumbler: "bottle",
  flask: "bottle",
  book: "book",
  notebook: "book",
  notepad: "book",
  journal: "book",
  diary: "book",
  "notebook paper": "book",
  remote: "remote",
  "remote control": "remote",
  clicker: "remote",
  "tv remote": "remote",
  mouse: "mouse",
  "computer mouse": "mouse",
  keyboard: "keyboard",
  scissors: "scissors",
  fork: "fork",
  knife: "knife",
  spoon: "spoon",
  toothbrush: "toothbrush",
  watch: "clock",
  wristwatch: "clock",
  smartwatch: "clock",
  timepiece: "clock",
  clock: "clock",
  "wine glass": "wine glass",
  vase: "vase",
};

export function normalizeObjectAlias(label: string | null): string | null {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  return OBJECT_ALIASES[normalized] ?? null;
}

/**
 * Verdict for a focused VLM "held" answer: the label is accepted ONLY when it
 * normalizes to a COCO label the detector reported in the hand region of the
 * same frame. Anything else is rejected so the answer falls back to the honest
 * "can't identify clearly" text instead of an invented object.
 */
export function groundHeldVlmResult(
  vlmLabel: string | null,
  evidence: HeldObjectEvidence | null
): { accepted: boolean; canonical: string | null } {
  if (!vlmLabel) return { accepted: false, canonical: null };
  const canonical = normalizeObjectAlias(vlmLabel);
  if (!canonical) return { accepted: false, canonical: null };
  if (!evidence || !evidence.hasPerson) return { accepted: false, canonical };
  if (evidence.labels.size === 0) return { accepted: false, canonical };
  return { accepted: evidence.labels.has(canonical), canonical };
}
