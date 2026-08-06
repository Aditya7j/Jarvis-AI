/**
 * Intent Planner — the deterministic decision layer of JARVIS.
 *
 * Runs before any model call and classifies EVERY request into one of 14
 * classes, then answers three questions per request:
 *   1. Which verified tools must supply the facts?
 *   2. Direct (format tool output, no LLM), naturalize (LLM summarizes verified
 *      facts), or LLM-only (general conversation / reasoning)?
 *   3. Which client-gated facts (location/battery/clock) are required?
 *
 * The reasoning model is the LAST component. If a tool can answer, the LLM
 * never gets to guess. A tool-backed class MUST execute its tool before the
 * model is allowed to speak; if the tool fails, the assistant says it could
 * not verify the information.
 */

import { classifyVisionIntent } from "@/lib/ai/vision-intent";
import {
  detectBattery,
  detectCalendar,
  detectCalculator,
  detectConversational,
  detectCurrency,
  detectDate,
  detectGeolocation,
  detectMaps,
  detectMemory,
  detectMemoryStore,
  detectNews,
  detectOcr,
  detectProfile,
  detectSystemStatus,
  detectTaskCreate,
  detectTasks,
  detectTime,
  detectUnitConversion,
  detectWeather,
  detectWebSearch,
} from "./intents";
import {
  DIRECT_CLASSES,
  type PlanAudit,
  type PlanClass,
  type PlanInput,
  type PlanRoute,
  type PlanStep,
} from "./types";

export type { PlanClass };

export const CLASS_LABELS: Record<PlanClass, string> = {
  reasoning: "Reasoning Model",
  math: "Calculator",
  memory: "Memory Engine",
  vision: "Vision System",
  time: "System Clock",
  date: "System Clock",
  weather: "Weather API",
  location: "Browser Geolocation API",
  calendar: "Calendar",
  tasks: "Task Engine",
  profile: "Owner Profile",
  system: "System Monitor",
  conversion: "Unit/Currency Converter",
  search: "Web Search",
};

/** Tool Router tool names that back each class (per-request refinement below). */
export function toolsForClass(cls: PlanClass, text: string): string[] {
  switch (cls) {
    case "math":
      return ["calculate"];
    case "conversion":
      return detectCurrency(text) ? ["convert_currency"] : ["convert_units"];
    case "time":
    case "date":
      return ["get_current_time"];
    case "weather":
      return ["get_weather"];
    case "calendar":
      return ["get_calendar"];
    case "profile":
      return ["get_owner_profile"];
    case "memory":
      return detectMemoryStore(text) ? ["remember"] : ["search_memory"];
    case "tasks":
      return detectTaskCreate(text) ? ["create_task"] : ["list_tasks"];
    case "system":
      return detectBattery(text) ? [] : ["get_system_status"];
    case "search": {
      if (detectMaps(text)) return ["maps_link"];
      if (detectNews(text)) return ["get_news"];
      return ["web_search"];
    }
    case "location":
    case "vision":
    case "reasoning":
      return [];
  }
}

/**
 * Deterministic request classification. Precedence:
 * conversational → vision → calendar → profile → tasks → memory → time →
 * date → location → weather → system → conversion → math → search →
 * reasoning.
 */
export function classifyPlanIntent(prompt: string): PlanClass {
  return classifyWithReasons(prompt).cls;
}

/**
 * Classify AND record why. Greetings and casual conversation short-circuit
 * before every tool detector so they can never invoke a tool.
 */
export function classifyWithReasons(prompt: string): {
  cls: PlanClass;
  reasons: string[];
} {
  if (!prompt) return { cls: "reasoning", reasons: ["empty prompt"] };
  const text = prompt.trim();
  if (!text) return { cls: "reasoning", reasons: ["blank prompt"] };

  if (detectConversational(text)) {
    return {
      cls: "reasoning",
      reasons: ["greeting or casual conversation — no tool required"],
    };
  }
  if (detectOcr(text)) {
    return {
      cls: "vision",
      reasons: ["explicit text-reading (OCR) request — needs the camera"],
    };
  }
  if (classifyVisionIntent(text) === "vision") {
    return {
      cls: "vision",
      reasons: ["vision phrasing detected — needs the camera"],
    };
  }
  if (detectCalendar(text)) {
    return {
      cls: "calendar",
      reasons: ["asked about their calendar/schedule/appointments"],
    };
  }
  if (detectProfile(text)) {
    return {
      cls: "profile",
      reasons: ["asked about stored personal information"],
    };
  }
  if (detectTasks(text)) {
    return {
      cls: "tasks",
      reasons: ["asked to create, list or manage tasks/reminders"],
    };
  }
  if (detectMemory(text)) {
    return {
      cls: "memory",
      reasons: ["asked to recall or store a memory"],
    };
  }
  if (detectTime(text)) {
    return { cls: "time", reasons: ["explicitly asked for the current time"] };
  }
  if (detectDate(text)) {
    return { cls: "date", reasons: ["explicitly asked for today's/current date"] };
  }
  if (detectGeolocation(text)) {
    return {
      cls: "location",
      reasons: ["asked where they are — needs browser geolocation"],
    };
  }
  if (detectWeather(text)) {
    return {
      cls: "weather",
      reasons: ["explicitly asked for live weather conditions"],
    };
  }
  if (detectSystemStatus(text) || detectBattery(text)) {
    return {
      cls: "system",
      reasons: ["asked about system resource or battery status"],
    };
  }
  if (detectCurrency(text) || detectUnitConversion(text)) {
    return {
      cls: "conversion",
      reasons: ["asked for a unit or currency conversion"],
    };
  }
  if (detectCalculator(text)) {
    return { cls: "math", reasons: ["asked an arithmetic question"] };
  }
  if (detectMaps(text) || detectNews(text) || detectWebSearch(text)) {
    return {
      cls: "search",
      reasons: ["asked for a web, news or maps lookup"],
    };
  }
  return {
    cls: "reasoning",
    reasons: ["no detector matched — general conversation, no tool required"],
  };
}

