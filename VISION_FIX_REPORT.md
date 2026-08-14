# Vision Fix Report — Weak Detector Evidence vs. Correct Held-Object Answers

**Task:** Fix a vision bug where weak/wrong YOLO detector guesses (e.g. earphones
misdetected as a low-confidence `remote`) either got reported directly or vetoed
a better off-vocabulary VLM answer for the held object.

**Status:** Implemented, verified (unit + live), all suites green.

---

## 1. Root cause (Phase 1)

Two symptoms, one root cause: **weak detector evidence was treated as
trustworthy enough to (a) report directly and (b) veto a better answer.**

| Code path | File | Pre-fix behaviour | Failure |
|---|---|---|---|
| Fast cache path | `src/lib/vision/vision-answer.ts` | Any `heldObject` reported directly via `finalize` | `remote@0.70` (consensus of a 0.32 misdetection) shipped to the user with only a hedge — no VLM cross-check |
| VLM grounding gate | `src/lib/vision/hold-grounding.ts` | vlm-only tier required `evidence.labels.size === 0` | A correct VLM `earphones` was auto-rejected whenever the detector had *any* label (even a 0.32 false positive) → chat fell back to `"I can't identify the object clearly..."` |

The reported live state being fixed:
```
ROI consensus 2/3  -> 'remote'@0.32 (raw)  -> heldObject 'remote'@0.70
True answer        -> EARPHONES (off-vocabulary; YOLO cannot detect them)
```

## 2. Exact diffs + confidence-threshold reasoning

### Fix 1 — fast cache path escalates on the uncertain band
`src/lib/vision/vision-answer.ts:221-245`

Before:
```ts
if (held) {
  const confidence = Math.round(held.confidence * 100);
  return finalize(`You're holding ${...}.`, confidence);   // any band reported directly
}
return { text: "I can't identify...", needsGemma: true, escalation: "holding", ... };
```

After:
```ts
if (held && confidenceBand(held.confidence * 100) === "high") {
  const confidence = Math.round(held.confidence * 100);
  return finalize(`You're holding ${...}.`, confidence);
}
return { text: "I can't identify the object clearly from the current frame.",
         confidence: 55, needsGemma: true, escalation: "holding", fromCache: false };
