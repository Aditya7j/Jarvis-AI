# JARVIS-AI — Full Read-Only Audit Report

Date: 2026-08-07
Audit type: read-only. **No files were modified, added, or deleted during this audit.** Every finding below is verified directly against the working tree (source, routes, tests, config, `.env`, data files). Where a claim could not be verified, it is marked as such.

> This report supersedes the 2026-08-04 `AUDIT-REPORT.md`. That earlier report described an architecture (Fastify sidecar on :3001, monolithic `/api/chat`, dual tool registries, unused pipeline) that **no longer exists**. Section 2 documents the delta between that report and the current code.

---

## 1. Workspace statistics

| Metric | Value |
|---|---|
| TypeScript/TSX files under `src/` | 166 |
| Total source lines (`src/**/*.{ts,tsx}`) | 24,837 |
| Test files (`tests/*.test.ts`) | 17 |
| Test file lines | 3,335 |
| Passing tests (vitest) | 310 |
| TypeScript check (`npm run typecheck`, `tsc --noEmit`) | Clean |
| Lint (`npm run lint`) | No errors/warnings |
| `node_modules` size | ~778 MB |
| Runtime dependencies (`package.json`) | 20 |
| Dev dependencies | 12 |
| API route handlers (`src/app/api/**/route.ts`) | 19 |
| Pages (`src/app/**/page.tsx`) | 10 |
| Zustand stores | 4 |
| React hooks | 1 (`use-voice`; vision logic lives in lib + stores) |
| Git history | **Unavailable** — `git` binary not on PATH; could not run `git log/status/diff` |

Dependencies (20): `@anthropic-ai/sdk`, `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`, `@google/generative-ai`, `@react-three/drei`, `@react-three/fiber`, `class-variance-authority`, `clsx`, `framer-motion`, `lucide-react`, `next`, `onnxruntime-node`, `openai`, `react`, `react-dom`, `sharp`, `tailwind-merge`, `three`, `typescript`, `zustand`.

Dev dependencies (12): `@types/node`, `@types/react`, `@types/react-dom`, `@types/three`, `@types/ws`, `autoprefixer`, `eslint`, `eslint-config-next`, `postcss`, `prettier`, `tailwindcss`, `vitest`.

Test files (17): `voice-lifecycle`, `vision-intent`, `verification`, `tools`, `time-service`, `time-freshness`, `task-engine`, `system-tools`, `reliability`, `reasoning`, `postprocess`, `planner`, `pipeline-chat`, `multilingual`, `math-hindi`, `context-window`, `confidence`.

---

## 2. Delta vs the 2026-08-04 architecture audit

The old report's top problems are **resolved** in the current tree:

| Old problem (2026-08-04) | Current state (verified 2026-08-07) |
|---|---|
| Fastify sidecar :3001 with duplicate/orphaned routes | **Deleted.** `Test-Path server` → `False`. No `server/` directory, no `:3001` anywhere. Single Next.js process. |
| Main `/api/chat` was monolithic legacy, no memory/tools/CoT | **Now a thin adapter.** `src/app/api/chat/route.ts` (328 lines) validates, normalizes frames, then delegates to `runPipeline` (`src/services/chat/pipeline.ts`, 1143 lines). |
| Three chat backends / two tool registries | **One.** `src/lib/ai/intent-router.ts` and `src/lib/ai/tools.ts` are gone (deleted). `src/lib/ai/provider.ts:27` imports `executeTool/initToolRouter` from `@/services/tools` — a single tool registry. |
| No CoT sanitizer on main path | **Wired.** `CoTFilter` streams every model response in `pipeline.ts` (`streamThrough`, line 466). |
| No tasks/math/web/news/maps/unit tools on main path | **Present.** Pipeline routes 14 intent classes through the tool executor (see §4). |
| Triple-layered vision caching | **Consolidated.** The chat route no longer owns a cache. `src/lib/vision/vision-cache.ts` exists but is imported **only** by `src/lib/vision/vision-manager.ts:9` — single cache authority. |
| Pipeline unreachable from UI | **Reachable.** `/api/chat` → `runPipeline` is the live product path. |
| Sidecar scheduler | Replaced by in-process automation: `src/instrumentation.ts` calls `startTaskAutomation()` (Next.js `register()`, nodejs runtime). |

