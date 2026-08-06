/**
 * Chat Pipeline — the orchestration core of JARVIS.
 *
 *   Context Engine → Intent Planner → Tool Router → Memory Engine →
 *   Reasoning Engine → Natural Response
 *
 * Execution contract:
 *   1. EVERY request is classified into one of 14 classes before any model call.
 *   2. For any class with an available tool, the LLM MUST NOT answer before the
 *      tool executes successfully.
 *   3. If a required tool fails, the assistant clearly says it could not
 *      verify the information — it never guesses.
 *   4. The reasoning model only summarizes verified tool output (directly
 *      formatted, or naturalized under a strict "only source of truth" block).
 *   5. Every response is tagged internally with its source:
 *      tool | memory | vision | reasoning | hybrid.
 *   6. Every request is traced (intent, tool, execution time, success/failure,
 *      reasoning model, fallback reason, final source) and recorded in the
 *      hallucination monitor so unsupported model output is measurable.
 *
 * Chain of thought is stripped in-flight. No component throws: failures
 * degrade to typed events.
 */

import { aiLogger } from "@/lib/ai/logger";
import {
  detectLanguage,
  logLanguageDetection,
  type SpokenLanguage,
} from "@/lib/lang/detect";
import { localizeReply } from "@/lib/lang/replies";
import {
  DEFAULT_SYSTEM_PROMPT,
  buildVerifiedFactContext,
  languageInstruction,
} from "@/lib/ai/prompts";
import type { VisionAnalysisSummary } from "@/lib/ai/prompts";
import { classifyVisionDepth } from "@/lib/ai/vision-intent";
import { formatDateIn, formatTimeIn } from "@/lib/time/time-service";
import { getSystemClock, logTimeService } from "@/lib/time/time-service";
import type { VisionFrameInput } from "@/lib/vision/vision-manager";
import type { AIMessageInput } from "@/lib/ai/types";
import { parseConversionRequest } from "@/lib/toolkit/convert";
import { normalizeCurrency, parseCurrencyRequest } from "@/lib/toolkit/web";
import { getContextEngine } from "@/services/context/context-engine";
import {
  classifyPlanIntent,
  planRoute,
  type PlanClass,
} from "@/services/planner";
import {
  detectBattery,
  detectMaps,
  detectMemoryRecall,
  detectMemoryStore,
  detectNews,
  detectTaskCreate,
} from "@/services/planner/intents";
import type { VerifiedFact } from "@/services/planner/types";
import { CoTFilter } from "@/services/reasoning";
import { executeTool, initToolRouter, type ToolResult } from "@/services/tools";
import {
  hallucinationMonitor,
  isHallucination,
  type ResponseSource,
  type ToolTrace,
} from "./hallucination";
import { resolveVisionPlan } from "./vision";

const log = aiLogger.child("pipeline");

export interface PipelineModel {
  streamText: (opts: {
    messages: AIMessageInput[];
    signal?: AbortSignal;
    model?: string;
  }) => AsyncIterable<string>;
  analyzeCameraFrame?: (opts: {
    imageBase64: string;
    prompt?: string;
    mimeType?: string;
    signal?: AbortSignal;
  }) => Promise<string>;
}

export type PipelineEvent =
  | { kind: "status"; phase: string }
  | {
      kind: "tool";
      intent: PlanClass;
      tool: string;
      latencyMs: number;
      ok: boolean;
      fallbackReason?: string;
    }
  | { kind: "plan"; intent: PlanClass; tools: string[]; confidence: number }
  | { kind: "vision"; summary: VisionAnalysisSummary }
  | { kind: "token"; text: string }
  | { kind: "fact"; tool: string; subject: string }
  | { kind: "source"; source: ResponseSource }
  | { kind: "done" };

export interface PipelineOptions {
  signal?: AbortSignal;
  /** Client-gated verified facts reported by the browser. */
  clientTools?: {
    systemClock?: unknown;
    geolocation?: { granted: boolean; latitude?: number; longitude?: number; accuracyM?: number };
    battery?: { granted: boolean; level?: number; levelPercent?: number; charging?: boolean };
  };
  /** Live vision state + the newest client frames for visual questions. */
  vision?: {
    state: "off" | "live" | "no-frame";
    frames: VisionFrameInput[];
  };
  /** Optional explicit reasoning-model override. */
  model?: string;
  /** Include a compact awareness snapshot in the system context. */
  includeAwareness?: boolean;
  /** Query long-term memory for relevant context. Defaults true. */
  includeMemory?: boolean;
}

