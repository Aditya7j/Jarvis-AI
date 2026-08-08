import { describe, it, expect } from "vitest";
import {
  pickHeldObject,
  voteHeld,
  qualifyHeldCandidates,
  normalizeObjectAlias,
  groundHeldVlmResult,
  HELD_REPORT_CONFIDENCE,
  type HeldCandidate,
} from "@/lib/vision/hold-grounding";

/**
 * Held-object grounding rules.
 *
 * Root causes fixed here:
 *   1. The held object used to be the single highest-confidence ROI detection of
 *      ONE frame — a mug sitting on the desk could beat a phone held outside the
 *      ROI crop, and no temporal consensus existed. Desk/floor-strip detections
 *      are now never "held", and hands-zone detections need 2-of-3 consensus
 *      (main-pass in-hand detections still win immediately).
 *   2. The focused VLM answered from the whole frame with no detector evidence,
 *      so it invented "notebook" / "coffee mug" objects YOLO never saw. Its
 *      answer is now accepted only when it matches the detector's hand-region
 *      observations of the same frame (evidence is restricted to qualified
 *      hands-zone detections).
 *   3. The old uniform 0.45 confidence floor discarded real low-confidence held
 *      phones (0.2-0.45) that the ROI pass exists to surface. Floors are now
 *      zone-aware, and a consensus-established held object is reported at
 *      >= 70% so the cache answer hedges honestly instead of downgrading.
 */
const main = (label: string, confidence = 0.7, extra: Partial<HeldCandidate> = {}): HeldCandidate => ({
  label,
  confidence,
  source: "main",
  inHandRegion: true,
  ...extra,
});
const roi = (label: string, confidence = 0.6, extra: Partial<HeldCandidate> = {}): HeldCandidate => ({
  label,
  confidence,
  source: "roi",
  inHandRegion: true,
  ...extra,
});

describe("pickHeldObject — main-pass evidence wins immediately", () => {
  it("a small object detected in the hand region by the main pass is held", () => {
    const votes = new Map<string, number>();
    const pick = pickHeldObject([main("cell phone", 0.71)], votes);
    expect(pick).toEqual({
      label: "cell phone",
      confidence: 0.71,
      source: "main",
    });
  });

  it("a main-pass phone beats a higher-confidence ROI mug in the same frame", () => {
    const votes = new Map<string, number>();
    const pick = pickHeldObject([main("cell phone", 0.6), roi("cup", 0.9)], votes);
    expect(pick?.label).toBe("cell phone");
  });

  it("a desk object outside the hand region is never held", () => {
    const votes = new Map<string, number>();
    const pick = pickHeldObject(
      [{ label: "cup", confidence: 0.9, source: "main", inHandRegion: false }],
      votes
    );
    expect(pick).toBeNull();
  });
});

describe("pickHeldObject — ROI detections need 2-of-3 temporal consensus", () => {
  it("a single-frame ROI detection is rejected (mug on the desk)", () => {
    const votes = new Map<string, number>();
    expect(pickHeldObject([roi("cup", 0.9)], votes)).toBeNull();
  });

  it("an ROI object seen on two consecutive frames is accepted", () => {
    const votes = new Map<string, number>();
    expect(pickHeldObject([roi("cup", 0.8)], votes)).toBeNull(); // vote 1
    const pick = pickHeldObject([roi("cup", 0.8)], votes); // vote 2
    expect(pick?.label).toBe("cup");
  });

  it("a label that disappears decays and never reaches consensus", () => {
    const votes = new Map<string, number>();
    pickHeldObject([roi("book", 0.8)], votes); // vote 1
    pickHeldObject([], votes); // decay 1
    expect(pickHeldObject([roi("book", 0.8)], votes)).toBeNull(); // back to 1
  });

  it("a single-frame phone + long-standing mug consensus: phone wins fresh evidence", () => {
    const votes = new Map<string, number>([["cup", 2]]);
    const pick = pickHeldObject([main("cell phone", 0.7)], votes);
    expect(pick?.label).toBe("cell phone");
  });

  it("a desk-strip ROI detection (mug 0.32 on the desk) can never become held", () => {
    const votes = new Map<string, number>();
    const deskMug = roi("cup", 0.32, { inDeskStrip: true });
    pickHeldObject([deskMug], votes);
    pickHeldObject([deskMug], votes);
    pickHeldObject([deskMug], votes);
    expect(pickHeldObject([deskMug], votes)).toBeNull();
    expect(votes.size).toBe(0); // never even votes
  });

  it("a weak hands-zone ROI phone (0.32) becomes held after 2-of-3 consensus", () => {
    const votes = new Map<string, number>();
    expect(pickHeldObject([roi("cell phone", 0.32)], votes)).toBeNull(); // vote 1
    const pick = pickHeldObject([roi("cell phone", 0.32)], votes); // vote 2
    expect(pick?.label).toBe("cell phone");
  });

  it("a low-confidence main-pass detection (0.32) is not held on a single frame", () => {
    const votes = new Map<string, number>();
    expect(pickHeldObject([main("cup", 0.32)], votes)).toBeNull();
  });
});

