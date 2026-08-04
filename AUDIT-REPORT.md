# JARVIS-AI Architecture Audit

Date: 2026-08-04. Audit scope: full stack (frontend, Next.js API routes, Fastify sidecar, AI layer, vision, memory, tasks, context).

## 1. Executive summary

JARVIS-AI has **two parallel full-stack implementations that disagree with each other**. The UI only talks to the Next.js process (port 3000). The Fastify sidecar (port 3001) implements a newer, richer pipeline (deterministic intent planner → tool router → memory → CoT sanitizer) but **nothing calls it**. The main `/api/chat` route the UI actually uses is a monolithic legacy path that:

- has **no memory** (forgets everything),
- has **no math/web/news/maps/tasks/unit/currency tools**,
- runs **no chain-of-thought sanitizer**,
- re-classifies intent that the client already classified,
- layers a third vision cache on top of two existing ones.

That is the root cause of "inconsistent behavior": behavior differs depending on which entry point (or which classifier) is hit, and the newer architecture is unreachable from the product.

## 2. How it works today

```
Browser
 ├─ useVoice (wake word) → speechSynthesis / webkitSpeechRecognition
 ├─ conversationManager (client.ts)
 │    ├─ classifyToolIntent(prompt)          ← client-side intent guess
 │    ├─ classifyVisionIntent / Depth(prompt) ← decides frame attach
 │    ├─ browser tools: getSystemClock / getBatteryInfo / requestGeolocation
 │    └─ POST /api/chat (SSE)  →  Next.js :3000
 ├─ visionService → POST /api/vision/live (YOLO loop, 350ms) → Next :3000
 └─ metrics panel  → EventSource /api/metrics/events            → Next :3000

Next.js :3000 (App Router) — what the UI actually uses
 ├─ /api/chat            → monolithic: old intent-router + system-tools +
 │                         vision-manager + Gemma structured analysis +
 │                         own visionCache + SSE framing. NO pipeline.
 ├─ /api/vision/live     → live-vision-engine (YOLO) singleton
 ├─ /api/vision/analyze  → aiService.analyzeCameraFrame (Gemma)
 ├─ /api/stt/transcribe  → whisper CLI / Deepgram
 ├─ /api/tts/speak       → piper
 ├─ /api/metrics/*       → metrics store (globalThis)
 └─ /api/settings/*, /api/owner/*, /api/models/*, /api/health/*

Fastify :3001 (sidecar) — orphaned, nothing in the UI calls it
 ├─ /api/assistant/message → runPipeline (new architecture, unused)
 ├─ /api/conversation/*    → THIRD hand-rolled intent resolver
 ├─ /api/vision/analyze|ocr→ duplicate of Next route (dead)
 ├─ /api/stt/transcribe    → duplicate of Next route (dead)
 ├─ /api/tts/speak         → duplicate of Next route (dead)
 └─ /health
```

### The "new" pipeline (unused by UI)
`src/services/chat/pipeline.ts` — Context Engine → Intent Planner (`classifyPlanIntent`) → Tool Router (`src/services/tools/*`, timeout+retry+cache) → Memory Engine → Reasoning (`CoTFilter` streaming sanitizer). Supports 14+ intents incl. calculator, unit-conversion, currency, web-search, news, maps, memory, tasks, system-status.

## 3. Core problems (ranked)