function awarenessBlock(): string | null {
  // The verified clock is ALWAYS present, regardless of whether the OS context
  // engine is running. This is the single source of truth the model may use for
  // time/date/timezone/greeting — without it the LLM has no clock and guesses.
  const clock = getSystemClock();
  logTimeService("pipeline-awareness", clock);
  const blocks: string[] = [
    `Verified data from the TimeService tool — this is the ONLY source of truth for the current date, time, timezone and greeting:
${JSON.stringify(
  {
    iso: clock.iso,
    unixMs: clock.unixMs,
    time: clock.time,
    date: clock.date,
    timezone: clock.timezone,
    greeting: clock.greeting,
    dayPart: clock.dayPart,
  },
  null,
  2
)}`,
  ];
  try {
    const engine = getContextEngine();
    if (engine.isRunning()) {
      const snapshot = engine.getAwareness();
      if (snapshot.server || snapshot.client) {
        blocks.push(
          `Live environment snapshot (verified at ${clock.iso}):\n${JSON.stringify(
            snapshot,
            null,
            2
          )}`
        );
      }
    }
  } catch {
    // Non-fatal: the verified clock block above is always present.
  }
  return blocks.join("\n\n");
}

type MemoryLike = {
  listEntries: (filter: unknown) => Promise<Array<{ id: string; category: string; content: string }>>;
};

async function memoryContextBlock(prompt: string): Promise<string | null> {
  let memoryService: MemoryLike;
  try {
    const mod = await import("@/lib/memory");
    memoryService = mod.memoryService as MemoryLike;
  } catch {
    return null;
  }
  try {
    const entries = await memoryService.listEntries({
      status: "approved",
      search: prompt.slice(0, 120),
      limit: 3,
    });
    if (!entries || entries.length === 0) return null;
    return `Relevant long-term memories about this user:\n${entries
      .map((entry) => `- [${entry.category}] ${entry.content}`)
      .join("\n")}`;
  } catch {
    return null;
  }
}

function withSystemContext(
  messages: AIMessageInput[],
  blocks: Array<string | null>
): AIMessageInput[] {
  const existing = blocks.filter((b): b is string => Boolean(b && b.trim()));
  if (existing.length === 0) return messages;
  return [{ role: "system", content: existing.join("\n\n") }, ...messages];
}