Remaining items from the old report that still apply (unchanged): system prompt is still the ~14.5 KB `DEFAULT_SYSTEM_PROMPT` (every model call), conversations are not persisted server-side, and memory/task stores are JSON files without locking.

---

## 3. Architecture overview (current)

Single Next.js (App Router) process. Everything runs in-process; no external services other than the AI providers and local CLI tools (Ollama, Whisper, Piper).

```
Browser
 ├─ useVoice (SpeechRecognition + pause/resume controller)
 ├─ conversation store → POST /api/chat (SSE)   → Next.js :3000
 ├─ live-vision-client → POST /api/vision/live  → Next.js :3000
 ├─ metrics panel      → GET /api/metrics/*     → Next.js :3000
 └─ dashboard pages    → /api/memory/*, /api/tasks*, /api/owner/*, /api/settings/*

Next.js process
 ├─ /api/chat        → normalizeFrames → runPipeline (planner → tools → memory → CoT filter → SSE)
 ├─ /api/vision/live → live-vision-engine (YOLOv8n + ByteTrack-lite), single session
 ├─ /api/vision/analyze → aiService.analyzeCameraFrame (Gemma 3, Ollama-only, no cloud fallback)
 ├─ /api/stt/transcribe → Whisper CLI/server or Deepgram
 ├─ /api/tts/speak      → Piper (CLI/server) ; /api/tts/status
 ├─ /api/chat        ; /api/models ; /api/health ; /api/health/test
 ├─ /api/metrics/summary | events
 ├─ /api/memory  (+ [id], [id]/approve, clear, context, privacy)
 ├─ /api/owner/profile ; /api/settings/provider
 └─ src/instrumentation.ts → startTaskAutomation() (in-process task scheduler)
```

### 3.1 Chat pipeline (`src/services/chat/pipeline.ts`)

Contract (from header comment): every request is classified into one of 14 classes before any model call; any class with an available tool must not be answered by the LLM until the tool succeeds; failures degrade to typed events; chain-of-thought is stripped in-flight; no component throws.

Flow: language detection (`detectLanguage`, deterministic) → `planRoute` (planner) → route kind `direct | naturalize | llm` → gates (unverified-factual LLM refusal, geolocation/battery denials, vision) → tool execution via `executeTool` → verified facts injected as system block → `CoTFilter` streaming → `finish()` emits `source` + `done`, records a hallucination-monitor trace.

Response sources tagged per request: `tool | memory | vision | reasoning | hybrid`.

### 3.2 SSE contract (`src/app/api/chat/route.ts`)

Events emitted by the adapter's `toSSE` (route.ts:98):
- `event: vision_state` → `{ phase }`
- `event: vision` → `{ vision: summary }`
- `event: tool` → `{ intent, tool, latencyMs, ok, fallbackReason }`
- `data: { token }` (streamed text) and `data: { done: true }`
- `event: error` → `{ error }`
- `kind: fact | plan | source` pipeline events are intentionally dropped from the wire.

Frame normalization (route.ts:59): strips data-URL prefixes, caps at 3 frames, then **sorts by descending encoded size** — for fixed resolution the largest JPEG is assumed sharpest, so `frames[0]` (used for YOLO refresh + Gemma) is the best-quality candidate, not merely the newest.

Abort handling is dual-wired (route.ts:241): `request.signal` → `AbortController`, plus the SSE stream's `cancel()` → `requestAbort.abort()`, because Next route-handler `request.signal` does not reliably fire on client disconnect.

---

## 4. AI layer (`src/lib/ai/`)

### 4.1 Provider routing (`provider.ts`)

