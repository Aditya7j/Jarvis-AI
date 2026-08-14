# Typo Vision Fix Report — `what am i weaing` No Longer Falls to a Blind LLM

**Task:** Fix a bug where a typo in a vision trigger word (`what am i weaing`) was not
recognized as a vision request and, worse, the plain conversational model fabricated
an "activating screen monitoring and camera access" narrative describing the user's
appearance despite having no camera.

**Status:** Implemented, verified (unit + live probe), all suites green.

---

## 1. Root cause (Phase 1)

Two independent defects turned one typo into a fabricated-camera reply:

| # | Defect | Location | Effect |
|---|---|---|---|
| 1 | Vision intent matching was **exact regex only** — no typo tolerance for `wearing`/`holding`/etc. | `src/lib/ai/vision-intent.ts` (`STRONG`/`WEAK_PATTERNS`) | `what am i weaing` → `classifyVisionIntent` = `"text"` → `reasoning` class → **real vision pipeline never invoked** |
| 2 | The reasoning path ran the LLM with **no OS ruleset at all** | `src/services/chat/pipeline.ts` + `src/lib/ai/provider.ts:265-275` | `withSystemContext(messages, [languageBlock, awarenessBlock])` always produced a system message, so the provider's auto-inject of `DEFAULT_SYSTEM_PROMPT` never fired → the model answered unconstrained and role-played a camera it never opened |

### Why two different answers appeared across runs
Both wrong answers ("Okay, I'm activating my screen monitoring and camera access…
dark t-shirt and jeans…" and "Yes, I can see you.") came from the **same reasoning-LLM
fallback path** (the vision path is unreachable for a non-matching typo). They differ
only because LLM generation is non-deterministic. "Yes, I can see you." was the model's
own words — the vision-cache string could not have fired, because the vision pipeline
never ran.

### Routing chain confirmed
`src/lib/ai/client.ts:197` calls `classifyVisionIntent(prompt)` to gate frame
attachment → `src/services/planner/planner.ts:141` re-runs the same function to choose
the `vision` class. Both use the **same** function, so one fix in
`vision-intent.ts` corrects client and server routing together. For any prompt reaching
the reasoning path, `options.vision.state` is `"off"` with zero frames.

## 2. Fixes

### Fix A — typo-tolerant vision routing (one edit + question frame)
`src/lib/ai/vision-intent.ts` (allowed)

- Added `damerauLevenshtein` (optimal string alignment): a transposition counts as one
  edit, so `waering`→`wearing` and `holdign`→`holding` are distance 1.
- Added `TYPO_VISION_WORDS` (length ≥ 6, same words `WEAK_PATTERNS` already routes):
  `wearing, holding, clothes, clothing, jacket, hoodie, glasses, screen, monitor,
  outfit, camera`.
- Added `VISION_QUESTION_FRAMES` gate: fuzzy matching only fires inside a self/visual
  question (`what am i …`, `what is on my …`, `am i …`, `how many …`, …).
- `hasTypoVisionQuery` = frame matches **and** some word within Damerau distance ≤ 1 of a
  trigger word → `vision`.

This catches `weaing`, `waering`, `holdin`, `holdign`, `wearingg`, `moniter` → vision,
while statements with near-miss words stay text:
`I have a hearing problem`, `what is the housing market like`, `which singh always give
the full name`.

### Fix B.1 — capability-honesty rule in the OS ruleset
`src/lib/ai/prompts.ts` (allowed) — added **rule 9** to `DEFAULT_SYSTEM_PROMPT`:
only claim tools/sensors whose verified output is actually present as a
"Verified data"/vision block; never claim to have activated/accessed/used a camera,
screen, mic, sensor, or tool not provided; never say you can see the user or describe
their clothing/appearance/surroundings/screen without a verified vision block; never
narrate switching on hardware; say so honestly in one line.

### Fix B.2 — reasoning path now runs under the full ruleset + no-camera backstop
`src/services/chat/pipeline.ts` (allowed)

- The reasoning-path system context now starts with `DEFAULT_SYSTEM_PROMPT`, so rule 9
  binds the conversational model even when an awareness block is present.
- Backstop: when `options.vision.state !== "live"` and zero frames and
  `classifyVisionAdjacent(q)` is true, `buildNoCameraSystemContext()` is appended — the
  model is told it has no visual information and must answer with the exact
  `VISION_UNCERTAIN_REPLY` for anything visible. `classifyVisionAdjacent`
  (also in `vision-intent.ts`) is deliberately broad — over-matching only adds an honest
  note, it never hijacks routing.

## 3. Verification

### Automated
- `tests/vision-intent.test.ts` — typo cases → `vision`; near-miss statements → `text`;
  `classifyVisionAdjacent` behaviour.
- `tests/golden-routing.test.ts` — `H_VISION` extended with 4 typo cases (must route
  `vision`).
- `tests/typo-vision-regression.test.ts` (new, 8 tests) — end-to-end:
  - typo with camera off → plan intent `vision`, source `vision`, honest no-camera
    reply, **model never invoked** (throwing fake model);
  - reasoning path system message contains `DEFAULT_SYSTEM_PROMPT` incl. rule 9;
  - backstop fires for `describe my room layout` (text + adjacent) — model receives
    `buildNoCameraSystemContext()`;
  - backstop does not fire for plain conversation (`tell me a joke`).

### Live probe (camera off, deterministic, `llmCalls: 0`)
`what am i weaing` × 3, each run:
```
intent: "vision" | source: "vision" | reply: "I can't see your camera feed — no camera
or screen source is connected. Turn one on and ask me again."
```
The LLM (a model that throws if called) was never invoked — the reply is the direct
no-camera text, identical across all three runs.

### Full gates
- `npx vitest run` → **47 files passed | 4 skipped**, **1381 tests passed | 5 skipped**
  (baseline was 46/4 and 1365/5; +16 from the new regression file)
- `npx tsc --noEmit` → clean
- `npx next lint` → no warnings or errors

## 4. Non-goals / intentionally unchanged
- `which singh always give the full name` (fabricated biography) — logged as a separate
  issue, not part of this fix.
- Disallowed files untouched: `src/lib/toolkit/web.ts`,
  `src/lib/toolkit/query-normalize.ts`, `src/services/planner/*`,
  `src/lib/vision/hold-grounding.ts`, `src/lib/vision/vision-answer.ts` (verified by
  modification timestamps — none written after today's edits).

## 5. Files changed
| File | Change |
|---|---|
| `src/lib/ai/vision-intent.ts` | Damerau distance, `TYPO_VISION_WORDS`, `VISION_QUESTION_FRAMES`, `hasTypoVisionQuery`, `classifyVisionAdjacent` |
| `src/lib/ai/prompts.ts` | Rule 9 in `DEFAULT_SYSTEM_PROMPT` (reuses existing `buildNoCameraSystemContext`) |
| `src/services/chat/pipeline.ts` | Reasoning context starts with `DEFAULT_SYSTEM_PROMPT`; adjacent backstop injects no-camera context |
| `tests/vision-intent.test.ts` | Typo + near-miss + adjacent coverage |
| `tests/golden-routing.test.ts` | 4 typo cases in `H_VISION` |
| `tests/typo-vision-regression.test.ts` | New end-to-end regression suite |
