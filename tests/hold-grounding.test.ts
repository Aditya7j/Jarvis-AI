import { describe, it, expect } from "vitest";
import {
  pickHeldObject,
  voteHeld,
  qualifyHeldCandidates,
  normalizeObjectAlias,
  groundHeldVlmResult,
  groundHeldVlmTiered,
  plausibleHeldLabel,
  reasoningIsSpecific,
  HELD_REPORT_CONFIDENCE,
  type HeldCandidate,
} from "@/lib/vision/hold-grounding";
import { SMALL_OBJECT_CLASSES } from "@/lib/vision/detect/coco-classes";

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

  it("recognizes exact COCO class names as their own canonical label", () => {
    expect(normalizeObjectAlias("backpack")).toBe("backpack");
    expect(normalizeObjectAlias("handbag")).toBe("handbag");
    expect(normalizeObjectAlias("tie")).toBe("tie");
    expect(normalizeObjectAlias("umbrella")).toBe("umbrella");
    expect(normalizeObjectAlias("suitcase")).toBe("suitcase");
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

describe("SMALL_OBJECT_CLASSES — everyday carry COCO classes", () => {
  it("now includes backpack, handbag, tie, umbrella and suitcase", () => {
    for (const label of ["backpack", "handbag", "tie", "umbrella", "suitcase"]) {
      expect(SMALL_OBJECT_CLASSES.has(label)).toBe(true);
    }
  });

  it("qualifyHeldCandidates admits the newly added classes", () => {
    const candidates: HeldCandidate[] = [
      { label: "backpack", confidence: 0.8, source: "main", inHandRegion: true },
      { label: "umbrella", confidence: 0.6, source: "roi", inHandRegion: true },
      { label: "suitcase", confidence: 0.9, source: "roi", inHandRegion: true, inDeskStrip: true },
    ];
    expect(qualifyHeldCandidates(candidates).map((c) => c.label)).toEqual([
      "backpack",
      "umbrella",
    ]);
  });
});

describe("plausibleHeldLabel — vlm-only sanity signal", () => {
  it("accepts curated everyday items", () => {
    for (const label of ["pen", "pencil", "keys", "wallet", "earbuds", "glasses", "sunglasses", "tablet", "id card", "lighter", "mask", "charger"]) {
      expect(plausibleHeldLabel(label)).toBe(true);
    }
  });

  it("accepts non-COCO free-form labels with a sane shape", () => {
    expect(plausibleHeldLabel("lanyard badge")).toBe(true);
    expect(plausibleHeldLabel("stickers")).toBe(true);
  });

  it("rejects COCO class names — those must stay detector-grounded", () => {
    expect(plausibleHeldLabel("bottle")).toBe(false);
    expect(plausibleHeldLabel("book")).toBe(false);
    expect(plausibleHeldLabel("cell phone")).toBe(false);
  });

  it("rejects empty, absurdly long, or many-word labels", () => {
    expect(plausibleHeldLabel(null)).toBe(false);
    expect(plausibleHeldLabel("")).toBe(false);
    expect(plausibleHeldLabel("   ")).toBe(false);
    expect(plausibleHeldLabel("a")).toBe(false);
    expect(plausibleHeldLabel("m".repeat(50))).toBe(false);
    expect(plausibleHeldLabel("some extremely long object description in view")).toBe(false);
  });
});

describe("reasoningIsSpecific", () => {
  it("accepts concrete justifications", () => {
    expect(reasoningIsSpecific("A pen is clearly visible in the person's right hand.")).toBe(true);
    expect(reasoningIsSpecific("keys visible between the fingers")).toBe(true);
  });

  it("rejects hedged or empty reasoning", () => {
    expect(reasoningIsSpecific("")).toBe(false);
    expect(reasoningIsSpecific("short")).toBe(false);
    expect(reasoningIsSpecific("I think it might be a pen.")).toBe(false);
    expect(reasoningIsSpecific("probably some keys")).toBe(false);
    expect(reasoningIsSpecific("Not sure, could be a pen.")).toBe(false);
  });
});

describe("groundHeldVlmTiered — two-tier grounding", () => {
  const phoneEvidence = {
    labels: new Set(["cell phone"]),
    region: { x: 30, y: 140, width: 140, height: 260 },
    hasPerson: true,
  };
  const emptyEvidence = {
    labels: new Set<string>(),
    region: { x: 30, y: 140, width: 140, height: 260 },
    hasPerson: true,
  };

  it("detector tier: accepts a phone the detector observed in the hand region", () => {
    const verdict = groundHeldVlmTiered("phone", true, "A phone is in the hand.", phoneEvidence);
    expect(verdict).toEqual({ accepted: true, canonical: "cell phone", tier: "detector", reason: "detector evidence" });
  });

  it("detector tier: rejects a notebook the detector never observed (the bug)", () => {
    const verdict = groundHeldVlmTiered("notebook", true, "The person holds a notebook.", phoneEvidence);
    expect(verdict).toEqual({ accepted: false, canonical: "book", tier: null, reason: "label not observed by detector" });
  });

  it("a COCO-class label is never admitted through the vlm-only tier", () => {
    const verdict = groundHeldVlmTiered("notebook", true, "The person clearly holds a notebook.", emptyEvidence);
    expect(verdict).toEqual({ accepted: false, canonical: "book", tier: null, reason: "label not observed by detector" });
  });

  it("detector tier: accepts a newly-added class the detector observed (backpack)", () => {
    const backpackEvidence = {
      labels: new Set(["backpack"]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered("backpack", true, "A backpack is held at the side.", backpackEvidence);
    expect(verdict).toEqual({ accepted: true, canonical: "backpack", tier: "detector", reason: "detector evidence" });
  });

  it("vlm-only: accepts a certain, specific, plausible off-vocab object with empty evidence", () => {
    const verdict = groundHeldVlmTiered("pen", true, "A pen is clearly visible in the person's right hand.", emptyEvidence);
    expect(verdict).toEqual({ accepted: true, canonical: null, tier: "vlm-only", reason: "vlm-only, no detector evidence" });
  });

  it("vlm-only: accepts keys and earbuds", () => {
    expect(groundHeldVlmTiered("keys", true, "Keys are visible in the clenched hand.", emptyEvidence).tier).toBe("vlm-only");
    expect(groundHeldVlmTiered("earbuds", true, "White earbuds hang from the fingers.", emptyEvidence).tier).toBe("vlm-only");
  });

  it("vlm-only: rejects an uncertain VLM even with specific reasoning", () => {
    const verdict = groundHeldVlmTiered("pen", false, "A pen is clearly visible in the person's right hand.", emptyEvidence);
    expect(verdict.accepted).toBe(false);
  });

  it("vlm-only: rejects hedged or too-short reasoning", () => {
    expect(groundHeldVlmTiered("pen", true, "I think it might be a pen.", emptyEvidence).accepted).toBe(false);
    expect(groundHeldVlmTiered("pen", true, "pen.", emptyEvidence).accepted).toBe(false);
  });

  it("vlm-only: rejects when the detector saw a DIFFERENT held object", () => {
    const verdict = groundHeldVlmTiered("keys", true, "Keys are visible in the clenched hand.", phoneEvidence);
    expect(verdict.accepted).toBe(false);
    expect(verdict.tier).toBeNull();
  });

  it("vlm-only: rejects when no person is tracked", () => {
    const noPerson = { labels: new Set<string>(), region: null, hasPerson: false };
    expect(groundHeldVlmTiered("pen", true, "A pen is clearly visible.", noPerson).accepted).toBe(false);
  });

  it("vlm-only: rejects implausible labels", () => {
    expect(groundHeldVlmTiered("something vaguely held in a hazy blur", true, "A pen is clearly visible.", emptyEvidence).accepted).toBe(false);
  });

  it("rejects a null VLM value", () => {
    expect(groundHeldVlmTiered(null, true, "Nothing in hand.", emptyEvidence)).toEqual({
      accepted: false,
      canonical: null,
      tier: null,
      reason: "no VLM label",
    });
  });

  it("vlm-only: weak conflicting evidence (remote@0.32) does NOT block earphones (the bug)", () => {
    const weakRemoteEvidence = {
      labels: new Set(["remote"]),
      labelConfidence: new Map([["remote", 0.32]]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered(
      "earphones",
      true,
      "White earphones are clearly visible in the person's hand.",
      weakRemoteEvidence
    );
    expect(verdict).toEqual({
      accepted: true,
      canonical: null,
      tier: "vlm-only",
      reason: "vlm-only, weak conflicting evidence",
    });
  });

  it("vlm-only: weak conflicting evidence never admits a COCO-class label not observed", () => {
    const weakRemoteEvidence = {
      labels: new Set(["remote"]),
      labelConfidence: new Map([["remote", 0.32]]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered(
      "notebook",
      true,
      "The person clearly holds a notebook.",
      weakRemoteEvidence
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.canonical).toBe("book"); // notebook -> book, still detector-grounded only
    expect(verdict.reason).toBe("label not observed by detector");
  });

  it("detector tier: a weak detector observation the VLM confirms is still accepted", () => {
    const weakRemoteEvidence = {
      labels: new Set(["remote"]),
      labelConfidence: new Map([["remote", 0.32]]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered("remote", true, "A remote is visible in the hand.", weakRemoteEvidence);
    expect(verdict).toEqual({ accepted: true, canonical: "remote", tier: "detector", reason: "detector evidence" });
  });

  it("vlm-only: strong evidence (remote@0.5) still blocks an off-vocab answer", () => {
    const strongRemoteEvidence = {
      labels: new Set(["remote"]),
      labelConfidence: new Map([["remote", 0.5]]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered(
      "earphones",
      true,
      "White earphones are clearly visible in the person's hand.",
      strongRemoteEvidence
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.tier).toBeNull();
    expect(verdict.reason).toBe("blocked by strong detector evidence");
  });

  it("vlm-only: legacy evidence without per-label confidence stays conservative (blocks)", () => {
    // phoneEvidence has no labelConfidence map -> treated as STRONG, so the
    // vlm-only tier stays closed exactly as before this change.
    const verdict = groundHeldVlmTiered("keys", true, "Keys are visible in the clenched hand.", phoneEvidence);
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe("blocked by strong detector evidence");
  });

  it("vlm-only: accepts an ID card when the detector sees nothing (happy path)", () => {
    const verdict = groundHeldVlmTiered(
      "id card",
      true,
      "A white ID card is clearly visible in the person's right hand.",
      emptyEvidence
    );
    expect(verdict).toEqual({
      accepted: true,
      canonical: null,
      tier: "vlm-only",
      reason: "vlm-only, no detector evidence",
    });
  });

  it("vlm-only: strong detector misclassification of ID card as cell phone blocks the VLM answer", () => {
    const cellPhoneEvidence = {
      labels: new Set(["cell phone"]),
      labelConfidence: new Map([["cell phone", 0.45]]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered(
      "id card",
      true,
      "A white ID card is clearly visible in the person's right hand.",
      cellPhoneEvidence
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.tier).toBeNull();
    expect(verdict.reason).toBe("blocked by strong detector evidence");
  });

  it("vlm-only: weak detector misclassification (cell phone at 0.30) does NOT block the VLM ID card answer", () => {
    const weakCellPhoneEvidence = {
      labels: new Set(["cell phone"]),
      labelConfidence: new Map([["cell phone", 0.30]]),
      region: { x: 30, y: 140, width: 140, height: 260 },
      hasPerson: true,
    };
    const verdict = groundHeldVlmTiered(
      "id card",
      true,
      "A white ID card is clearly visible in the person's right hand.",
      weakCellPhoneEvidence
    );
    expect(verdict).toEqual({
      accepted: true,
      canonical: null,
      tier: "vlm-only",
      reason: "vlm-only, weak conflicting evidence",
    });
  });
});