- Static `PROVIDER_PRIORITY` (provider.ts:40): `["gemini", "ollama", "openai", "anthropic"]`. Used for health checks and as the base ordering.
- Runtime request order (`orderedCandidates`, provider.ts:244): **Ollama is always moved to the front** for both reasoning and vision routes; the remaining configured, non-cooldown providers follow in priority order. Effective per-request order: `ollama → gemini → openai → anthropic` (subject to configured + not-in-cooldown). Code comment confirms this is intentional ("Local Ollama is always tried first").
- Per-role model hints for Ollama via `roleModelName` (router.ts): reasoning → `QWEN3_MODEL`, vision → `GEMMA3_MODEL`.
- **Frame analysis is Gemma 3 / Ollama-only** (`analyzeCameraFrame`, provider.ts:459): no cloud fallback by design, so an unavailable Gemma 3 never gets replaced by a model that could hallucinate visual details. Errors instruct `ollama pull gemma3:4b`.
- Cloud providers each have their own default model if unset (config.ts): Gemini `gemini-2.0-flash`, OpenAI `gpt-4o-mini`, Anthropic `claude-3-5-sonnet-latest`, Ollama `OLLAMA_MODEL` or `qwen3:latest`.

### 4.2 Failure handling & cooldown

- Health cache `HEALTH_CACHE_MS = 10_000` (provider.ts:47).
- Failure cooldown (provider.ts:215): `AUTH_FAILED` / `QUOTA_EXCEEDED` → 5 minutes; any other error → 30 seconds. Success clears the entry.
- Metrics: every attempt tracked (provider, model, status `ok|error|timeout|aborted`, TTFT, chars, tokens, error code). Used by the metrics dashboard.

### 4.3 Tool orchestration

`runToolLoop` (provider.ts:743) — bounded agent loop for model tool-calling requests (`options.tools` set): hands model tool calls to the local registry (`executeTool`, `src/services/tools/executor.ts`), feeds JSON results back, up to `maxToolIterations` (default 4, configurable via `AI_MAX_TOOL_ITERATIONS`). Only engaged when tools are requested; default chat/vision paths are untouched.

### 4.4 Memory injection

- Text/stream paths prepend `DEFAULT_SYSTEM_PROMPT` and call `memoryService.buildContext()` → `appendMemoryContext` (provider.ts:276). Vision requests get a memory prompt prefix (provider.ts:285).
- Pipeline separately queries approved memories relevant to the prompt (`memoryContextBlock`, pipeline.ts:170).

### 4.5 Prompts (`prompts.ts`, 387 lines)

- `DEFAULT_SYSTEM_PROMPT` (~14.5 KB, pipeline.ts imports it): strict rules — never invent facts, verified-data-only system facts, no filler/greetings, <100 words, respond in the user's language.
- `languageInstruction(language)` — injected when the user speaks Hindi/Hinglish: respond fully in that language, never translate, translate wording not facts/numbers/units.
- Canned localized denials: geolocation, battery, weather, unverified-fact, tool-unavailable replies.

---

## 5. API surface (19 route handlers)

| Route | Purpose | Notes |
|---|---|---|
| `POST /api/chat` | Chat SSE / non-stream | Delegates to `runPipeline`; see §3.2 |
| `POST /api/vision/live` | Live vision session (YOLO) | Only consumer: `src/lib/vision/live-vision-client.ts` |
| `POST /api/vision/analyze` | One-shot frame analysis | `aiService.analyzeCameraFrame` (Gemma 3) |
| `POST /api/stt/transcribe` | Speech-to-text | Whisper CLI/server or Deepgram |
| `POST /api/tts/speak` | Text-to-speech | Piper CLI/server |
| `GET /api/tts/status` | TTS capability status | |
| `GET /api/health` | Provider/STT/TTS health | 10s cached, includes capabilities |
| `GET /api/health/test` | Health diagnostics | |
| `GET /api/models` | List models from active provider | **DEAD — no client code calls it** (zero refs to `/api/models` in `src/`) |
| `GET/POST /api/settings/provider` | Runtime API key management | Uses registry (`setRuntimeKey`/`clearRuntimeKey`) |
| `GET /api/metrics/summary` | Metrics aggregates | |
| `GET /api/metrics/events` | Metrics stream (EventSource) | |
| `GET/POST/DELETE /api/memory` | Memory entries CRUD | JSON file backend |
| `GET/PUT/DELETE /api/memory/[id]` | Single memory entry | |
| `POST /api/memory/[id]/approve` | Approval workflow | |
| `DELETE /api/memory/clear` | Clear memory | |
| `GET /api/memory/context` | Memory context for LLM | |
| `GET/POST /api/memory/privacy` | Privacy settings | `data/memory/privacy.json` |
| `GET/PUT /api/owner/profile` | Owner profile | `data/memory/profile.json` |