function injectVerifiedFacts(
  messages: AIMessageInput[],
  facts: VerifiedFact[]
): AIMessageInput[] {
  const blocks = facts.map((fact) =>
    buildVerifiedFactContext(fact.label, fact.subject, fact.fact)
  );
  if (blocks.length === 0) return messages;
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) {
    const copy = messages.slice();
    copy[index] = {
      ...copy[index],
      content: `${copy[index].content}\n\n${blocks.join("\n\n")}`,
    };
    return copy;
  }
  return [
    { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${blocks.join("\n\n")}` },
    ...messages,
  ];
}

function injectSystemBlock(
  messages: AIMessageInput[],
  systemContext: string
): AIMessageInput[] {
  const index = messages.findIndex((m) => m.role === "system");
  if (index >= 0) {
    const copy = messages.slice();
    copy[index] = {
      ...copy[index],
      content: `${copy[index].content}\n\n${systemContext}`,
    };
    return copy;
  }
  return [
    { role: "system", content: `${DEFAULT_SYSTEM_PROMPT}\n\n${systemContext}` },
    ...messages,
  ];
}

function stripPrefix(text: string, prefixes: RegExp[]): string {
  let result = text.trim();
  for (const pattern of prefixes) {
    result = result.replace(pattern, "");
  }
  return result.trim().replace(/[?]$/, "").trim();
}

const MAPS_PREFIXES = [
  /^(?:directions|route|navigate)\s+to\s+/i,
  /^map\s+of\s+/i,
  /^how\s+do\s+i\s+get\s+to\s+/i,
  /^where\s+is\s+the\s+(?:nearest|closest|best)\s+/i,
];

const SEARCH_PREFIXES = [
  /^(?:search\s+(?:the\s+web\s+)?(?:for\s+)?|look\s+it?\s+up|look\s+up|google\s+|find\s+out)\s*/i,
  /^(?:सर्च\s+करो|ढूँढो|खोजो|इंटरनेट\s+पर\s+देखो)\s*/u,
  /\b(?:search\s+karo|google\s+karo|internet\s+par\s+dekho)\s*/i,
];

const UNVERIFIED_FACT_PATTERNS: RegExp[] = [
  /\b(?:current|right\s+now|now)\b.*\b(?:time|date|weather|temperature|forecast)\b/i,
  /\b(?:time|date|weather|temperature|forecast)\b.*\b(?:right\s+now|now|current)\b/i,
  /\b(?:tell\s+me|give\s+me)\s+(?:the\s+|what\s+)?(?:current\s+)?(?:time|date)\b/i,
  /\bwhat'?s\s+the\s+(?:current\s+)?(?:time|date)\b/i,
  /\btoday'?s\s+date\b/i,
  /\bhow\s+(?:hot|cold)\s+is\s+it\s+(?:outside|right\s+now|today)\b/i,
];

/** Narrow safety net: live-fact questions that bypassed every detector. */
function looksLikeUnverifiedFactual(prompt: string): boolean {
  return UNVERIFIED_FACT_PATTERNS.some((pattern) => pattern.test(prompt));
}

const MEMORY_STORE_PREFIXES = [
  /^\s*(?:remember|note\s+down|note\s+that|don'?t\s+forget|do\s+not\s+forget|store\s+in\s+memory)\s+(?:that|this|to|the)?\s*/i,
  /^(?:याद\s+रखना|याद\s+रखो|याद\s+रख|नोट\s+कर\s+लो|नोट\s+कर|मुझे\s+याद\s+रख|याद\s+रहे)\s*/u,
  /\b(?:yaad\s+(?:rakhna|rakho|rakh)|note\s+kar\s+lo|note\s+kar|mujhe\s+yaad\s+rakh)\s*/i,
];

const MEMORY_RECALL_PREFIXES = [
  /^\s*(?:what\s+do\s+you\s+remember|search\s+(?:your\s+)?memory\s+for|recall|what\s+do\s+you\s+know\s+about)\s+/i,
  /^(?:क्या\s+याद\s+है|याद\s+करके\s+बताओ|तुम्हें\s+क्या\s+याद\s+है)\s*/u,
  /\b(?:kya\s+yaad\s+hai|yaad\s+karke\s+batao|tumhe\s+kya\s+yaad\s+hai)\s*/i,
];

const TASK_CREATE_PREFIXES = [
  /^\s*(?:remind\s+me\s+to|remind\s+us\s+to)\s+/i,
  /^\s*(?:create|add|make|schedule|set)\s+(?:a|an|the)?\s*(?:task|reminder|todo|to-do|alarm|event)\s+(?:to|that|for|:)?\s*/i,
  /^(?:याद\s+दिलाना|रिमाइंडर\s+(?:बनाओ|सेट\s+करो)|अलार्म\s+(?:लगाओ|सेट\s+करो)|काम\s+(?:बनाओ|जोड़ो)|टास्क\s+(?:बनाओ|जोड़ो)|कार्य\s+जोड़ो)\s*/u,
  /\b(?:yaad\s+dilana|reminder\s+(?:banao|set\s+karo)|alarm\s+(?:laga\s+do|set\s+karo)|task\s+(?:banao|add\s+karo)|kaam\s+yaad\s+dilana)\s*/i,
];

function extractScheduleMinutes(text: string): number | null {
  const inMatch = text.match(/\bin\s+(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs|day|days)\b/i);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2].toLowerCase();
    if (unit.startsWith("min")) return n;
    if (unit.startsWith("hour") || unit === "hr" || unit === "hrs") return n * 60;
    if (unit.startsWith("day")) return n * 1440;
  }
  const hindiIn = text.match(/(\d+)\s*(?:मिनट|घंटे|घंटा|दिन)\s+(?:में|बाद)/u);
  if (hindiIn) {
    const n = Number(hindiIn[1]);
    const unit = hindiIn[2];
    if (unit === "मिनट") return n;
    if (unit === "घंटे" || unit === "घंटा") return n * 60;
    if (unit === "दिन") return n * 1440;
  }
  if (/\btomorrow\b/i.test(text)) return 24 * 60;
  if (/\bkal\b/i.test(text)) return 24 * 60;
  if (/\bparson\b|\bparso\b/i.test(text)) return 48 * 60;
  return null;
}

/** Arguments for a direct tool (no LLM). */
function directArgs(cls: PlanClass, text: string): Record<string, unknown> {
  if (cls === "math") return { expression: text };
  if (cls === "conversion") {
    const currency = parseCurrencyRequest(text);
    if (
      currency &&
      normalizeCurrency(currency.from) !== null &&
      normalizeCurrency(currency.to) !== null
    ) {
      return { amount: currency.amount, from: currency.from, to: currency.to };
    }
    const parsed = parseConversionRequest(text);
    if (parsed) return { value: parsed.value, from: parsed.from, to: parsed.to };
  }
  return {};
}

/** Format a verified direct tool result with no LLM involvement. */
function directAnswer(
  cls: PlanClass,
  data: unknown,
  language: SpokenLanguage
): string | null {
  if (cls === "math") {
    const d = data as { expression?: string; formatted?: string };
    if (typeof d.formatted === "string") return `${d.expression ?? "That"} = ${d.formatted}`;
    return null;
  }
  if (cls === "conversion") {
    const d = data as {
      amount?: number;
      from?: string;
      formatted?: string;
      rate?: number;
      to?: string;
      source?: string;
    };
    if (typeof d.formatted === "string") {
      const rate = typeof d.rate === "number" ? ` (rate: 1 ${d.from} = ${d.rate} ${d.to})` : "";
      return `${d.formatted}${rate}${d.source ? ` — ${d.source}` : ""}`;
    }
    return null;
  }
  if (cls === "time") {
    const d = data as { unixMs?: number; time?: string };
    if (typeof d.unixMs === "number") {
      const localized = formatTimeIn(language, d.unixMs);
      if (localized) {
        if (language === "hindi") return `समय ${localized} है।`;
        if (language === "hinglish") return `Time ${localized} hai.`;
      }
      if (typeof d.time === "string") return `It is ${d.time}.`;
    }
    if (typeof d.time === "string") return `It is ${d.time}.`;
    return null;
  }
  if (cls === "date") {
    const d = data as { unixMs?: number; date?: string };
    if (typeof d.unixMs === "number") {
      const localized = formatDateIn(language, d.unixMs);
      if (localized) {
        if (language === "hindi") return `आज ${localized} है।`;
        if (language === "hinglish") return `Aaj ${localized} hai.`;
      }
      if (typeof d.date === "string") return `Today is ${d.date}.`;
    }
    if (typeof d.date === "string") return `Today is ${d.date}.`;
    return null;
  }
  return null;
}

function liveFactSummary(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.unixMs === "number") {
    return {
      unixMs: record.unixMs,
      time: record.time ?? null,
      date: record.date ?? null,
      timezone: record.timezone ?? null,
    };
  }
  if (typeof record.observedAt === "string") {
    return {
      observedAt: record.observedAt,
      temperatureC: record.temperatureC ?? null,
      condition: record.condition ?? null,
    };
  }
  return null;
}

async function executeSteps(
  tools: string[],
  argFor: (tool: string) => Record<string, unknown>,
  options: { signal?: AbortSignal; requestId?: string } = {}
): Promise<{ facts: VerifiedFact[]; results: ToolResult[] }> {
  const facts: VerifiedFact[] = [];
  const results: ToolResult[] = [];
  for (const tool of tools) {
    log.info("[Tool Selected]", { requestId: options.requestId, tool });
    const result = await executeTool(tool, argFor(tool) ?? {}, {
      signal: options.signal,
    });
    const summary = liveFactSummary(result.ok ? result.data : null);
    log.info("[Tool Executed]", {
      requestId: options.requestId,
      tool,
      ok: result.ok,
      cacheHit: result.meta.cacheHit,
      latencyMs: result.meta.durationMs,
      attempts: result.meta.attempts,
    });
    if (result.ok && summary) {
      log.info("[Tool Returned]", { requestId: options.requestId, tool, ...summary });
    }
    results.push(result);
    if (result.ok) {
      facts.push({
        tool,
        label: tool
          .split("_")
          .map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1))
          .join(" "),
        subject: "the requested fact",
        fact: result.data,
        executedAt: Date.now(),
      });
    }
  }
  return { facts, results };
}

function toolEvent(
  intent: PlanClass,
  tool: string,
  startedAt: number,
  ok: boolean,
  fallbackReason?: string
): PipelineEvent {
  return { kind: "tool", intent, tool, latencyMs: Date.now() - startedAt, ok, fallbackReason };
}

async function* streamThrough(
  model: PipelineModel,
  messages: AIMessageInput[],
  filter: CoTFilter,
  signal?: AbortSignal,
  modelName?: string
): AsyncGenerator<PipelineEvent> {
  for await (const token of model.streamText({ messages, signal, model: modelName })) {
    const clean = filter.push(token);
    if (clean) yield { kind: "token", text: clean };
  }
  const tail = filter.flush();
  if (tail) yield { kind: "token", text: tail };
}

interface FinishArgs {
  requestId: string;
  prompt: string;
  cls: PlanClass;
  routeKind: "direct" | "naturalize" | "llm";
  source: ResponseSource;
  tools: ToolTrace[];
  verifiedFactCount: number;
  llmInvoked: boolean;
  startedAt: number;
  options: PipelineOptions;
  fallbackReason?: string;
}

/** Emit the response-source tag + done, log the pipeline trace, record the
 *  hallucination measurement. Called on EVERY exit path. */
function* finish(args: FinishArgs): Generator<PipelineEvent> {
  yield { kind: "source", source: args.source };
  yield { kind: "done" };
  const latencyMs = Date.now() - args.startedAt;
  const selectedTool = args.tools[0]?.name ?? null;
  const anyTool = args.tools.length > 0;
  const toolOk =
    anyTool && args.tools.every((t) => t.ok !== false) && args.tools.some((t) => t.ok === true)
      ? true
      : anyTool
        ? false
        : null;
  const hallucination = isHallucination({
    llmInvoked: args.llmInvoked,
    toolBacked: args.cls !== "reasoning",
    verifiedFactCount: args.verifiedFactCount,
  });
  log.info("[Final Response]", {
    requestId: args.requestId,
    intent: args.cls,
    source: args.source,
    selectedTool,
    latencyMs,
    fallbackReason: args.fallbackReason ?? null,
  });
  log.info("[pipeline-complete]", {
    requestId: args.requestId,
    intent: args.cls,
    selectedTool,
    toolOk,
    executionMs: latencyMs,
    model: args.options.model ?? "auto",
    fallbackReason: args.fallbackReason ?? null,
    source: args.source,
    hallucination,
  });
  hallucinationMonitor.record({
    requestId: args.requestId,
    prompt: args.prompt.slice(0, 120),
    cls: args.cls,
    route: args.routeKind,
    tools: args.tools,
    verifiedFactCount: args.verifiedFactCount,
    llmInvoked: args.llmInvoked,
    source: args.source,
    hallucination,
    reason: hallucination
      ? "LLM invoked for a tool-backed request without any verified facts"
      : undefined,
  });
}

/**
 * Run the full OS pipeline. Yields events; never throws.
 */
export async function* runPipeline(
  prompt: string,
  messages: AIMessageInput[],
  model: PipelineModel,
  options: PipelineOptions = {}
): AsyncGenerator<PipelineEvent> {
  // Ensure the production Tool Router is registered wherever this pipeline runs
  // (Next.js process, Fastify sidecar, tests). Idempotent — safe per request.
  initToolRouter();

  const requestId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `req-${Date.now()}`;
  const startedAt = Date.now();
  const signal = options.signal;

  // ---------- Language stage ----------
  // The user's language is detected deterministically (no LLM, sub-5ms) and
  // drives ONLY presentation: the LLM responds in it, direct tool answers are
  // formatted in it, and canned fallbacks are localized. Tool routing and
  // execution stay language independent.
  const detectionStartedAt = Date.now();
  const detection = detectLanguage(prompt);
  const language = detection.language;
  logLanguageDetection("pipeline", prompt, detection, Date.now() - detectionStartedAt);
  const languageBlock =
    language === "english" ? null : languageInstruction(language);

  if (!prompt.trim()) {
    yield { kind: "token", text: localizeReply(language, "emptyPrompt") };
    yield* finish({
      requestId,
      prompt,
      cls: "reasoning",
      routeKind: "llm",
      source: "reasoning",
      tools: [],
      verifiedFactCount: 0,
      llmInvoked: false,
      startedAt,
      options,
    });
    return;
  }

  const route = planRoute(prompt, { clientTools: options.clientTools });
  const { cls } = route.step;
  const tools = route.step.tools;
  const label = route.step.label;
  const q = prompt.trim();

  log.info("[Planner]", {
    requestId,
    prompt: prompt.slice(0, 160),
    intent: cls,
    label,
    kind: route.kind,
    confidence: route.confidence,
    why: route.audit.why,
    toolsConsidered: route.audit.toolsConsidered,
    toolsSelected: route.audit.toolsSelected,
    toolReasons: route.audit.toolReasons,
  });
  yield { kind: "plan", intent: cls, tools, confidence: route.confidence };

  const toolTraces: ToolTrace[] = tools.map((name) => ({ name, ok: null }));
  const facts: VerifiedFact[] = [];
  let llmInvoked = false;
  let source: ResponseSource = "reasoning";
  let fallbackReason: string | undefined;

  // ---------- LLM confidence gate ----------
  // A request for a live fact (time/date/weather/…) that NO tool routed to
  // must never be answered by guesswork. If the detectors missed one of these,
  // say so explicitly instead of letting the model hallucinate a value.
  if (route.kind === "llm" && looksLikeUnverifiedFactual(prompt)) {
    yield { kind: "status", phase: "tool" };
    yield toolEvent(cls, "none", startedAt, false, "no_verifiable_tool");
    fallbackReason = "no_verifiable_tool";
    yield { kind: "token", text: localizeReply(language, "unverifiedFact") };
    source = "reasoning";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: facts.length,
      llmInvoked,
      startedAt,
      options,
      fallbackReason,
    });
    return;
  }

  // ---------- Direct classes: format verified tool output, NO LLM ----------
  if (route.kind === "direct") {
    yield { kind: "status", phase: "tool" };
    const { results } = await executeSteps(tools, () => directArgs(cls, q), {
      signal,
      requestId,
    });
    const result = results[0];
    const ok = Boolean(result?.ok);
    toolTraces[0] = { name: tools[0], ok };
    if (result?.ok) {
      const text = directAnswer(cls, result.data, language);
      if (text) {
        yield toolEvent(cls, tools[0], startedAt, true);
        yield { kind: "fact", tool: tools[0], subject: label };
        yield { kind: "token", text };
        source = "tool";
        yield* finish({
          requestId,
          prompt,
          cls,
          routeKind: route.kind,
          source,
          tools: toolTraces,
          verifiedFactCount: 1,
          llmInvoked,
          startedAt,
          options,
        });
        return;
      }
    }
    fallbackReason = "direct_parse_failed";
    yield toolEvent(cls, tools[0], startedAt, false, fallbackReason);
    yield { kind: "token", text: localizeReply(language, "toolUnavailable") };
    source = "tool";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 0,
      llmInvoked,
      startedAt,
      options,
      fallbackReason,
    });
    return;
  }

  // ---------- Client-gated denials (explicit, never a guess) ----------
  if (cls === "location" && !options.clientTools?.geolocation?.granted) {
    yield { kind: "status", phase: "tool" };
    fallbackReason = "geolocation_permission_denied";
    yield toolEvent(cls, "browser-geolocation", startedAt, false, fallbackReason);
    yield { kind: "token", text: localizeReply(language, "geolocationDenied") };
    source = "tool";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 0,
      llmInvoked,
      startedAt,
      options,
      fallbackReason,
    });
    return;
  }
  if (
    cls === "system" &&
    detectBattery(q) &&
    !options.clientTools?.battery?.granted
  ) {
    yield { kind: "status", phase: "tool" };
    fallbackReason = "battery_unavailable";
    yield toolEvent(cls, "battery-status", startedAt, false, fallbackReason);
    yield { kind: "token", text: localizeReply(language, "batteryDenied") };
    source = "tool";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 0,
      llmInvoked,
      startedAt,
      options,
      fallbackReason,
    });
    return;
  }
  if (cls === "weather" && !options.clientTools?.geolocation?.granted) {
    yield { kind: "status", phase: "tool" };
    fallbackReason = "no_location_data";
    yield toolEvent(cls, "weather-api", startedAt, false, fallbackReason);
    yield { kind: "token", text: localizeReply(language, "weatherNoLocation") };
    source = "tool";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 0,
      llmInvoked,
      startedAt,
      options,
      fallbackReason,
    });
    return;
  }

  // ---------- Vision: grounded Gemma analysis only, never a raw guess ----------
  if (cls === "vision") {
    yield { kind: "status", phase: "tool" };
    const resolution = await resolveVisionPlan({
      prompt: q,
      depth: classifyVisionDepth(q),
      visionState: options.vision?.state ?? "off",
      frames: options.vision?.frames ?? [],
      model,
      signal,
      language,
    });
    if (resolution.kind === "direct") {
      if (resolution.summary) yield { kind: "vision", summary: resolution.summary };
      yield { kind: "status", phase: "cached" };
      yield { kind: "token", text: resolution.text };
      source = "vision";
      fallbackReason =
        resolution.summary?.state === "off"
          ? "no_camera"
          : resolution.summary?.state === "no-frame"
            ? "no_frame"
            : undefined;
      yield* finish({
        requestId,
        prompt,
        cls,
        routeKind: route.kind,
        source,
        tools: toolTraces,
        verifiedFactCount: 0,
        llmInvoked,
        startedAt,
        options,
        fallbackReason,
      });
      return;
    }
    if (resolution.kind === "cancelled") {
      yield { kind: "status", phase: "cancelled" };
      source = "vision";
      yield* finish({
        requestId,
        prompt,
        cls,
        routeKind: route.kind,
        source,
        tools: toolTraces,
        verifiedFactCount: 0,
        llmInvoked,
        startedAt,
        options,
        fallbackReason: "vision_cancelled",
      });
      return;
    }
    const plan = resolution.plan;
    if (plan.summary?.state === "error") {
      if (plan.summary) yield { kind: "vision", summary: plan.summary };
      fallbackReason = "vision_analysis_failed";
      yield toolEvent(cls, "vision-analysis", startedAt, false, fallbackReason);
      const visionFailedReply = localizeReply(language, "visionFailed");
      yield {
        kind: "token",
        text: plan.summary.error
          ? `${visionFailedReply} (${plan.summary.error})`
          : visionFailedReply,
      };
      source = "vision";
      yield* finish({
        requestId,
        prompt,
        cls,
        routeKind: route.kind,
        source,
        tools: toolTraces,
        verifiedFactCount: 0,
        llmInvoked,
        startedAt,
        options,
        fallbackReason,
      });
      return;
    }
    if (plan.summary) yield { kind: "vision", summary: plan.summary };
    yield { kind: "status", phase: "answering" };
    const filter = new CoTFilter();
    let finalMessages = messages;
    if (languageBlock) finalMessages = injectSystemBlock(finalMessages, languageBlock);
    if (plan.systemContext) finalMessages = injectSystemBlock(finalMessages, plan.systemContext);
    llmInvoked = true;
    yield* streamThrough(model, finalMessages, filter, signal, options.model);
    source = "vision";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 1,
      llmInvoked,
      startedAt,
      options,
    });
    return;
  }

  // ---------- Reasoning (general conversation): stream the model directly ----------
  if (cls === "reasoning") {
    yield { kind: "status", phase: "answering" };
    const filter = new CoTFilter();
    const contextBlocks: Array<string | null> = [languageBlock];
    if (options.includeAwareness !== false) contextBlocks.push(awarenessBlock());
    const finalMessages = withSystemContext(messages, contextBlocks);
    llmInvoked = true;
    log.info("[LLM Input]", { requestId, intent: cls, messages: finalMessages.length });
    yield* streamThrough(model, finalMessages, filter, signal, options.model);
    source = "reasoning";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 0,
      llmInvoked,
      startedAt,
      options,
    });
    return;
  }

  // ---------- Client facts (geolocation granted, battery granted) ----------
  if (cls === "location" && options.clientTools?.geolocation?.granted) {
    toolTraces.push({ name: "browser-geolocation", ok: true });
    facts.push({
      tool: "browser-geolocation",
      label,
      subject: "your current location",
      fact: options.clientTools.geolocation,
      executedAt: Date.now(),
    });
  }
  if (
    cls === "system" &&
    detectBattery(q) &&
    options.clientTools?.battery?.granted
  ) {
    toolTraces.push({ name: "battery-status", ok: true });
    facts.push({
      tool: "battery-status",
      label,
      subject: "your device's battery status",
      fact: options.clientTools.battery,
      executedAt: Date.now(),
    });
  }

  // ---------- Naturalize classes: verified tool FIRST, LLM only to summarize ----------
  yield { kind: "status", phase: "tool" };
  if (cls === "location" && options.clientTools?.geolocation?.granted) {
    yield toolEvent(cls, "browser-geolocation", startedAt, true);
  }
  if (
    cls === "system" &&
    detectBattery(q) &&
    options.clientTools?.battery?.granted
  ) {
    yield toolEvent(cls, "battery-status", startedAt, true);
  }
  const filter = new CoTFilter();
  const contextBlocks: Array<string | null> = [languageBlock];
  if (options.includeAwareness !== false) contextBlocks.push(awarenessBlock());
  const base = withSystemContext(messages, contextBlocks);

  let toolsToRun = [...tools];
  let argFor: (tool: string) => Record<string, unknown> = () => ({});

  switch (cls) {
    case "memory": {
      if (detectMemoryStore(q)) {
        toolsToRun = ["remember"];
        argFor = () => ({ content: stripPrefix(q, MEMORY_STORE_PREFIXES) || q });
      } else {
        toolsToRun = ["search_memory"];
        argFor = () => ({ query: stripPrefix(q, MEMORY_RECALL_PREFIXES) || q, limit: 5 });
      }
      break;
    }
    case "tasks": {
      if (detectTaskCreate(q)) {
        toolsToRun = ["create_task"];
        argFor = () => {
          const title = stripPrefix(q, TASK_CREATE_PREFIXES) || q;
          const minutes = extractScheduleMinutes(q);
          return { title, ...(minutes ? { inMinutes: minutes } : {}) };
        };
      } else {
        toolsToRun = ["list_tasks"];
        argFor = () => ({ limit: 20 });
      }
      break;
    }
    case "weather": {
      toolsToRun = ["get_weather"];
      const loc = options.clientTools?.geolocation;
      argFor = () => ({
        latitude: loc?.latitude ?? 0,
        longitude: loc?.longitude ?? 0,
      });
      break;
    }
    case "search": {
      if (detectMaps(q)) {
        toolsToRun = ["maps_link"];
        argFor = () => ({
          query: stripPrefix(q, MAPS_PREFIXES) || q,
          mode: /directions|route|navigate|get\s+to/i.test(q) ? "directions" : "search",
        });
      } else if (detectNews(q)) {
        toolsToRun = ["get_news"];
        argFor = () => ({ limit: 6 });
      } else {
        toolsToRun = ["web_search"];
        argFor = () => ({ query: stripPrefix(q, SEARCH_PREFIXES) || q });
      }
      break;
    }
    case "system": {
      toolsToRun = tools.includes("get_system_status") ? ["get_system_status"] : [];
      argFor = () => ({});
      break;
    }
    case "calendar":
    case "profile":
      argFor = () => ({});
      break;
    default:
      toolsToRun = [];
      break;
  }

  if (toolsToRun.length > 0) {
    const { facts: toolFacts, results } = await executeSteps(toolsToRun, argFor, {
      signal,
      requestId,
    });
    toolTraces.length = 0;
    for (let i = 0; i < toolsToRun.length; i++) {
      toolTraces.push({ name: toolsToRun[i], ok: results[i]?.ok ?? false });
    }
    for (const fact of toolFacts) {
      facts.push({ ...fact, label, subject: route.step.subject });
    }
    const anyOk = results.some((r) => r.ok);
    for (let i = 0; i < toolsToRun.length; i++) {
      if (results[i]?.ok) yield toolEvent(cls, toolsToRun[i], startedAt, true);
    }
    if (!anyOk) {
      const first = results[0];
      fallbackReason =
        first && !first.ok ? first.error.code.toLowerCase() : "tool_failed";
      yield toolEvent(cls, toolsToRun[0], startedAt, false, fallbackReason);
      const reply =
        cls === "weather"
          ? localizeReply(language, "weatherFailed")
          : localizeReply(language, "toolUnavailable");
      yield { kind: "token", text: reply };
      source = cls === "memory" ? "memory" : "tool";
      yield* finish({
        requestId,
        prompt,
        cls,
        routeKind: route.kind,
        source,
        tools: toolTraces,
        verifiedFactCount: facts.length,
        llmInvoked,
        startedAt,
        options,
        fallbackReason,
      });
      return;
    }
  }

  // A naturalize class with a required tool/client fact MUST have verified
  // data before the model is allowed to speak. If none was gathered, refuse.
  if (facts.length === 0) {
    fallbackReason = "no_verified_facts";
    yield toolEvent(cls, tools[0] ?? "none", startedAt, false, fallbackReason);
    yield { kind: "token", text: localizeReply(language, "toolUnavailable") };
    source = cls === "memory" ? "memory" : "tool";
    yield* finish({
      requestId,
      prompt,
      cls,
      routeKind: route.kind,
      source,
      tools: toolTraces,
      verifiedFactCount: 0,
      llmInvoked,
      startedAt,
      options,
      fallbackReason,
    });
    return;
  }

  for (const fact of facts) yield { kind: "fact", tool: fact.tool, subject: fact.subject };
  let finalMessages = injectVerifiedFacts(base, facts);

  if (options.includeMemory !== false) {
    const memoryBlock = await memoryContextBlock(prompt);
    if (memoryBlock) {
      finalMessages = [{ role: "system", content: memoryBlock }, ...finalMessages];
    }
  }

  log.info("[verified-facts]", { count: facts.length, intent: cls });
  yield { kind: "status", phase: "answering" };
  source = cls === "memory" ? "memory" : "tool";
  llmInvoked = true;
  log.info("[LLM Input]", {
    requestId,
    intent: cls,
    messages: finalMessages.length,
    facts: facts.map((f) => ({
      tool: f.tool,
      summary: liveFactSummary(f.fact),
    })),
  });
  yield* streamThrough(model, finalMessages, filter, signal, options.model);
  yield* finish({
    requestId,
    prompt,
    cls,
    routeKind: route.kind,
    source,
    tools: toolTraces,
    verifiedFactCount: facts.length,
    llmInvoked,
    startedAt,
    options,
  });
}

/** Non-streaming convenience wrapper. */
export async function runPipelineText(
  prompt: string,
  messages: AIMessageInput[],
  model: PipelineModel,
  options: PipelineOptions = {}
): Promise<{
  text: string;
  intent: PlanClass;
  source: ResponseSource;
  language: SpokenLanguage;
  events: PipelineEvent[];
}> {
  let text = "";
  let source: ResponseSource = "reasoning";
  const events: PipelineEvent[] = [];
  const language = detectLanguage(prompt).language;
  for await (const event of runPipeline(prompt, messages, model, options)) {
    events.push(event);
    if (event.kind === "token") text += event.text;
    if (event.kind === "source") source = event.source;
  }
  return { text, intent: classifyPlanIntent(prompt), source, language, events };
}
