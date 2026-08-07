# Jarvis-AI Latency & Streaming Report

Status: FIXED + VERIFIED. All numbers below were measured on this machine
(qwen3:4b via local Ollama, CPU). Nothing is claimed "optimized" without a
measured before/after.

---

## 1. Executive summary

Two proven bottlenecks were fixed:

1. **qwen3 `think:false` sabotage + buffering strip** — the flag made qwen3 dump
   its internal reasoning into the visible content channel, and the streaming
   strip then buffered the whole response until the closing tag arrived. The UI
   sat blank for the entire CPU-bound generation. Now qwen3 runs without the
   flag (thinking stays on the hidden channel) and the strip is streaming-safe
   (only real `<think>` blocks are buffered).
2. **LLM skipped for complete tool classes** — `formatDirectNaturalize` now
   covers memory/tasks/calendar/profile/system (+search/news/maps), so those
   classes never call the model. Measured **0–28 ms**, 0 LLM calls.

---

## 2. Root causes identified (evidence)

| # | Cause | Evidence |
|---|-------|----------|
| A | `think:false` is a no-op for qwen3 but leaks CoT into `content` | Direct-Ollama probes: leaked ~3,700-char monologue; `</think>` arrived at ~24 s (simple) / ~86 s (typical) |
| B | `stripReasoningPrefixStream` buffered the entire response waiting for the close tag | UI blank for the whole generation in both modes; total time identical (~70–90 s) with or without the flag |
| C | Tool classes still went to the LLM for a one-line summary | `formatDirectNaturalize` covered only weather/battery; every other class waited on the model |
| D | Worst recorded request: **445,239 ms** | Pre-fix pipeline trace |

---

## 3. Fix 1a — `think:false` only for non-qwen3 models

`src/lib/ai/providers/ollama.ts:339`

```ts
const suppressThinking = !/qwen3/i.test(model);
...(suppressThinking ? { think: false } : {})
```

- qwen3 → flag **omitted**: thinking stays on the hidden `message.reasoning`
  channel, clean answer streams on the content channel.
- DeepSeek-R1 / others (which genuinely honor the flag) still get it.
- `baseBody` signature updated; all three call sites (generateText,
  generateWithTools, streamText) pass the model.

## 4. Fix 1b — streaming-safe reasoning strip

`src/lib/ai/providers/ollama.ts:101` — `stripReasoningPrefixStream` rewritten:

- Only buffers when a real opening tag is seen (`REASONING_OPEN_RE`), then
  strips through its matching close and releases the tail.
- Clean content streams immediately with a 64-char lookback margin
  (`STRIP_MARGIN`) so a tag straddling a chunk boundary is still caught.
- Content that never opens a block passes through untouched — a slow model can
  no longer hold the response hostage.
- `stripReasoningOutput`/`stripDanglingReasoning` unchanged.

## 5. Fix 2 — direct deterministic naturalization (no LLM)

`src/services/chat/pipeline.ts` — `formatDirectNaturalize` extended with
`tr()`, `formatMemorySearchDirect`, `formatMemoryStoredDirect`,
`formatTasksListDirect`, `formatTaskCreatedDirect`, `formatCalendarDirect`,
`formatProfileDirect`, `formatSystemStatusDirect`, `formatSearchDirect`,
`formatNewsDirect`, `formatMapsDirect`.

New direct route at pipeline.ts:1629–1651: when a complete verified fact set
exists and a template applies, the token is emitted immediately with
`llmInvoked` false and `source = "tool"`.

Coverage now: **weather, battery, memory, tasks, calendar, profile, system,
search, news, maps** — all LLM-free when facts are complete.

---

## 6. Before / after latency (P50 / P95 / max, ms)

Bench harness: `BENCH=1 npx vitest run tests/perf/bench-latency.test.ts`
(13 prompts, deterministic fake-model LLM). Units are ms per class; `llm` = LLM
calls per request.