**Confirmed dead route:** `/api/models`. No `src/` code references it (grep `"/api/models"` → no matches). Its handler (`aiService.listModels`) works, but nothing fetches it.

---

## 6. Vision subsystem (`src/lib/vision/`)

- `live-vision-engine.ts` — YOLOv8n (onnxruntime-node) + ByteTrack-lite tracker + frame dedupe, per-stage timings. Backs `/api/vision/live` as a singleton session.
- `live-vision-client.ts` — the **only** caller of `/api/vision/live`. Verified constants: `CAPTURE_INTERVAL_MS = 350`, `MIN_SUBMIT_GAP_MS = 250`, `FORCE_RESYNC_MS = 2000`, `LIVE_VISION_STALE_MS = 1000`, `LIVE_VISION_RESULT_TTL_MS = 5000`, ~200 ms debounce.
- `vision-manager.ts` — canonical cache-first gateway; Gemma 3 only for complex/OCR; hard refusal when no camera/frame (never lets the LLM guess). Imports `vision-cache.ts` (the single cache).
- `vision-answer.ts` — YOLO-cache answering with confidence bands (80+/70–79/<70) and anti-hallucination flags.
- `vision-intent.ts` — `classifyVisionDepth` for pre-request depth decisions.
- `frame-diff.ts`, `ocr.ts`, `confidence.ts`, `debug-frame.ts`, `detect/` (`yolo-detector`, `tracker`, `postprocess`, `colors`, `coco-classes`).
- `live-vision-session.ts` — session state for live camera loop.
- Server pipeline route `src/services/chat/vision.ts` (`resolveVisionPlan`) grounds visual questions in captured frames with a strict answer/refusal model.

---

## 7. Memory, tasks, context, metrics

### 7.1 Memory (`src/lib/memory/` + `data/memory/`)

- Backend: `json-file-repository.ts` — `data/memory/profile.json` (1,448 B), `data/memory/entries.json` (334 B), `data/memory/privacy.json` (70 B).
- `memory-service.ts` + `repository.ts` — entry lifecycle with an **approval workflow** (`status: pending → approved`), categories, search.
- `sanitize.ts`, `context.ts` (`buildContext`), `client.ts` (browser helper), `types.ts`.
- **No file locking** — concurrent writes to the same JSON file can clobber each other. Low risk today (single process, low volume), but it is the most fragile persistence point.

### 7.2 Tasks (`src/services/tasks/` + `data/tasks/`)

- `engine.ts` (task-engine), `scheduler.ts`, `repository.ts`. `data/tasks/tasks.json` is empty (2 B).
- Started in-process by `src/instrumentation.ts` → `startTaskAutomation()`; there is no external scheduler.

### 7.3 Context (`src/services/context/`)

- `context-engine.ts` (in-process singleton, `isRunning()`, `getAwareness()`), `system-collector.ts`, `types.ts`. The pipeline prepends a verified time/date block (TimeService) plus an optional live environment snapshot.

### 7.4 Metrics (`src/lib/metrics/`)

- `metrics.ts` — globalThis store, capped (per earlier audits at 500 samples), typed attempt records.
- `client-stats.ts` — browser-collected stats. `/api/metrics/summary` + `/api/metrics/events` (SSE) read the store.

### 7.5 Time (`src/lib/time/time-service.ts`)

- `getSystemClock()` is the single verified clock source injected into every pipeline reasoning/naturalize request (pipeline.ts:124 `awarenessBlock`); `formatTimeIn`/`formatDateIn` localize time/date to English/Hindi/Hinglish.

---

## 8. Voice subsystem

### 8.1 Lifecycle (`src/lib/voice/lifecycle.ts` + `src/hooks/use-voice.ts`)

