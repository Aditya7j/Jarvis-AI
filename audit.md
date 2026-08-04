# JARVIS-AI Codebase Optimisation Audit

Goal: apply **YAGNI** (remove what isn't used / isn't needed yet) and **DRY** (eliminate duplication) without breaking any working behaviour.

Verification before/after: `npx tsc --noEmit` and `npm run build` both exit `0`, and the Fastify server boots on port 3001.

---Gemma 3 is now installed locally.

Verify the complete vision pipeline end-to-end.

Requirements:
- Confirm every camera question captures the latest frame.
- Send the captured image to gemma3:12b using Ollama's image API (images field).
- Verify Gemma 3 actually receives the image and returns a response.
- Log every step:
  ✓ Camera frame captured
  ✓ Image encoded
  ✓ Request sent to gemma3:12b
  ✓ Vision response received
  ✓ Structured JSON created
  ✓ JSON passed to Qwen3
- If any step fails, log the exact failure instead of falling back to "I can't determine that."
- Do not break existing voice, memory, or chat features.

## YAGNI — Removed dead code and dead dependencies

### Unused types and constants
| File | Removed | Why |
|---|---|---|
| `src/types/api.ts` (deleted) | All zod request/response schemas (`MessageSchema`, `ConversationRequestSchema`, `VisionAnalysisSchema`, `TaskExecutionSchema`, `MemorySearchSchema`) | Nothing imported this file. Server/Next routes hand-validate and never used the schemas. |
| `src/types/index.ts` | `VisionMode`, `TaskStatus`, `Task`, `Project`, `PluginConfig`, `AppSettings` | No code referenced them (Tasks page defines its own local `TaskItem`). |
| `src/lib/ai/types.ts` | `PROVIDER_LABELS` constant | Defined but never imported anywhere. |

### Dead functions/exports
| File | Removed | Why |
|---|---|---|
| `src/lib/utils.ts` | `randomBetween`, `debounce`, `formatTime`, `formatDate` | Only `cn` was ever imported. |
| `src/lib/vision/vision-service.ts` | `getActiveStream`, `getLatestVisionFrame`, `hasLiveFrames` | Internal helpers never consumed; removed from the exported `visionService` object too. |
| `src/lib/ai/client.ts` | `checkOllama()`, `summary` getter, `analyzeVision()`, `listModels()` | No consumer used them (client-side models listing was redundant with `/api/models` and `aiService`). |
| `src/lib/ai/provider.ts` | `hasVisionProvider()` | Never called. |
| `src/stores/app-store.ts` | Unused `@/types` import | Cleaned up. |
| `src/app/dashboard/calendar/page.tsx` | Unused `CalendarIcon` import | Dead import. |
| `src/app/dashboard/tasks/page.tsx` | Unused `CheckSquare` import | Dead import. |

### Dead infrastructure / dependencies
- `server/routes/memory.ts` + its registration in `server/index.ts` — route was a stub (returned canned data), no client used it.
- `server/db/` (empty directory) — removed.
- Removed unused dependencies from `package.json` (verified zero imports in `src/` and `server/`):
  - `drizzle-orm`, `drizzle-kit`, `pg`, `@types/pg`, `ioredis` — no database code exists in the app.
  - `pino` — nothing imports it directly (Fastify bundles its own logger). `pino-pretty` kept: it is the logger transport used by `server/index.ts`.
  - `zod` — only used by the deleted `src/types/api.ts`.
  - `@tanstack/react-query`, `gsap`, `react-markdown`, `rehype-highlight`, `remark-gfm`, `@react-three/postprocessing` — no imports anywhere in the project.
- Removed `db:push`, `db:generate`, `db:migrate` scripts (depended on drizzle-kit).
- `.env.example` — removed dead `DATABASE_URL` / `REDIS_URL` entries. Kept `DEEPGRAM_API_KEY` (used by `server/routes/stt.ts`).

---

## DRY — Removed duplication

### Provider classes (`src/lib/ai/providers/`)
The three API-key providers duplicated identical config plumbing, constructor/logging, and health-check boilerplate (~40 lines each).

- New `providers/base.ts` → `ProviderConfig` + `BaseProvider<TClient>` holding `modelName`, `timeoutMs`, `healthTimeoutMs`, `client`, `log` and the shared `isConfigured()`, `getModel()`, `supportsVision()`.
- New `providers/health.ts` → `checkProviderHealth()` producing the `connected / not_configured / error` `ProviderStatusDetail` with timing.
- `gemini.ts`, `openai.ts`, `anthropic.ts` now extend `BaseProvider` and implement their own model-call methods; `healthCheck()` is a one-liner using `checkProviderHealth`. Public API of every provider is unchanged.

### AI client (`src/lib/ai/client.ts`)
`setApiKey` and `clearProvider` were near-identical — consolidated behind one private `updateProviderHealth(provider, method, apiKey)`.

### Next.js API routes
`chat/route.ts`, `models/route.ts`, `settings/provider/route.ts`, `vision/analyze/route.ts` repeated the same `Response.json({ error: toErrorPayload(...) }, { status })` and 400-validation boilerplate.

- New `src/lib/api-helpers.ts` → `invalidRequest(message)` (400) and `jsonError(error, status)`.
- All four routes now use these helpers; response shapes are byte-for-byte identical.

### Fastify server routes
- `server/routes/vision.ts` — `/analyze` and `/ocr` duplicated the 400 "No image provided" body → shared `invalidImage()` helper.
- `server/routes/conversation.ts` — HTTP 400 bodies → shared `invalidRequest()` helper.

### Dashboard layout
All 7 dashboard pages repeated the same wrapper: `<Sidebar />` + `ml-[280px]`/`ml-0` margin div bound to `sidebarOpen`.

- New `src/app/dashboard/_components/dashboard-page-frame.tsx` (`DashboardPageFrame`) encapsulates the wrapper.
- Updated `dashboard/page.tsx`, `conversations/page.tsx`, `memory/page.tsx`, `calendar/page.tsx`, `tasks/page.tsx`, `vision/page.tsx`, `settings/page.tsx` to use it. Removed now-unused `Sidebar` / `useAppStore` / `cn` imports. Visual output is unchanged.

### Other
- `src/app/dashboard/settings/page.tsx` — `providerStatus()` used `.find()` three times and the "active provider" label was a 5-way ternary → single `PROVIDER_BY_KEY` map.
- `src/hooks/use-voice.ts` — wake-word-stripping regex was built twice → shared `stripWakeWord()` helper.

---

## Verification
- `npx tsc --noEmit` → exit 0 (baseline 3237 ms → 3063 ms pre-prune → 1908 ms after `npm install` pruned 146 packages).
- `npm run build` → exit 0, "Compiled successfully" both before and after.
- `npx tsx` load test of `server/routes/vision.ts` + `server/routes/conversation.ts` → `ROUTES_OK`.
- `npx tsx server/index.ts` → boots, "Server listening at http://0.0.0.0:3001".

Performance metrics are logged in `performance.text`.
