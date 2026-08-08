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
  createWaterfall,
  formatWaterfall,
  getCurrentWaterfall,
  setCurrentWaterfall,
} from "@/lib/metrics/waterfall";
import {
  detectLanguage,
  logLanguageDetection,
  type SpokenLanguage,
} from "@/lib/lang/detect";
import { localizeConversationalReply, localizeReply } from "@/lib/lang/replies";
import {
  DEFAULT_SYSTEM_PROMPT,
  buildVerifiedFactContext,
  languageInstruction,
} from "@/lib/ai/prompts";
import type { VisionAnalysisSummary } from "@/lib/ai/prompts";
import { classifyVisionDepth } from "@/lib/ai/vision-intent";
import { formatDateIn, formatTimeIn } from "@/lib/time/time-service";
import { getSystemClock, logTimeService } from "@/lib/time/time-service";
import { extractDateTokens } from "@/lib/time/date-calc";
import type { VisionFrameInput } from "@/lib/vision/vision-manager";
import type { AIMessageInput } from "@/lib/ai/types";
import { parseConversionRequest } from "@/lib/toolkit/convert";
import { enrichSearchQuery, normalizeCurrency, parseCurrencyRequest } from "@/lib/toolkit/web";
import { getContextEngine } from "@/services/context/context-engine";
import type { BatteryFact, WeatherFact } from "@/lib/ai/system-tools";
import {
  classifyPlanIntent,
  planRoute,
  type PlanClass,
} from "@/services/planner";
import {
  detectBattery,
  detectConversational,
  detectDateCalc,
  detectDateCorrection,
  detectGreeting,
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
import { assertFactInvariant, HINDI_WEEKDAYS } from "./fact-authority";

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
    maxTokens?: number;
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
    `Today is ${clock.date} (verified). The current local time is ${clock.time} (${clock.timezone}).`,
    `Verified data from the TimeService tool — this is the ONLY source of truth for the current date, time, timezone and greeting:
${JSON.stringify({
  iso: clock.iso,
  unixMs: clock.unixMs,
  time: clock.time,
  date: clock.date,
  timezone: clock.timezone,
  greeting: clock.greeting,
  dayPart: clock.dayPart,
})}`,
  ];
  try {
    const engine = getContextEngine();
    if (engine.isRunning()) {
      const snapshot = engine.getAwareness();
      if (snapshot.server || snapshot.client) {
        blocks.push(
          `Live environment snapshot (verified at ${clock.iso}):\n${JSON.stringify(
            snapshot
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
  const wf = getCurrentWaterfall();
  wf?.mark("memory_lookup");
  wf?.count("memoryCalls");
  let memoryService: MemoryLike;
  try {
    const mod = await import("@/lib/memory");
    memoryService = mod.memoryService as MemoryLike;
  } catch {
    wf?.end("memory_lookup");
    return null;
  }
  try {
    const entries = await memoryService.listEntries({
      status: "approved",
      search: prompt.slice(0, 120),
      limit: 3,
    });
    if (!entries || entries.length === 0) {
      wf?.end("memory_lookup");
      return null;
    }
    wf?.end("memory_lookup");
    return `Relevant long-term memories about this user:\n${entries
      .map((entry) => `- [${entry.category}] ${entry.content}`)
      .join("\n")}`;
  } catch {
    wf?.end("memory_lookup");
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

/**
 * Recover the date question a correction refers to ("No, check again." after
 * "What day is 15 Aug 2026?"). Scans the user's PRIOR turns (never the current
 * prompt) for a date-calc question. History only identifies WHICH date to
 * re-check — it can never change the deterministic answer.
 */
function findPriorDateQuestion(messages: AIMessageInput[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (detectDateCalc(message.content) && extractDateTokens(message.content).length > 0) {
      return message.content;
    }
  }
  return null;
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
  if (cls === "date-calc") return { text };
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
  if (cls === "date-calc") {
    const d = data as {
      kind?: string;
      display?: string;
      weekday?: string;
      localMs?: number;
      days?: number;
      startDisplay?: string;
      endDisplay?: string;
    };
    if (d.kind === "weekday" && typeof d.weekday === "string" && typeof d.display === "string") {
      if (language === "hindi") {
        const localized = typeof d.localMs === "number" ? formatDateIn(language, d.localMs) : null;
        const day = HINDI_WEEKDAYS[d.weekday] ?? d.weekday;
        return `${localized ?? d.display} ${day} का दिन है।`;
      }
      if (language === "hinglish") {
        const localized = typeof d.localMs === "number" ? formatDateIn(language, d.localMs) : null;
        return `${localized ?? d.display} ${d.weekday} ko pada hai.`;
      }
      return `${d.display} is a ${d.weekday}.`;
    }
    if (
      (d.kind === "days-until" || d.kind === "days-since") &&
      typeof d.days === "number" &&
      typeof d.display === "string"
    ) {
      const days = d.days;
      if (language === "hindi") {
        return d.kind === "days-until"
          ? `${d.display} तक ${days} दिन बाकी हैं।`
          : `${d.display} को ${days} दिन हुए हैं।`;
      }
      if (language === "hinglish") {
        return d.kind === "days-until"
          ? `${d.display} tak ${days} din baaki hain.`
          : `${d.display} ko ${days} din hue hain.`;
      }
      return d.kind === "days-until"
        ? `There are ${days} days until ${d.display}.`
        : `It has been ${days} days since ${d.display}.`;
    }
    if (
      d.kind === "days-between" &&
      typeof d.days === "number" &&
      typeof d.startDisplay === "string" &&
      typeof d.endDisplay === "string"
    ) {
      return `There are ${d.days} days between ${d.startDisplay} and ${d.endDisplay}.`;
    }
    return null;
  }
  return null;
}

/**
 * Phase 8 safety invariant: the weekday the user sees MUST be the weekday the
 * deterministic date tool computed. Any direct answer that does not contain
 * the verified weekday (in the emitted language — English or Hindi) is a
 * DATE_INVARIANT_VIOLATION — it must never reach the user, and it is logged
 * with the expected vs actual values. Delegates to the general Fact Authority
 * layer, which also guards math/conversion/time/date/weather/system answers.
 */
export function assertDateInvariant(
  cls: PlanClass,
  data: unknown,
  text: string | null,
  language: SpokenLanguage
): { expected: string; actual: string } | null {
  return assertFactInvariant(
    cls,
    [
      {
        tool: "get_weekday_for_date",
        label: "Date",
        subject: "the date",
        fact: data,
        executedAt: Date.now(),
      },
    ],
    text,
    language
  );
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

const HINDI_CONDITIONS: Record<string, string> = {
  "Clear sky": "आसमान साफ़ है",
  "Mainly clear": "ज्यादातर साफ़ है",
  "Partly cloudy": "आंशिक बादल छाए हैं",
  Overcast: "पूरी तरह बादल छाए हैं",
  Fog: "कोहरा है",
  "Depositing rime fog": "घना कोहरा है",
  "Light drizzle": "हल्की बूंदाबांदी है",
  Drizzle: "बूंदाबांदी है",
  "Dense drizzle": "तेज़ बूंदाबांदी है",
  "Light rain": "हल्की बारिश है",
  Rain: "बारिश हो रही है",
  "Heavy rain": "तेज़ बारिश है",
  "Light snow": "हल्की बर्फबारी है",
  Snow: "बर्फबारी हो रही है",
  "Heavy snow": "तेज़ बर्फबारी है",
  "Rain showers": "बारिश की बौछारें हैं",
  "Thunderstorm": "आंधी-तूफान है",
  Unknown: "अज्ञात",
};

function formatWeatherDirect(
  weather: WeatherFact,
  language: SpokenLanguage
): string {
  const temp = weather.temperatureC;
  const feels = weather.feelsLikeC;
  const humidity = weather.humidity;
  const wind = weather.windSpeedKmh;
  const condition =
    language === "hindi"
      ? (HINDI_CONDITIONS[weather.condition] ?? weather.condition)
      : weather.condition;

  const tempPart =
    temp !== null
      ? `${temp}°C${feels !== null ? ` (feels like ${feels}°C)` : ""}`
      : null;
  if (language === "hindi") {
    const core = tempPart
      ? `अभी तापमान ${tempPart} है, ${condition}।`
      : `अभी ${condition}।`;
    const extras = [];
    if (humidity !== null) extras.push(`आर्द्रता ${Math.round(humidity)}%`);
    if (wind !== null) extras.push(`हवा ${Math.round(wind)} किमी/घंटा`);
    return extras.length > 0 ? `${core} ${extras.join(", ")}।` : core;
  }
  if (language === "hinglish") {
    const core = tempPart
      ? `Abhi temperature ${tempPart} hai, ${weather.condition}.`
      : `Abhi ${weather.condition} hai.`;
    const extras = [];
    if (humidity !== null) extras.push(`humidity ${Math.round(humidity)}%`);
    if (wind !== null) extras.push(`wind ${Math.round(wind)} km/h`);
    return extras.length > 0 ? `${core} ${extras.join(", ")}.` : core;
  }
  const core = tempPart
    ? `It's currently ${tempPart} and ${weather.condition.toLowerCase()}.`
    : `It's currently ${weather.condition.toLowerCase()}.`;
  const extras = [];
  if (humidity !== null) extras.push(`humidity at ${Math.round(humidity)}%`);
  if (wind !== null) extras.push(`wind at ${Math.round(wind)} km/h`);
  return extras.length > 0 ? `${core} Conditions: ${extras.join(", ")}.` : core;
}

function formatBatteryDirect(
  battery: BatteryFact,
  language: SpokenLanguage
): string {
  const level = battery.levelPercent;
  if (language === "hindi") {
    return `आपकी बैटरी ${level}% है${battery.charging ? " और चार्ज हो रही है" : " और चार्ज नहीं हो रही"}।`;
  }
  if (language === "hinglish") {
    return `Aapki battery ${level}% hai${battery.charging ? " aur charging ho rahi hai" : " aur charging nahi ho rahi"}.`;
  }
  return `Your battery is at ${level}%${battery.charging ? " and charging" : " and not charging"}.`;
}

/**
 * Deterministic formatting for naturalize classes whose verified fact set is
 * complete enough to answer directly — the reasoning model is skipped entirely.
 * Returns null when LLM naturalization is still required.
 */
function tr(
  language: SpokenLanguage,
  en: string,
  hi: string,
  hinglish: string
): string {
  if (language === "hindi") return hi;
  if (language === "hinglish") return hinglish;
  return en;
}

function formatMemorySearchDirect(
  fact: unknown,
  language: SpokenLanguage
): string {
  const f = fact as {
    count?: number;
    entries?: Array<{ content?: string }>;
  };
  const entries = (f.entries ?? []).filter((e) => e.content);
  if (f.count === 0 || entries.length === 0) {
    return tr(
      language,
      "I couldn't find anything in my memory about that.",
      "मुझे इसके बारे में अपनी स्मृति में कुछ नहीं मिला।",
      "Mujhe iske baare mein apni memory mein kuch nahi mila."
    );
  }
  const list = entries
    .slice(0, 5)
    .map((e) => `- ${e.content}`)
    .join("\n");
  const head =
    entries.length === 1
      ? tr(language, "Here's what I remember:", "मुझे यह याद है:", "Mujhe ye yaad hai:")
      : tr(
          language,
          `Here's what I remember (${f.count} matches):`,
          `मुझे ये याद हैं (${f.count} मिलान):`,
          `Mujhe ye yaadein hain (${f.count} matches):`
        );
  return `${head}\n${list}`;
}

function formatMemoryStoredDirect(_fact: unknown, language: SpokenLanguage): string {
  return tr(
    language,
    "Got it — I've stored that in memory.",
    "ठीक है — मैंने इसे अपनी स्मृति में संग्रहीत कर लिया है।",
    "Theek hai — maine ise memory mein store kar liya."
  );
}

function formatTasksListDirect(
  fact: unknown,
  language: SpokenLanguage
): string {
  const f = fact as {
    count?: number;
    tasks?: Array<{ title?: string; status?: string }>;
  };
  const tasks = (f.tasks ?? []).filter((t) => t.title);
  if (f.count === 0 || tasks.length === 0) {
    return tr(
      language,
      "You have no tasks right now.",
      "अभी आपके पास कोई कार्य नहीं है।",
      "Abhi aapke paas koi task nahi hai."
    );
  }
  const list = tasks
    .slice(0, 8)
    .map((t) => `- ${t.title}${t.status ? ` (${t.status})` : ""}`)
    .join("\n");
  const head = tr(
    language,
    `You have ${f.count} task${f.count === 1 ? "" : "s"}:`,
    `आपके पास ${f.count} कार्य ${f.count === 1 ? "है" : "हैं"}:`,
    `Aapke paas ${f.count} task${f.count === 1 ? "" : "s"} hain:`
  );
  return `${head}\n${list}`;
}

function formatTaskCreatedDirect(
  fact: unknown,
  language: SpokenLanguage
): string {
  const f = fact as {
    title?: string;
    scheduledAt?: number | null;
    nextRunAt?: number | null;
  };
  const title = f.title ?? "";
  let reply = tr(
    language,
    `Task created${title ? `: "${title}"` : ""}.`,
    `कार्य बनाया गया${title ? `: "${title}"` : ""}।`,
    `Task ban gaya${title ? `: "${title}"` : ""}.`
  );
  const at = f.scheduledAt ?? f.nextRunAt;
  if (typeof at === "number" && Number.isFinite(at)) {
    const time = new Date(at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    reply += tr(
      language,
      ` Scheduled for ${time}.`,
      ` ${time} के लिए निर्धारित।`,
      ` ${time} ke liye scheduled.`
    );
  }
  return reply;
}

function formatCalendarDirect(
  fact: unknown,
  language: SpokenLanguage
): string {
  const f = fact as {
    count?: number;
    items?: Array<{ title?: string; status?: string; at?: number | null }>;
  };
  const items = (f.items ?? []).filter((it) => it.title);
  if (f.count === 0 || items.length === 0) {
    return tr(
      language,
      "You have nothing scheduled today.",
      "आज आपके लिए कुछ भी निर्धारित नहीं है।",
      "Aaj aapke liye kuch bhi scheduled nahi hai."
    );
  }
  const list = items
    .slice(0, 6)
    .map((it) => {
      const time =
        typeof it.at === "number" && Number.isFinite(it.at)
          ? new Date(it.at).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })
          : null;
      const status =
        it.status && it.status !== "scheduled" ? ` (${it.status})` : "";
      return `- ${time ? `${time} — ` : ""}${it.title}${status}`;
    })
    .join("\n");
  const head = tr(
    language,
    `Your schedule today (${f.count} item${f.count === 1 ? "" : "s"}):`,
    `आज का आपका कार्यक्रम (${f.count} आइटम):`,
    `Aaj ka aapka schedule (${f.count} items):`
  );
  return `${head}\n${list}`;
}

function formatProfileDirect(
  fact: unknown,
  q: string,
  language: SpokenLanguage
): string {
  const f = fact as {
    name?: string | null;
    nickname?: string | null;
    occupation?: string | null;
    skills?: string[] | null;
    interests?: string[] | null;
    goals?: string[] | null;
    location?: string | null;
  };
  if (/my\s+name|who\s+am\s+i|naam|नाम/i.test(q) && f.name) {
    return tr(
      language,
      `Your name is ${f.name}.`,
      `आपका नाम ${f.name} है।`,
      `Aapka naam ${f.name} hai.`
    );
  }
  const parts: string[] = [];
  if (f.name) parts.push(f.name);
  if (f.occupation) parts.push(f.occupation);
  if (f.interests?.length) {
    parts.push(
      `interested in ${f.interests.slice(0, 4).join(", ")}`
    );
  }
  if (f.skills?.length) {
    parts.push(`skilled in ${f.skills.slice(0, 4).join(", ")}`);
  }
  if (parts.length === 0) {
    return tr(
      language,
      "I don't have a stored profile yet.",
      "अभी मेरे पास कोई संग्रहीत प्रोफ़ाइल नहीं है।",
      "Abhi mere paas koi stored profile nahi hai."
    );
  }
  const summary = `${parts[0]}`;
  const rest = parts.slice(1).join(", ");
  const body = rest ? `${summary} — ${rest}` : summary;
  return tr(
    language,
    `Here's your profile: ${body}.`,
    `यहाँ आपकी प्रोफ़ाइल है: ${body}।`,
    `Yeh rahi aapki profile: ${body}.`
  );
}

function formatSystemStatusDirect(
  fact: unknown,
  language: SpokenLanguage
): string {
  const f = fact as {
    cpu?: { loadPercent?: number };
    memory?: { usedPercent?: number };
    disk?: { usedPercent?: number | null };
  };
  const parts: string[] = [];
  if (typeof f.cpu?.loadPercent === "number") {
    parts.push(`CPU ${Math.round(f.cpu.loadPercent)}%`);
  }
  if (typeof f.memory?.usedPercent === "number") {
    parts.push(`memory ${Math.round(f.memory.usedPercent)}%`);
  }
  if (typeof f.disk?.usedPercent === "number") {
    parts.push(`disk ${Math.round(f.disk.usedPercent)}%`);
  }
  if (parts.length === 0) return "";
  return tr(
    language,
    `Current usage: ${parts.join(", ")}.`,
    `वर्तमान उपयोग: ${parts.join(", ")}।`,
    `Current usage: ${parts.join(", ")} hai.`
  );
}

function formatSearchDirect(fact: unknown, language: SpokenLanguage): string {
  const f = fact as {
    answer?: string | null;
    abstract?: string | null;
    heading?: string | null;
    source?: string | null;
    topics?: Array<{ text?: string }>;
  };
  if (f.answer?.trim()) return f.answer.trim();
  if (f.abstract?.trim()) {
    const prefix = f.source ? `According to ${f.source}: ` : "";
    return `${prefix}${f.abstract.trim()}`;
  }
  if (f.heading?.trim()) return f.heading.trim();
  const topics = (f.topics ?? []).map((t) => t.text).filter(Boolean);
  if (topics.length > 0) {
    return topics.slice(0, 3).map((t) => `- ${t}`).join("\n");
  }
  return tr(
    language,
    "I couldn't find anything for that.",
    "मुझे इसके लिए कुछ नहीं मिला।",
    "Mujhe iske liye kuch nahi mila."
  );
}

function formatNewsDirect(fact: unknown, language: SpokenLanguage): string {
  const f = fact as { stories?: Array<{ title?: string }> };
  const stories = (f.stories ?? []).map((s) => s.title).filter(Boolean);
  if (stories.length === 0) {
    return tr(
      language,
      "I couldn't fetch the news right now.",
      "मैं अभी समाचार नहीं ला सका।",
      "Main abhi news nahi la paya."
    );
  }
  const list = stories
    .slice(0, 6)
    .map((title, i) => `${i + 1}. ${title}`)
    .join("\n");
  return tr(
    language,
    `Here are the latest headlines:\n${list}`,
    `ताज़ा समाचार शीर्षक:\n${list}`,
    `Latest headlines:\n${list}`
  );
}

function formatMapsDirect(fact: unknown, language: SpokenLanguage): string {
  const f = fact as { url?: string; mode?: string };
  if (!f.url) return "";
  const prefix =
    f.mode === "directions"
      ? tr(
          language,
          "Here are the directions:",
          "ये रही दिशाएँ:",
          "Directions ye hain:"
        )
      : tr(
          language,
          "Here's where to find it:",
          "यहाँ देखें:",
          "Yahan dekho:"
        );
  return `${prefix} ${f.url}`;
}

function formatDirectNaturalize(
  cls: PlanClass,
  q: string,
  facts: VerifiedFact[],
  language: SpokenLanguage
): string | null {
  if (cls === "weather") {
    const fact = facts.find((f) => f.tool === "get_weather");
    const weather = fact?.fact as WeatherFact | undefined;
    if (weather && typeof weather.temperatureC === "number") {
      return formatWeatherDirect(weather, language);
    }
    return null;
  }
  if (cls === "system" && detectBattery(q)) {
    const fact = facts.find((f) => f.tool === "battery-status");
    const battery = fact?.fact as BatteryFact | undefined;
    if (battery && typeof battery.levelPercent === "number") {
      return formatBatteryDirect(battery, language);
    }
    return null;
  }
  if (cls === "system" && !detectBattery(q)) {
    const fact = facts.find((f) => f.tool === "get_system_status");
    if (fact) return formatSystemStatusDirect(fact.fact, language) || null;
    return null;
  }
  if (cls === "memory") {
    const stored = facts.find((f) => f.tool === "remember");
    if (stored) return formatMemoryStoredDirect(stored.fact, language);
    const search = facts.find(
      (f) => f.tool === "search_memory" || f.tool === "list_memories"
    );
    if (search) return formatMemorySearchDirect(search.fact, language);
    return null;
  }
  if (cls === "tasks") {
    const created = facts.find((f) => f.tool === "create_task");
    if (created) return formatTaskCreatedDirect(created.fact, language);
    const listed = facts.find((f) => f.tool === "list_tasks");
    if (listed) return formatTasksListDirect(listed.fact, language);
    return null;
  }
  if (cls === "calendar") {
    const fact = facts.find((f) => f.tool === "get_calendar");
    if (fact) return formatCalendarDirect(fact.fact, language);
    return null;
  }
  if (cls === "profile") {
    const fact = facts.find((f) => f.tool === "get_owner_profile");
    if (fact) return formatProfileDirect(fact.fact, q, language);
    return null;
  }
  if (cls === "search") {
    const news = facts.find((f) => f.tool === "get_news");
    if (news) return formatNewsDirect(news.fact, language);
    const maps = facts.find((f) => f.tool === "maps_link");
    if (maps) return formatMapsDirect(maps.fact, language);
    const search = facts.find((f) => f.tool === "web_search");
    if (search) return formatSearchDirect(search.fact, language);
    return null;
  }
  return null;
}

async function executeSteps(
  tools: string[],
  argFor: (tool: string) => Record<string, unknown>,
  options: { signal?: AbortSignal; requestId?: string } = {}
): Promise<{ facts: VerifiedFact[]; results: ToolResult[] }> {
  const wf = getCurrentWaterfall();
  const toolStartedAt = Date.now();
  wf?.mark("tool_execution");
  const facts: VerifiedFact[] = [];
  const results: ToolResult[] = [];
  for (const tool of tools) {
    wf?.count("toolCalls");
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
  wf?.end("tool_execution");
  wf?.addTool(Date.now() - toolStartedAt);
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
  const wf = getCurrentWaterfall();
  const llmStartedAt = Date.now();
  wf?.count("llmCalls");
  wf?.mark("llm_first_token");
  for await (const token of model.streamText({ messages, signal, model: modelName })) {
    if (wf) {
      wf.setFirstToken();
      wf.end("llm_first_token");
      wf.mark("llm_complete");
    }
    const clean = filter.push(token);
    if (clean) {
      wf?.addResponse(clean.length);
      yield { kind: "token", text: clean };
    }
  }
  const tail = filter.flush();
  if (tail) {
    wf?.addResponse(tail.length);
    yield { kind: "token", text: tail };
  }
  if (wf) {
    wf.end("llm_complete");
    wf.addLlm(Date.now() - llmStartedAt);
  }
}

/**
 * Buffered variant used ONLY where the answer must be verified against the
 * verified facts before it reaches the user (the naturalize path). Collects
 * the model's full output (chain-of-thought stripped), returning it as one
 * string so the Fact Authority can check it, then either emit it as-is or drop
 * it in favour of a deterministic fallback.
 */
async function bufferStreamText(
  model: PipelineModel,
  messages: AIMessageInput[],
  filter: CoTFilter,
  signal?: AbortSignal,
  modelName?: string
): Promise<string> {
  const wf = getCurrentWaterfall();
  const llmStartedAt = Date.now();
  wf?.count("llmCalls");
  wf?.mark("llm_first_token");
  let out = "";
  for await (const token of model.streamText({ messages, signal, model: modelName })) {
    if (wf) {
      wf.setFirstToken();
      wf.end("llm_first_token");
      wf.mark("llm_complete");
    }
    const clean = filter.push(token);
    if (clean) {
      wf?.addResponse(clean.length);
      out += clean;
    }
  }
  const tail = filter.flush();
  if (tail) {
    wf?.addResponse(tail.length);
    out += tail;
  }
  if (wf) {
    wf.end("llm_complete");
    wf.addLlm(Date.now() - llmStartedAt);
  }
  return out;
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
  const wf = getCurrentWaterfall();
  wf?.mark("postprocess");
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
  if (wf) {
    wf.end("postprocess");
    wf.end("request_received");
    log.info("[waterfall]", formatWaterfall(wf.snapshot()));
  }
  setCurrentWaterfall(null);
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

  const wf = createWaterfall(requestId, startedAt, prompt.length);
  setCurrentWaterfall(wf);
  wf.mark("request_received");

  // ---------- Language stage ----------
  // The user's language is detected deterministically (no LLM, sub-5ms) and
  // drives ONLY presentation: the LLM responds in it, direct tool answers are
  // formatted in it, and canned fallbacks are localized. Tool routing and
  // execution stay language independent.
  wf.mark("language_detection");
  const detectionStartedAt = Date.now();
  const detection = detectLanguage(prompt);
  const language = detection.language;
  logLanguageDetection("pipeline", prompt, detection, Date.now() - detectionStartedAt);
  wf.end("language_detection");
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

  wf.mark("planner");
  const route = planRoute(prompt, { clientTools: options.clientTools });
  wf.end("planner");
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

  // ---------- Conversational fast path (no LLM, <100ms) ----------
  // Greetings and casual acknowledgements ("hi", "thanks", "ok", "how are
  // you") are answered with a localized canned reply. The planner already
  // matched them as conversational (route.kind === "llm", cls reasoning); we
  // intercept here so no reasoning model is ever streamed for them.
  if (route.kind === "llm" && detectConversational(q)) {
    const reply = localizeConversationalReply(language, q, detectGreeting(q));
    wf?.addResponse(reply.length);
    yield { kind: "status", phase: "answering" };
    yield { kind: "token", text: reply };
    source = "reasoning";
    llmInvoked = false;
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

  // ---------- Phase 6: a follow-up correction never triggers an LLM guess ----------
  // "No, check again." after a date answer re-runs the deterministic date tool
  // for the previously asked date. History only recovers WHICH date to re-check;
  // it can never change the answer (identical deterministic result).
  if (
    route.kind !== "direct" &&
    cls !== "date-calc" &&
    detectDateCorrection(q)
  ) {
    const priorDateText = findPriorDateQuestion(messages);
    if (!priorDateText) {
      // No date in context to re-check — answer deterministically, never via
      // the reasoning model (a correction must never become a weekday guess).
      yield { kind: "status", phase: "tool" };
      fallbackReason = "date_correction_no_date";
      yield toolEvent(cls, "none", startedAt, false, fallbackReason);
      yield { kind: "token", text: localizeReply(language, "dateCorrection") };
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
        fallbackReason,
      });
      return;
    }
    if (priorDateText) {
      const priorRoute = planRoute(priorDateText);
      if (
        priorRoute.step.cls === "date-calc" &&
        priorRoute.step.tools[0] === "get_weekday_for_date"
      ) {
        yield { kind: "status", phase: "tool" };
        const { results } = await executeSteps(
          ["get_weekday_for_date"],
          () => ({ text: priorDateText }),
          { signal, requestId }
        );
        const result = results[0];
        toolTraces[0] = { name: "get_weekday_for_date", ok: Boolean(result?.ok) };
        if (result?.ok) {
          const text = directAnswer("date-calc", result.data, language);
          if (text) {
            const violation = assertFactInvariant(
              "date-calc",
              [
                {
                  tool: "get_weekday_for_date",
                  label,
                  subject: "the date",
                  fact: result.data,
                  executedAt: Date.now(),
                },
              ],
              text,
              language
            );
            if (violation) {
              log.error("[FACT_INVARIANT_VIOLATION]", {
                requestId,
                expected: violation.expected,
                actual: violation.actual,
              });
              fallbackReason = "fact_invariant_violation";
              yield toolEvent(
                "date-calc",
                "get_weekday_for_date",
                startedAt,
                false,
                fallbackReason
              );
              yield { kind: "token", text: localizeReply(language, "toolUnavailable") };
            } else {
              yield toolEvent("date-calc", "get_weekday_for_date", startedAt, true);
              yield { kind: "fact", tool: "get_weekday_for_date", subject: "the date" };
              yield { kind: "token", text };
            }
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
        }
        fallbackReason = "date_correction_tool_failed";
        yield toolEvent(
          "date-calc",
          "get_weekday_for_date",
          startedAt,
          false,
          fallbackReason
        );
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
    }
  }

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
        const violation = assertFactInvariant(
          cls,
          [
            {
              tool: tools[0],
              label,
              subject: label,
              fact: result.data,
              executedAt: Date.now(),
            },
          ],
          text,
          language
        );
        if (violation) {
          log.error("[FACT_INVARIANT_VIOLATION]", {
            requestId,
            expected: violation.expected,
            actual: violation.actual,
          });
          fallbackReason = "fact_invariant_violation";
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
      requestId,
    });
    if (resolution.kind === "direct" || resolution.kind === "direct-vlm") {
      const answeredFrom =
        resolution.kind === "direct-vlm"
          ? resolution.grounding?.source === "scene-cache"
            ? "Scene Cache"
            : "Gemma"
          : "Scene Cache";
      log.info("[VisionFinal]", {
        requestId,
        source: answeredFrom,
        grounding: resolution.grounding ?? null,
        latencyMs: Date.now() - startedAt,
      });
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
    wf.mark("context_build");
    let finalMessages = messages;
    if (languageBlock) finalMessages = injectSystemBlock(finalMessages, languageBlock);
    if (plan.systemContext) finalMessages = injectSystemBlock(finalMessages, plan.systemContext);
    wf.end("context_build");
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
    wf.mark("context_build");
    const contextBlocks: Array<string | null> = [languageBlock];
    if (options.includeAwareness !== false) contextBlocks.push(awarenessBlock());
    const finalMessages = withSystemContext(messages, contextBlocks);
    wf.end("context_build");
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
      // Missing coordinates must surface as a typed failure, never default to
      // (0,0) "Null Island" weather presented as verified.
      argFor = () => ({
        latitude: loc?.latitude,
        longitude: loc?.longitude,
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
        argFor = () => {
          // Carry conversational context into the query: a follow-up like
          // "who is the current prime minister?" after "...of india?" reuses
          // the place from the earlier turn instead of re-searching in a void.
          const priorUser = messages
            .filter((m) => m.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .filter(Boolean);
          return { query: enrichSearchQuery(stripPrefix(q, SEARCH_PREFIXES) || q, priorUser) };
        };
      }
      break;
    }
    case "system": {
      const batteryOnly =
        detectBattery(q) && options.clientTools?.battery?.granted;
      toolsToRun = batteryOnly
        ? []
        : tools.includes("get_system_status")
          ? ["get_system_status"]
          : [];
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

  // ---------- Direct formatting for complete verified fact sets (no LLM) ----------
  // Weather and battery carry closed, complete fact sets that format
  // deterministically — the reasoning model is skipped entirely.
  const directNaturalize = formatDirectNaturalize(cls, q, facts, language);
  if (directNaturalize) {
    // Fact Authority defense-in-depth: even deterministic formatting is
    // re-checked before emission, so a formatting bug can never ship a value
    // that contradicts the verified data.
    const violation = assertFactInvariant(cls, facts, directNaturalize, language);
    if (violation) {
      log.error("[FACT_INVARIANT_VIOLATION]", {
        requestId,
        expected: violation.expected,
        actual: violation.actual,
      });
      fallbackReason = "fact_invariant_violation";
      yield toolEvent(cls, tools[0] ?? "none", startedAt, false, fallbackReason);
      yield { kind: "token", text: localizeReply(language, "toolUnavailable") };
      source = "tool";
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
    wf?.addResponse(directNaturalize.length);
    yield { kind: "status", phase: "answering" };
    for (const fact of facts) {
      yield { kind: "fact", tool: fact.tool, subject: fact.subject };
    }
    yield { kind: "token", text: directNaturalize };
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
    });
    return;
  }

  for (const fact of facts) yield { kind: "fact", tool: fact.tool, subject: fact.subject };
  wf.mark("context_build");
  let finalMessages = injectVerifiedFacts(base, facts);

  if (options.includeMemory !== false) {
    const memoryBlock = await memoryContextBlock(prompt);
    if (memoryBlock) {
      finalMessages = [{ role: "system", content: memoryBlock }, ...finalMessages];
    }
  }
  wf.end("context_build");

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
  // Fact Authority guard: buffer the model's naturalization and verify it
  // against the verified facts BEFORE it reaches the user. A contradiction
  // (e.g. the model changing a temperature) is dropped in favour of the
  // deterministic direct format — the user never sees an unverified override.
  const emitted = await bufferStreamText(model, finalMessages, filter, signal, options.model);
  const violation = assertFactInvariant(cls, facts, emitted, language);
  if (violation) {
    log.error("[FACT_INVARIANT_VIOLATION]", {
      requestId,
      expected: violation.expected,
      actual: violation.actual,
    });
    fallbackReason = "fact_invariant_violation";
    const direct = formatDirectNaturalize(cls, q, facts, language);
    yield { kind: "token", text: direct ?? localizeReply(language, "toolUnavailable") };
  } else if (emitted) {
    yield { kind: "token", text: emitted };
  } else {
    yield { kind: "token", text: localizeReply(language, "toolUnavailable") };
  }
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