Recent work added `VoiceSessionController`: single live session enforcement, `pause()`/`resume()`, auto-reconnect on end, start timeout (3 s), stale-session watchdog (15 s, 2 s tick), forced reset with 500 ms grace, lifecycle events + console logs. `use-voice.ts` ties TTS start → `pause()`, TTS end → `resume()`, drops transcripts while paused, and exposes `{ state, startListening, stopListening, speak, setContinuousMode, resumeContinuousMode, isSttSupported }`. Verified by `tests/voice-lifecycle.test.ts` (8 tests), including a 20-consecutive-turn no-self-trigger/no-freeze case. This resolves the two previously reported bugs (TTS re-trigger echo loop; mic freeze after 2–3 turns).

### 8.2 STT (`src/lib/stt.ts`, `src/lib/ai/whisper.ts`, `/api/stt/transcribe`)

- Browser path: `isSpeechRecognitionSupported()` / `webkitSpeechRecognition`.
- Server path: Whisper CLI or `WHISPER_SERVER_URL`, falling back to Deepgram (`DEEPGRAM_API_KEY`). MediaRecorder chunk cap ~20 s. `whisper`/`deepgram` appear 95× in `src/`.

### 8.3 TTS (`src/lib/ai/piper.ts`, `src/lib/tts.ts`, `/api/tts/*`)

- Piper CLI (`PIPER_COMMAND`, default voice `en_US-lessac-medium`) or `PIPER_SERVER_URL`, with browser `speechSynthesis` as fallback. `TTS_MODE`/`STT_MODE` env knobs (`auto|piper|browser` and `auto|whisper|deepgram|browser`).

### 8.4 Lang (`src/lib/lang/`)

- `detect.ts` (deterministic English/Hindi/Hinglish detection, <5 ms) and `replies.ts` (localized canned replies) used throughout the pipeline.

---

## 9. UI / pages / stores

### 9.1 Pages (10)

`/` (landing), `/dashboard`, and `/dashboard/{calendar,conversations,memory,metrics,profile,settings,tasks,vision}`.

### 9.2 Components (`src/components/`)

- `layout/sidebar.tsx`, `voice/voice-interface.tsx`, `vision/vision-interface.tsx`, `vision/vision-debug-overlay.tsx`, `vision/vision-status-bar.tsx`, `command-palette/command-palette.tsx`, `landing/glowing-orb.tsx`, `ui/{button,input,textarea,select,switch,badge,glass-card}.tsx`.

### 9.3 Stores (`src/stores/`)

4 Zustand stores: `app-store`, `conversation-store`, `vision-store`, `voice-store`. Each is scoped to its feature; no cross-store import cycles found. Conversations are store-only (not persisted server-side — unchanged from the old audit).

### 9.4 Camera (`src/lib/camera/`)

`camera-service.ts`, `frame-worker.ts` (capture loop + worker), `enhance.ts`, `index.ts`, `types.ts`; integrated with the vision store/permission flow.

---

## 10. Config, environment, security

### 10.1 `.env` (17 variables) and their actual usage in `src/`

| Variable | Refs in `src/` | Status |
|---|---|---|
| `GEMINI_API_KEY` | 6 | Used |
| `OPENAI_API_KEY` | 4 | Used |
| `ANTHROPIC_API_KEY` | 4 | Used |
| `OLLAMA_BASE_URL` | 1 (`config.ts:91`) | Used (default `http://localhost:11434`) |
| `DEEPGRAM_API_KEY` | 4 | Used (STT fallback) |
| `GEMINI_MODEL` / `OPENAI_MODEL` / `ANTHROPIC_MODEL` | config defaults | Used |
| `OLLAMA_MODEL` / `QWEN3_MODEL` / `GEMMA3_MODEL` | 1 / 1 / 3 | Used (Ollama routing) |
| `AI_VISION_TIMEOUT_MS` | 2 | Used (default 300,000) |
| `ELEVENLABS_API_KEY` | **0** | **DEAD** — no TTS path references it (TTS is Piper/browser only) |
| `DATABASE_URL` | **0** | **DEAD** — no DB layer (JSON file backend) |
| `REDIS_URL` | **0** | **DEAD** — no Redis anywhere |
| `PORT` | **0** (`process.env.PORT` not referenced) | **UNUSED in code** — Next.js default port applies |
| `NODE_ENV` | standard | Used by Next.js |

