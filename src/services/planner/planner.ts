/**
 * Intent Planner — the deterministic decision layer of JARVIS.
 *
 * Runs before any model call and answers three questions per request:
 *   1. Which verified tools must supply the facts?
 *   2. Direct (format tool output, no LLM), naturalize (LLM presents verified
 *      facts), or LLM-only (general conversation)?
 *   3. Which client-gated facts (location/battery/clock) are required?
 *
 * The reasoning model is the LAST component. If a tool can answer, the LLM
 * never gets to guess.
 */

import { classifyVisionIntent } from "@/lib/ai/vision-intent";
import {
  detectBattery,
  detectCalculator,
  detectCurrency,
  detectGeolocation,
  detectMaps,
  detectMemory,
  detectNews,
  detectOcr,
  detectSystemClock,
  detectSystemStatus,
  detectTasks,
  detectUnitConversion,
  detectWeather,
  detectWebSearch,
  type PlanIntent,
} from "./intents";
import {
  DIRECT_TOOL_INTENTS,
  type PlanInput,
  type PlanRoute,
  type PlanStep,
} from "./types";

export type { PlanIntent };

export const INTENT_LABELS: Record<PlanIntent, string> = {
  vision: "Vision Manager",
  ocr: "Vision Model",
  "system-clock": "System Clock",
  geolocation: "Browser Geolocation API",
  weather: "Weather API",
  battery: "Battery Status API",
  calculator: "Calculator",
  "unit-conversion": "Unit Converter",
  currency: "Currency Converter",
  "web-search": "Web Search",
  news: "News",
  maps: "Maps",
  "system-status": "System Monitor",
  memory: "Memory Engine",
  tasks: "Task Engine",
  llm: "LLM",
};

export const INTENT_TOOLS: Record<PlanIntent, string[]> = {
  vision: [],
  ocr: [],
  "system-clock": ["get_current_time"],
  geolocation: [],
  weather: [],
  battery: [],
  calculator: ["calculate"],
  "unit-conversion": ["convert_units"],
  currency: ["convert_currency"],
  "web-search": ["web_search"],
  news: ["get_news"],
  maps: ["maps_link"],
  "system-status": ["get_system_status"],
  memory: ["search_memory", "remember"],
  tasks: ["create_task", "list_tasks", "run_task"],
  llm: [],
};

/**
 * Deterministic intent classification. Precedence:
 * OCR → vision → tasks → memory → clock → location → weather → battery →
 * currency → unit-conversion → calculator → maps → news → web-search →
 * system-status → LLM.
 */
export function classifyPlanIntent(prompt: string): PlanIntent {
  if (!prompt) return "llm";
  const text = prompt.trim();
  if (!text) return "llm";
  if (detectOcr(text)) return "ocr";
  if (classifyVisionIntent(text) === "vision") return "vision";
  if (detectTasks(text)) return "tasks";
  if (detectMemory(text)) return "memory";
  if (detectSystemClock(text)) return "system-clock";
  if (detectGeolocation(text)) return "geolocation";
  if (detectWeather(text)) return "weather";
  if (detectBattery(text)) return "battery";
  if (detectCurrency(text)) return "currency";
  if (detectUnitConversion(text)) return "unit-conversion";
  if (detectCalculator(text)) return "calculator";
  if (detectMaps(text)) return "maps";
  if (detectWebSearch(text)) return "web-search";
  if (detectNews(text)) return "news";
  if (detectSystemStatus(text)) return "system-status";
  return "llm";
}

function stepFor(intent: PlanIntent): PlanStep {
  const tools = INTENT_TOOLS[intent];
  const subjectByIntent: Partial<Record<PlanIntent, string>> = {
    vision: "what is currently visible",
    ocr: "the text currently visible",
    "system-clock": "the current time, date and timezone",
    geolocation: "your current location",
    weather: "the current weather",
    battery: "your device's battery status",
    calculator: "the calculation",
    "unit-conversion": "the unit conversion",
    currency: "the currency conversion",
    "web-search": "the search result",
    news: "the latest news",
    maps: "the map result",
    "system-status": "the system status",
    memory: "what JARVIS remembers",
    tasks: "your tasks",
  };
  return {
    intent,
    tools,
    label: INTENT_LABELS[intent],
    subject: subjectByIntent[intent] ?? "this",
  };
}

/** Build the execution plan for a prompt. Never throws, never calls a model. */
export function planRoute(prompt: string, _input: PlanInput = {}): PlanRoute {
  const intent = classifyPlanIntent(prompt);
  const step = stepFor(intent);

  if (DIRECT_TOOL_INTENTS.has(intent)) {
    return { kind: "direct", step, reason: "tool output is formatted directly" };
  }
  if (intent === "llm") {
    return { kind: "llm", step, reason: "general conversation — no factual tool" };
  }
  return { kind: "naturalize", step, reason: "verified tool output is naturalized" };
}

export function toolLabelForIntent(intent: PlanIntent): string {
  return INTENT_LABELS[intent];
}

export function isDirectIntent(intent: PlanIntent): boolean {
  return DIRECT_TOOL_INTENTS.has(intent);
}