| # | Problem | Files | Impact |
|---|---------|-------|--------|
| 1 | Main chat path has **no memory** | `src/app/api/chat/route.ts` never touches `memoryService`; `buildOwnerContext/appendMemoryContext` only used by pipeline path | JARVIS forgets everything in the UI; the memory feature works only in the unused Fastify path |
| 2 | **Three chat backends**, two classifiers | `/api/chat` (old `intent-router`), `/api/assistant` (planner), `/api/conversation` (own resolver) | Same prompt → different routing depending on entry point. "2+2" = LLM on main path, `calculate` tool on pipeline path |
| 3 | **Two tool registries** | `src/lib/ai/tools.ts` (4 memory/time tools, string-JSON output, used by `provider.ts:770`) vs `src/services/tools/*` (8+ tools, structured, used by pipeline + tasks) | Divergent tool behavior; provider function-calling uses the wrong/older registry; main path passes **no tools at all** so both are unreachable from the UI |
| 4 | **Client/server intent duplication** | `client.ts:174` runs `classifyToolIntent` + `classifyVisionIntent/Depth`, then `route.ts:356` runs them again | Two regex engines with drift risk; client guesses intent the server re-derives |
| 5 | **No CoT sanitizer on main path** | `CoTFilter`/`sanitizeFinalAnswer` only in `pipeline.ts`; `/api/chat` streams `aiService.streamText` raw | If a reasoning model emits `<thinking>` tags they leak to the UI on the main path |
| 6 | **No tasks/math/web/maps/news/unit tools on main path** | main path only: system-clock, geolocation, battery, weather, vision | "remind me", "search the web", "how many ounces in a liter" all fall to the bare LLM |
| 7 | **Three layered vision caches** | `vision-state` (YOLO, globalThis), `vision-manager` Scene Cache (300ms freshness), chat route's own `visionCache` + `cachedVisionPlan` (1s + 250ms skew) + `activeVisionController` | Conflicting freshness rules, redundant analysis, hard to reason about |
| 8 | **Two processes, two sets of singletons** | Next:3000 vs Fastify:3001 each instantiate their own vision/memory/context/task/metrics state | State silently diverges; Fastify's copies are wasted |
| 9 | **Fastify dead code** | stt/tts/vision routes duplicate Next paths the UI uses | Maintenance burden; confusing duplicate endpoints |
| 10 | **Conversations not persisted** | conversation-store is Zustand-only; no server storage | History lost on reload; nothing feeds back into memory |
| 11 | **Huge system prompt every call** | `DEFAULT_SYSTEM_PROMPT` ≈ 14.5 KB ≈ 3.5–4.5k tokens sent on every request | Token cost + slower first token on local Ollama |

## 4. What's good (keep as-is)

- **`src/lib/vision/vision-manager.ts`** — the canonical vision gateway: cache-first, Gemma only for complex/OCR, hard refusal when no camera/frame (never lets the LLM guess). The chat route already delegates here.
- **`src/lib/vision/vision-answer.ts`** — YOLO-cache answering with confidence bands (80+/70–79/<70) and anti-hallucination flags.
- **`src/lib/vision/live-vision-engine.ts`** — YOLO + ByteTrack-lite + frame dedupe, per-stage timings.
- **`src/services/tools/*`** — structured registry, executor with timeout/retry/cache, 8+ implementations.
- **`src/services/planner/*`** — deterministic intent planner with `VerifiedFact` and direct/naturalize/llm route kinds, tested.
- **`src/services/reasoning/sanitizer.ts`** — streaming CoT filter (just not wired to the main path).
- **`src/services/tasks/*`**, **`src/services/context/*`**, **`src/lib/memory/*`** — JSON-backed, poll-based, sound.
- **`src/lib/ai/system-tools.ts`** (clock/weather, WMO codes, timeouts), **errors.ts** (provider mapping), **config.ts**, **local-tools.ts**, **metrics.ts** (globalThis store), SSE framing in `route.ts`.

## 5. Recommended architecture

One canonical chat pipeline; everything else becomes a thin adapter.

```
Browser (client.ts)
 ├─ classifyVisionIntent/Depth ONLY (needed pre-request to attach frames)
 ├─ browser-only facts (geolocation/battery — cannot be fetched server-side)
 └─ POST /api/chat (SSE) → Next :3000

Next /api/chat  →  THIN ADAPTER (≈150 lines)
   validate body → browser-facts passthrough → runPipeline(...)
   → map pipeline events → existing SSE frames (token/status/vision/tool/done)

src/services/chat/pipeline.ts  ← single source of truth
   Intent Planner (planner) ──> vision-manager (complex/OCR → Gemma)
          │                    system tools (clock/weather/location/battery)
          ├─> Tool Router (math/memory/tasks/web/news/maps/system/tasks)
          ├─> Memory Engine (buildOwnerContext/appendMemoryContext)
          └─> Reasoning (CoTFilter streaming)
```

- **Planner becomes the single intent classifier.** Fold the 7 old intents into `classifyPlanIntent` (or make `intent-router.ts` a thin alias). Delete the duplicated classifiers.
- **Legacy tools → new registry.** Migrate `get_current_time/search_memory/list_memories/remember` into `src/services/tools/implementations`; point `provider.ts:770` at the new executor; delete `src/lib/ai/tools.ts`.
- **Vision cache authority = vision-manager.** Move the chat route's `visionCache`/`cachedVisionPlan`/`activeVisionController`/skew logic into the manager so the 300ms/1s/skew rules collapse into one.
- **Fastify sidecar** → keep `index.ts` + `assistant.ts` (pipeline) for optional headless use; delete `conversation.ts`, and the duplicate `stt/tts/vision` routes. If the sidecar isn't used at all, drop it and run the pipeline in the Next process (it's just TS modules — no HTTP hop needed).

## 6. File changes