function stepFor(cls: PlanClass, text: string): PlanStep {
  const tools = toolsForClass(cls, text);
  const subjectByClass: Partial<Record<PlanClass, string>> = {
    reasoning: "this",
    vision: "what is currently visible",
    math: "the calculation",
    memory: "what JARVIS remembers",
    time: "the current time",
    date: "today's date",
    weather: "the current weather",
    location: "your current location",
    calendar: "your calendar",
    tasks: "your tasks",
    profile: "your profile",
    system: "the system status",
    conversion: "the conversion",
    search: "the search result",
  };
  return {
    cls,
    tools,
    label: CLASS_LABELS[cls],
    subject: subjectByClass[cls] ?? "this",
  };
}

/** The full candidate tool set for a class (before per-request refinement). */
export function toolsConsideredForClass(cls: PlanClass): string[] {
  switch (cls) {
    case "time":
    case "date":
      return ["get_current_time"];
    case "weather":
      return ["get_weather"];
    case "calendar":
      return ["get_calendar"];
    case "profile":
      return ["get_owner_profile"];
    case "memory":
      return ["remember", "search_memory"];
    case "tasks":
      return ["create_task", "list_tasks"];
    case "system":
      return ["get_system_status"];
    case "conversion":
      return ["convert_units", "convert_currency"];
    case "search":
      return ["web_search", "get_news", "maps_link"];
    case "math":
      return ["calculate"];
    case "location":
      return ["browser-geolocation"];
    case "vision":
      return ["vision-analysis"];
    case "reasoning":
      return [];
  }
}

/** Why each selected tool is required, per tool name. */
export const TOOL_REQUIRED_REASONS: Record<string, string> = {
  get_current_time:
    "the user explicitly asked for the current time or date — only the verified system clock can supply it",
  get_weather:
    "the user explicitly asked for live weather — only the weather API can supply it",
  get_calendar:
    "the user asked about their schedule/calendar — only the calendar tool can supply it",
  get_owner_profile:
    "the user asked about stored personal information — only the profile tool can supply it",
  remember: "the user asked to store a new memory",
  search_memory: "the user asked to recall stored memories",
  create_task: "the user asked to create a task or reminder",
  list_tasks: "the user asked for their tasks/reminders",
  get_system_status: "the user asked about system resource status",
  convert_units: "the user asked for a unit conversion",
  convert_currency: "the user asked for a currency conversion",
  calculate: "the user asked an arithmetic question",
  web_search: "the user asked for a web lookup",
  get_news: "the user asked for news or headlines",
  maps_link: "the user asked for directions or a map",
};

function buildAudit(
  prompt: string,
  cls: PlanClass,
  confidence: number,
  reasons: string[],
  tools: string[]
): PlanAudit {
  return {
    prompt,
    intent: cls,
    confidence,
    why: reasons,
    toolsConsidered: toolsConsideredForClass(cls),
    toolsSelected: tools,
    toolReasons: Object.fromEntries(
      tools.map((tool) => [
        tool,
        TOOL_REQUIRED_REASONS[tool] ?? "required to answer this request",
      ])
    ),
  };
}

/** Build the execution plan for a prompt. Never throws, never calls a model. */
export function planRoute(prompt: string, _input: PlanInput = {}): PlanRoute {
  const { cls, reasons } = classifyWithReasons(prompt);
  const step = stepFor(cls, prompt);

  if (DIRECT_CLASSES.has(cls)) {
    const confidence = 100;
    return {
      kind: "direct",
      step,
      reason: "tool output is formatted directly",
      confidence,
      audit: buildAudit(prompt, cls, confidence, reasons, step.tools),
    };
  }
  if (cls === "reasoning") {
    const confidence = 55;
    return {
      kind: "llm",
      step,
      reason: "general conversation — no factual tool",
      confidence,
      audit: buildAudit(prompt, cls, confidence, reasons, step.tools),
    };
  }
  const confidence = 90;
  return {
    kind: "naturalize",
    step,
    reason: "verified tool output is naturalized",
    confidence,
    audit: buildAudit(prompt, cls, confidence, reasons, step.tools),
  };
}

export function toolLabelForClass(cls: PlanClass): string {
  return CLASS_LABELS[cls];
}

export function isDirectClass(cls: PlanClass): boolean {
  return DIRECT_CLASSES.has(cls);
}