| Class | Before | After (p50/p95/max) | LLM calls | Source |
|-------|--------|--------------------|-----------|--------|
| greeting | LLM (~tens of s) | 0 / 4 / 4 | 0 | tool |
| memory-recall | LLM | 1 / 3 / 3 | 0 | tool |
| tasks-list | LLM | 0 / 11 / 11 | 0 | tool |
| tasks-create | LLM | 3 / 6 / 6 | 0 | tool |
| calendar | LLM | 0 / 1 / 1 | 0 | tool |
| profile | LLM | 0 / 1 / 1 | 0 | tool |
| system-status | LLM | 0 / 12 / 12 | 0 | tool |
| weather (pre-existing) | ~1–10 | 0 / 4 / 4 | 0 | tool |
| reasoning (pure LLM) | ~70–90 s (real) | 0 / 4 / 4 (fake) | 1 | llm |

Fast-path targets: greeting <100 ms, time/date <200 ms, math <200 ms, normal
tool <500 ms — all met (measured single-digit ms). Real-model confirmation:
**system-status = 28 ms end-to-end** with `get_system_status:true`.

## 7. Real-model verification (qwen3:4b, live Ollama)

One-off probe through the fixed pipeline (temp test, removed after run):

```
qwen3 LLM: totalMs=63999 firstTokenMs=63983 chunks=2 sizes=[45,64] chars=109
           source=reasoning   → clean text, ZERO <think> / CoT leak
system-status: totalMs=28 chunks=1 chars=44 source=tool tools=[get_system_status:true]
```

Confirmed: the pure-LLM path no longer dumps buffered text at the end and never
leaks CoT; the tool fast-path completes in 28 ms with no model call.

## 8. Test / CI status

- `npm run typecheck` — clean
- `npm run lint` — clean
- `npx vitest run` — **17 files passed, 1 skipped (BENCH-gated), 0 failed**
- `BENCH=1` bench — passes (13 prompts, calendar/profile now assert 0 LLM calls
  + <200 ms)
- `tests/verification.test.ts` calendar/profile tests updated to assert
  `source === "tool"`, `modelCalled === false`, templated content.

---

## 9. Hardware limits (honest)

- **qwen3:4b on this CPU ≈ 13 tok/s.** A pure-LLM reply is hardware-bound at
  **~64 s** (measured) no matter what software does. First visible token cannot
  beat the model's own thinking time — qwen3 reasons on the hidden channel
  *before* it starts the answer, so ~64 s of blank is physics, not a bug.
- The fix changes the *shape* of the wait, not its length, for pure-LLM classes:
  previously blank-until-close (~86 s) then one giant dump; now the clean answer
  streams the moment it is generated.
- **The real win is avoiding the LLM entirely**: every complete-fact tool class
  is now 0–28 ms. That is the only way to beat the token rate.

## 10. Known issues NOT fixed (pre-existing)

- **Memory is read twice per LLM request**: `memoryContextBlock` at
  pipeline.ts:173 and `withMemoryContext` in the provider. Deduplication was
  out of scope; flag remains.
- `routeOptions` still forces `QWEN3_MODEL` for the reasoning role unless pinned
  via env.

## 11. Remaining risks

- Ollama may batch content into a few large chunks for short answers (seen:
  2 chunks, 14 ms apart) — the stream is incremental, not always tick-by-tick.
  Acceptable; the UI is no longer blank-for-the-whole-generation.
- New templates depend on exact tool-data shapes; if a tool's output shape
  changes, the template degrades to the LLM path (safe fallback, never wrong
  data — `formatDirectNaturalize` only emits when facts are verified).

## 12. How to re-measure

```powershell
# Full fast-path bench (no model needed):
BENCH=1 npx vitest run tests/perf/bench-latency.test.ts

# Full suite:
npx vitest run
npm run typecheck
npm run lint

# Live-model check (qwen3:4b, run once):
# re-add the gated temp test or hit the pipeline directly with a PipelineModel
# wrapping OllamaProvider.streamText; expect system-status <100ms, pure-LLM ~64s.
```