Config knobs read by `src/lib/ai/config.ts` that are **not** present in `.env` (defaults apply): `AI_REQUEST_TIMEOUT_MS`, `AI_HEALTH_TIMEOUT_MS`, `AI_MAX_TOOL_ITERATIONS`, `STT_MODE`, `WHISPER_ENABLED`, `WHISPER_COMMAND`, `WHISPER_SERVER_URL`, `WHISPER_MODEL`, `WHISPER_LANGUAGE`, `TTS_MODE`, `PIPER_ENABLED`, `PIPER_COMMAND`, `PIPER_SERVER_URL`, `PIPER_VOICE`. A `.env.example` exists (2,323 B) documenting the surface.

### 10.2 Security

- **No hardcoded secrets in `src/`** — scanned for `AIza…`, `sk-…`, `sk-ant-…`, `Bearer`, `AKIA…`: no matches.
- `.env` and `data/` are gitignored. `.env` contains live API keys (Gemini, OpenAI, Anthropic, Deepgram) but is excluded from version control.
- Runtime key override supported via `/api/settings/provider` → `registry.ts` (in-memory only, rebuilds providers).
- **No TODO/FIXME/HACK/XXX/`@ts-ignore`/`@ts-expect-error`/`eslint-disable` in `src/`.** The six grep "matches" for TODO are false positives — the substring `todo` inside intent regexes (`(?:task|reminder|todo|to-do|alarm|event)` in `pipeline.ts:293`, `intents.ts:231/236`) and the word "stories" in `web.ts:226-229`; none are actual annotations.
- `console.log` (plain, non `info/warn/error`) in `src/`: none found. All logging goes through `aiLogger`.

### 10.3 Dependency vulnerabilities (`npm audit`, 2026-08-07)

**13 vulnerabilities: 3 moderate, 9 high, 1 critical.**

- **critical** — `vitest` (via `vite`)
- **high** — `next` (chain via `postcss` etc.), `glob`, `js-yaml`, `postcss`, `onnxruntime-node` (via `adm-zip`), `vite`, `eslint-config-next` / `@next/eslint-plugin-next`
- **moderate** — `esbuild`, `vite-node` / `@vitest/mocker` (via `vite`)

Most are dev-only (vitest/vite/esbuild/eslint toolchain); `next` and `onnxruntime-node` are runtime-relevant. No fix versions were reported as applied; this is informational — nothing was changed.

---

## 11. Notable findings (summary)

**Dead / unused**
1. `/api/models` route — zero callers in `src/`.
2. `.env` → `ELEVENLABS_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `PORT` — zero references in code.
3. `server/` (Fastify sidecar) — already removed; references to it in `audit.md`/`performance.text` are stale.

**Fragility**
4. Memory/task JSON stores have no locking — concurrent writes can clobber. Low risk at current volume.
5. Conversations are not persisted server-side — history is Zustand-only, lost on reload.
6. `DEFAULT_SYSTEM_PROMPT` (~14.5 KB ≈ 3.5–4.5k tokens) is sent on every model call.

**Positive (verified)**
7. Single-process architecture; pipeline is the one chat path; single tool registry; single vision-cache authority; CoT filtering on every stream; localized responses (EN/HI/Hinglish); measured/hallucination-monitored responses; dual-abort SSE wiring; hardened voice lifecycle (self-trigger loop + mic freeze fixed, 310 tests green).

---

## 12. Verification gates (all run during/after prior work, not modified today)

- `npm test` → 17 files / 310 tests pass (includes new `voice-lifecycle` suite).
- `npm run typecheck` (`tsc --noEmit`) → clean.
- `npm run lint` → no errors or warnings.

---

## 13. Open items for future (informational — no action taken)

1. Decide fate of `/api/models` (dead) and the four unused `.env` keys — remove or implement.
2. Address `npm audit` critical/high findings (especially runtime `next` and `onnxruntime-node`) when a safe upgrade path exists.
3. Optional: file-level locking for JSON memory/tasks repositories; optional server persistence for conversations.
4. Optional: shrink `DEFAULT_SYSTEM_PROMPT` / cap context to cut token cost and TTFT on local Ollama.