**Delete / fold**
| File | Reason |
|---|---|
| `server/routes/conversation.ts` | Third resolver, orphaned |
| `server/routes/stt.ts`, `tts.ts`, `vision.ts` | Dead duplicates of Next routes |
| `src/lib/ai/tools.ts` | Legacy registry; 4 tools migrate to `src/services/tools` |
| `src/lib/ai/intent-router.ts` | Superseded by planner |
| `src/lib/vision/vision-cache.ts` (+ cache logic in chat route) | Fold into vision-manager |

**Modify**
| File | Change |
|---|---|
| `src/app/api/chat/route.ts` | Reduce to thin SSE adapter over `runPipeline` (907 → ~150 lines) |
| `src/services/chat/pipeline.ts` | Add vision hook (resolveVisualQuestion) + browser-facts passthrough; emit SSE-compatible events; keep Context/Memory/Reasoning |
| `src/services/planner/planner.ts` | Absorb system-clock/geolocation/weather/battery/ocr/vision intents (single classifier) |
| `src/lib/ai/client.ts` | Drop `classifyToolIntent`; keep vision classify for frame attach; shared browser-facts helper |
| `src/lib/ai/provider.ts:770` | Use new Tool Router executor |
| `src/services/tools/implementations/memory.ts` | Add `get_current_time` (or reuse `time`) |

**Keep unchanged**
`src/services/tools/*`, `src/services/planner/*`, `src/services/reasoning/*`, `src/services/tasks/*`, `src/services/context/*`, `src/lib/memory/*`, `src/lib/vision/{vision-manager,vision-answer,live-vision-engine,vision-state,vision-intent,confidence,ocr}`, `src/lib/ai/{system-tools,errors,config,logger,local-tools,vision-intent}`, `src/lib/metrics/*`, Next `vision/live` + `vision/analyze` routes, all tests.

## 7. Performance / latency / token / memory estimates

**Latency (per request)**
| Path | Now | After |
|---|---|---|
| Simple vision (YOLO cache hit) | ~0.5–1s | unchanged (no LLM) |
| Simple vision (fresh capture + YOLO) | ~1s | unchanged |
| Complex vision (Gemma→Qwen, 2 LLM calls) | cloud 2–4s, local 6–20s | unchanged (still 2 grounded calls) |
| Text, cloud (gemini priority) | TTFT ~0.5–2s, total 2–10s | ~same; less prompt → faster TTFT |
| Text, local Ollama Qwen3 | TTFT 1–5s, total 5–40s | faster TTFT once prompt shrinks |
| Tool intents (clock/weather/math) | LLM round-trip on main path today | direct tool → sub-second, LLM only to naturalize |

**Tokens**
- System prompt ≈ 3.5–4.5k tokens per call today. Trim to essentials (move rules into tool schemas); target <1.5k.
- Every call resends full history (stateless). Consider capping history length per turn.
- Complex vision = Gemma (structured) + Qwen (naturalize): expected, but the injected structured JSON should stay compact (300–800 tokens).
- Memory context append: 500–2k tokens; cap by relevance (already partially done in memory/context).

**Memory**
- JSON stores (memory, tasks) are tiny. Metrics store capped at 500. Live vision holds one frame (~100–500 KB base64) + detections — fine. ONNX session ~tens of MB. No changes needed.

## 8. Risks

1. **SSE contract drift** — pipeline events differ from the client's parser. The adapter must emit exactly `token / status / vision / vision_state / tool / done / error` frames, or client.ts breaks.
2. **Browser-only tools** — geolocation + battery need browser permission APIs; they cannot move server-side. Keep the narrow client facts channel and validate it in the pipeline.
3. **Vision freshness guarantee** — the "new frame in, stale answer" prevention lives in the chat route today; moving it into vision-manager must preserve the 250ms skew + 1s stale rules.
4. **CoT filter on the stream** — must hold across chunk boundaries (pipeline already does; verify end-to-end once wired).
5. **Test compatibility** — `intent-router.test.ts` and `planner.test.ts` both exist; keep both green during transition, delete the old one after.
6. **Two-process state** — until the sidecar is dropped, remember the UI only reads Next-process singletons.

## 9. Suggested order of work

1. Wire `/api/chat` to `runPipeline` with an SSE adapter (keeps current behavior, gains memory + CoT + tools). Verify `npm run typecheck`, `npm test`, manual UI chat.
2. Fold old intents into planner; delete `intent-router.ts` + old tests.
3. Migrate legacy tools into the new registry; delete `src/lib/ai/tools.ts`.
4. Consolidate vision caching into vision-manager.
5. Delete Fastify dead routes / sidecar.
6. Shrink system prompt; cap history.