```

**Threshold reasoning:** the boundary is the shared `confidenceBand()` at
`CONFIDENCE_HIGH = 80` (`src/lib/vision/confidence.ts:10`). Only the band the
rest of the system already treats as "answer directly" (≥80%) is reported
without a check — no added latency for the common correct case. The uncertain
band (70–79) and no-held-object now run **ONE** bounded focused VLM call through
the existing `analyzeAndCachePlan` machinery (no parallel path):
`answer.escalation="holding"` → vision-manager gemma branch → hand-region crop +
evidence → grounded direct text. The low band (<70) is unreachable for a
reported object because `pickHeldObject` floors at
`HELD_REPORT_CONFIDENCE = 0.7` (`hold-grounding.ts:79,174,186`), so the prior
"reposition" text is preserved vacuously.

### Fix 2 — vlm-only gate is confidence-aware
`src/lib/vision/hold-grounding.ts:375-384, 419-443`

Before: vlm-only tier required `evidence.labels.size === 0`; any label blocked it.

After:
```ts
function evidenceHasStrongLabels(evidence: HeldObjectEvidence): boolean {
  if (!evidence.labelConfidence) return evidence.labels.size > 0;   // legacy = strong (original behaviour)
  for (const label of evidence.labels) {
    const confidence = evidence.labelConfidence.get(label);
    if (confidence === undefined || confidence >= HELD_MAIN_CONFIDENCE) return true;
  }
  return false;
}
// gate in groundHeldVlmTiered:
if (evidenceHasStrongLabels(evidence)) {
  return { accepted: false, canonical: null, tier: null, reason: "blocked by strong detector evidence" };
}
```

**Threshold reasoning:** the strong/weak boundary is `HELD_MAIN_CONFIDENCE =
0.35` — the *same* bar this file already uses to trust a main-pass detector
observation immediately (`hold-grounding.ts:166`). Evidence below 0.35 is, by
the file's own rule, not trustworthy enough to report on its own, so it can no
longer veto a better answer. Evidence ≥0.35 continues to hard-block the
off-vocab tier, keeping the "notebook" case closed (COCO labels still only pass
the detector-grounded tier, regardless of weak/strong). Verdict reasons are
explicit and debuggable:
`"blocked by strong detector evidence"` / `"blocked by no VLM certainty"` /
`"blocked by non-specific reasoning"` / `"label not plausible"` /
`"vlm-only, weak conflicting evidence"` / `"vlm-only, no detector evidence"`.

### Supporting changes (same session)
- `src/lib/ai/prompts.ts:182-220` — `buildFocusedHoldingPrompt` has three
  branches (no evidence / weak / strong) mirroring the tier logic; weak evidence
  is flagged `LOW confidence — these may be false positives`.
- `src/lib/vision/vision-manager.ts` — `heldEvidenceFrom` carries per-label
  confidence; the escalation carries `heldCrop` + `evidence`.
- `src/services/chat/vision.ts:324-350,398-433` — `analyzeFocusedFrame` grounds
  via `groundHeldVlmTiered` and logs `[VisionProof]` with evidence, confidence
  and verdict reason; vlm-only answers render with the hedge and are capped
  below `CONFIDENCE_MID`.

## 3. Phase 1 log evidence — before vs after (both code paths)

Reproduction on the exact reported state (`remote@0.32` evidence →
`heldObject remote@0.70`). "After" = real production functions; "Before" =
faithful pre-fix branch emulation, identical inputs.
Log: `%TEMP%\opencode\vision-before-after.log` (6/6 assertions PASS).

```
>>> PATH 1 — fast cache path ("what am I holding?")
BEFORE: user sees "You're holding a remote. — I'm not completely sure, it isn't fully clear."
        needsGemma=false            (weak misdetection ships directly, no VLM cross-check)
AFTER : returned "I can't identify the object clearly from the current frame."
        needsGemma=true escalation="holding"    -> ONE focused VLM call on the hand-region crop

>>> PATH 1b — high band unchanged (heldObject remote@0.88)
AFTER : "You're holding a remote." needsGemma=false   (0 VLM calls)

>>> PATH 2 — vlm-only gate (VLM "earphones" certain + specific, same weak evidence)
BEFORE: labels.size=1 > 0 -> REJECTED  (correct answer vetoed by a 0.32 false positive;
        chat falls back to "I can't identify the object clearly from the current frame.")
AFTER : accepted=true tier=vlm-only reason="vlm-only, weak conflicting evidence"
        user sees: "It looks like you're holding earphones — I can't fully confirm that
        with my object detector, but that's what I can see."

>>> PATH 2b — strong evidence still blocks / notebook still closed
remote@0.50 (>= 0.35) + "earphones" -> accepted=false reason="blocked by strong detector evidence"
remote@0.50 + "notebook"            -> accepted=false canonical=book reason="label not observed by detector"
```

## 4. Live probe — real YOLO (yolov8n.onnx, ONNX CPU) + real gemma3:4b (Ollama)

Fresh run 2026-08-14, 4/4 tests passed (111.9s). Log:
`%TEMP%\opencode\vision-live-probe-v2.log` (original run kept at
`%TEMP%\opencode\vision-live-probe.log`). All results reproduced from the
original run.

**Scenario A — earphones, 3x back-to-back** (reported weak `remote@0.32`
evidence injected; person is pre-established tracker state; real detector on the
synthetic earphones frame: `main-pass: none`, `roi-pass: stop sign@0.851` —
not a small class, so no eligible evidence):
```
A#1 [fast-path] held=remote@0.70 -> ESCALATE
    [vlm] gemma3:4b (43897ms): held=null certain=false
          "The person's hands are not clearly holding any object."
    [verdict] accepted=false reason="blocked by no VLM certainty"
    [final]   I can't identify the object clearly from the current frame.