describe("pickHeldObject — reported confidence floor", () => {
  it("a consensus-established weak detection is reported at >= 70%", () => {
    const votes = new Map<string, number>();
    pickHeldObject([roi("cell phone", 0.32)], votes);
    const pick = pickHeldObject([roi("cell phone", 0.32)], votes);
    expect(pick?.label).toBe("cell phone");
    expect(pick?.confidence).toBeGreaterThanOrEqual(HELD_REPORT_CONFIDENCE);
  });

  it("a strong main-pass in-hand detection keeps its high confidence", () => {
    const votes = new Map<string, number>();
    const pick = pickHeldObject([main("cell phone", 0.85)], votes);
    expect(pick?.confidence).toBe(0.85);
  });
});

describe("qualifyHeldCandidates — evidence is restricted to hands-zone detections", () => {
  it("keeps only small-class hands-zone detections above the confidence floor", () => {
    const input: HeldCandidate[] = [
      { label: "cell phone", confidence: 0.5, source: "roi", inHandRegion: true },
      { label: "laptop", confidence: 0.9, source: "roi", inHandRegion: true }, // not small-class
      { label: "cell phone", confidence: 0.1, source: "roi", inHandRegion: true }, // below floor
      { label: "cup", confidence: 0.6, source: "roi", inHandRegion: true, inDeskStrip: true }, // desk strip
      { label: "book", confidence: 0.6, source: "main", inHandRegion: false }, // not in hand region
    ];
    expect(qualifyHeldCandidates(input).map((c) => c.label)).toEqual(["cell phone"]);
  });

  it("a desk-strip detection never qualifies for evidence, even at high confidence", () => {
    const desk = roi("cup", 0.9, { inDeskStrip: true });
    expect(qualifyHeldCandidates([desk])).toEqual([]);
  });
});

describe("voteHeld", () => {
  it("increments the winner, decays others, prunes at zero", () => {
    const votes = new Map<string, number>([["cup", 2]]);
    voteHeld(votes, "cell phone");
    expect(votes.get("cell phone")).toBe(1);
    expect(votes.get("cup")).toBe(1);
    voteHeld(votes, "cell phone");
    voteHeld(votes, "cell phone");
    expect(votes.get("cell phone")).toBe(3);
    expect(votes.has("cup")).toBe(false);
  });
});

describe("normalizeObjectAlias", () => {
  it("maps free-form phrasing onto canonical COCO labels", () => {
    expect(normalizeObjectAlias("phone")).toBe("cell phone");
    expect(normalizeObjectAlias("iPhone")).toBe("cell phone");
    expect(normalizeObjectAlias("smartphone")).toBe("cell phone");
    expect(normalizeObjectAlias("mug")).toBe("cup");
    expect(normalizeObjectAlias("coffee mug")).toBe("cup");
    expect(normalizeObjectAlias("notebook")).toBe("book");
    expect(normalizeObjectAlias("notepad")).toBe("book");
    expect(normalizeObjectAlias("wristwatch")).toBe("clock");
  });

  it("returns null for unknown or empty phrasings", () => {
    expect(normalizeObjectAlias(null)).toBeNull();
    expect(normalizeObjectAlias("")).toBeNull();
    expect(normalizeObjectAlias("  ")).toBeNull();
    expect(normalizeObjectAlias("a random object")).toBeNull();
  });
});

describe("groundHeldVlmResult — the VLM may only name what the detector saw", () => {
  const phoneEvidence = {
    labels: new Set(["cell phone"]),
    region: { x: 30, y: 140, width: 140, height: 260 },
    hasPerson: true,
  };

  it("accepts a phone the detector observed in the hand region", () => {
    const verdict = groundHeldVlmResult("phone", phoneEvidence);
    expect(verdict).toEqual({ accepted: true, canonical: "cell phone" });
  });

  it("rejects a notebook the detector never observed (the bug)", () => {
    const verdict = groundHeldVlmResult("notebook", phoneEvidence);
    expect(verdict).toEqual({ accepted: false, canonical: "book" });
  });

  it("rejects any label when the detector observed nothing in the hand region", () => {
    const empty = { labels: new Set<string>(), region: null, hasPerson: true };
    const verdict = groundHeldVlmResult("coffee mug", empty);
    expect(verdict.accepted).toBe(false);
  });

  it("rejects any label when no person is tracked", () => {
    const noPerson = { labels: new Set(["cell phone"]), region: null, hasPerson: false };
    const verdict = groundHeldVlmResult("phone", noPerson);
    expect(verdict.accepted).toBe(false);
  });

  it("rejects a null VLM value and unknown labels", () => {
    expect(groundHeldVlmResult(null, phoneEvidence).accepted).toBe(false);
    expect(groundHeldVlmResult("blob", phoneEvidence).accepted).toBe(false);
  });

  it("handles no evidence at all", () => {
    expect(groundHeldVlmResult("phone", null).accepted).toBe(false);
  });
});