A#2 [vlm] (4117ms): held=null certain=false -> same verdict -> honest decline
A#3 [vlm] (4050ms): held=null certain=false -> same verdict -> honest decline
```
Guarantee held 3/3: **never a confident "remote"** — the weak evidence neither
shipped directly nor vetoed anything; the VLM's honest uncertainty reached the
user.

**Scenario B — gate confidence boundary (real `groundHeldVlmTiered`):**
```
B-weak   remote@0.32 (< 0.35) + VLM "earphones" -> accepted=true  tier=vlm-only  reason="vlm-only, weak conflicting evidence"
B-strong remote@0.50 (>= 0.35) + VLM "earphones" -> accepted=false reason="blocked by strong detector evidence"
```

**Scenario C — real phone, 2x** (real YOLO main-pass `cell phone@0.544/0.419`
both in the hand region → uncertain band; ROI `cell phone@0.901`):
```
C#1-2 [fast-path] held=cell phone@0.70 -> ESCALATE (holding)
      [vlm] gemma3:4b (~4s each): held=cell phone certain=true
      [verdict] accepted=true canonical=cell phone tier=detector reason="detector evidence"
      [final]   You're holding a cell phone.     (2/2)
```

**Scenario D — the REAL saved live frame** (`debug/debug-frame.jpg`,
`person@0.898 | remote@0.381`):
```
[D] hand region {"x":92,"y":99,"width":403,"height":298}
    held candidates: none -> pickHeldObject -> null
[D] [fast-path] held=null -> ESCALATE
    [vlm] gemma3:4b (49238ms): held=null certain=false "The hands are not clearly
          holding any discernible object."
    [verdict] accepted=false reason="no VLM label"
    [final]   I can't identify the object clearly from the current frame.
```

## 5. Test / typecheck / lint

```
Full suite:   Test Files 46 passed | 4 skipped (50) · Tests 1365 passed | 5 skipped (1370) · 27s
typecheck:    npx tsc --noEmit  ->  clean
lint:         npx next lint     ->  ✔ No ESLint warnings or errors
```

Regression tests added (`tests/hold-grounding.test.ts`,
`tests/vision-vlm.test.ts`):
- earphones misdetected as weak `remote@0.32` → hedged earphones, never a
  confident "remote";
- strong `remote@0.88` → reported directly, **0 VLM calls**;
- notebook hallucination (incl. weak conflicting evidence) → still rejected;
- weak ambiguous COCO detection (`remote@0.72` uncertain band) → escalates,
  VLM answer/uncertainty is what the user sees.

## 6. Disallowed-files check

`src/lib/toolkit/web.ts`, `src/lib/toolkit/query-normalize.ts`, and
`src/services/planner/*` were **not modified** — their last-write timestamps
predate this work (08-13 or earlier) while all changed vision files are 08-14.

## 7. File inventory

| File | Change |
|---|---|
| `src/lib/vision/vision-answer.ts` | Fix 1: direct answer only on the high band; else `escalation:"holding"` |
| `src/lib/vision/hold-grounding.ts` | Fix 2: `evidenceHasStrongLabels` + confidence-aware vlm-only gate |
| `src/lib/ai/prompts.ts` | `buildFocusedHoldingPrompt` weak/strong/no-evidence branches |
| `src/lib/vision/vision-manager.ts` | per-label `labelConfidence` evidence in the holding escalation |
| `src/services/chat/vision.ts` | hedged vlm-only text, `<70` cap, `[VisionProof]` logs |
| `src/lib/vision/detect/coco-classes.ts` | `SMALL_OBJECT_CLASSES` support (from prior tiered-holding work) |
| `tests/hold-grounding.test.ts`, `tests/vision-vlm.test.ts` | regression tests |

Temporary probe files (`tests/probe-live-vision.test.ts`,
`scripts/probe-frames.ts`, `scripts/probe-vlm-smoke.ts`,
`scripts/probe-before-after.ts`) were created for evidence and then removed;
the tree is clean.
