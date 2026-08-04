/**
 * Intent detectors — deterministic, sub-millisecond classifiers that decide
 * which verified tool must answer a request. The LLM is the last resort and
 * must never fabricate facts that a tool can verify.
 *
 * New detectors are added here, then wired into the planner. Every detector is
 * conservative: a false negative falls back to the LLM, a false positive
 * hijacks a question that should have been answered by a tool.
 */

import {
  parseConversionRequest,
  findUnit,
} from "@/lib/toolkit/convert";
import {
  normalizeCurrency,
  parseCurrencyRequest,
} from "@/lib/toolkit/web";

export type PlanIntent =
  | "vision"
  | "ocr"
  | "system-clock"
  | "geolocation"
  | "weather"
  | "battery"
  | "calculator"
  | "unit-conversion"
  | "currency"
  | "web-search"
  | "news"
  | "maps"
  | "system-status"
  | "memory"
  | "tasks"
  | "llm";

const CALCULATOR_EXPLICIT =
  /\b(?:calculate|compute|evaluate|work\s+out|solve|what'?s|what\s+is|how\s+much\s+is)\b/i;
const ARITHMETIC: RegExp[] = [
  /\b\d+\s*[\+\-\*\/÷×\^%]\s*\d/,
  /\b\d+\s*(?:plus|minus|times|divided\s+by|multiplied\s+by|to\s+the\s+power\s+of|percent\s+of)\b/i,
  /\b(?:sqrt|square\s+root|cube\s+root|sin|cos|tan|ln|log)\s*(?:of\s+)?\s*\d/i,
  /\b\d+\s*\+\s*\d+\b/,
];

export function detectCalculator(text: string): boolean {
  if (!text) return false;
  if (/^\s*\d[\d\s.,+\-*/÷×^%()]*\d?\s*[?]?\s*$/.test(text)) return true;
  if (!CALCULATOR_EXPLICIT.test(text)) return false;
  return ARITHMETIC.some((pattern) => pattern.test(text));
}

export function detectUnitConversion(text: string): boolean {
  if (!text) return false;
  const parsed = parseConversionRequest(text);
  if (!parsed) return false;
  const from = findUnit(parsed.from);
  const to = findUnit(parsed.to);
  if (!from || !to) return false;
  return from.category === to.category;
}

export function detectCurrency(text: string): boolean {
  if (!text) return false;
  const parsed = parseCurrencyRequest(text);
  if (!parsed) return false;
  return normalizeCurrency(parsed.from) !== null && normalizeCurrency(parsed.to) !== null;
}

const MAPS_EXPLICIT: RegExp[] = [
  /\b(?:directions|route|navigate)\s+to\b/i,
  /\bmap\s+of\b/i,
  /\bhow\s+do\s+i\s+get\s+to\b/i,
];
const MAPS_NEAREST = /\bwhere\s+is\s+the\s+(?:nearest|closest|best)\b/i;

export function detectMaps(text: string): boolean {
  if (!text) return false;
  return MAPS_EXPLICIT.some((pattern) => pattern.test(text)) || MAPS_NEAREST.test(text);
}

const NEWS_PATTERNS =
  /\b(?:news|headlines?|top\s+stories?|what'?s\s+happening\s+in\s+the\s+world|tech\s+news|today'?s\s+news)\b/i;

export function detectNews(text: string): boolean {
  if (!text) return false;
  return NEWS_PATTERNS.test(text);
}

const SEARCH_PATTERNS =
  /\b(?:search\s+(?:the\s+web\s+)?(?:for\s+)?|look\s+it?\s+up|look\s+up|google\s+|web\s+search\s+(?:for\s+)?|find\s+out)\b/i;

export function detectWebSearch(text: string): boolean {
  if (!text) return false;
  return SEARCH_PATTERNS.test(text);
}

const SYSTEM_STATUS_PATTERNS: RegExp[] = [
  /\b(?:cpu|processor)\s+(?:usage|load|percent|percentage|utilization|speed|model|cores)\b/i,
  /\b(?:ram|memory)\s+(?:usage|used|available|free|left|remaining|percent)\b/i,
  /\bhow\s+much\s+(?:ram|memory|disk|storage|space)\b/i,
  /\b(?:disk|storage|hard\s+drive|ssd|drive)\s+(?:usage|space|free|left|available|full)\b/i,
  /\bhow\s+is\s+the\s+(?:cpu|memory|disk|storage|system)\b/i,
  /\bsystem\s+status\b/i,
  /\b(?:network|wifi|internet)\s+(?:status|connection|connected|speed|down|up)\b/i,
  /\bhow\s+fast\s+is\s+the\s+(?:cpu|processor)\b/i,
];

export function detectSystemStatus(text: string): boolean {
  if (!text) return false;
  return SYSTEM_STATUS_PATTERNS.some((pattern) => pattern.test(text));
}

const MEMORY_STORE_PATTERNS =
  /\b(?:remember|note\s+down|note\s+that|don'?t\s+forget|do\s+not\s+forget|store\s+in\s+memory)\s+(?:that|this|to|the|my|i|we)?/i;
const MEMORY_RECALL_PATTERNS =
  /\b(?:what\s+do\s+you\s+remember|search\s+(?:your\s+)?memory|recall|what\s+do\s+you\s+know\s+about\s+me|my\s+(?:preferences?|favorite|favourites?|goals?|routine|name)\b)/i;

export function detectMemoryStore(text: string): boolean {
  if (!text) return false;
  return MEMORY_STORE_PATTERNS.test(text);
}

export function detectMemoryRecall(text: string): boolean {
  if (!text) return false;
  return MEMORY_RECALL_PATTERNS.test(text);
}

export function detectMemory(text: string): boolean {
  return detectMemoryStore(text) || detectMemoryRecall(text);
}

const TASK_CREATE_PATTERNS: RegExp[] = [
  /\b(?:remind\s+me|remind\s+us)\b/i,
  /\b(?:create|add|make|schedule|set)\s+(?:a|an|the)?\s*(?:task|reminder|todo|to-do|alarm|event)\b/i,
];
const TASK_LIST_PATTERNS: RegExp[] = [
  /\b(?:what\s+(?:tasks|reminders|todos|to-dos)\s+do\s+i\s+have|list\s+(?:my\s+)?(?:tasks|reminders|todos)|show\s+(?:my\s+)?(?:tasks|reminders))\b/i,
];
const TASK_ACTION_PATTERNS: RegExp[] = [
  /\b(?:run|cancel|delete|remove|retry|complete)\s+(?:the\s+)?(?:task|reminder)\b/i,
  /\btask\s+(?:engine|manager|status)\b/i,
];

export function detectTaskCreate(text: string): boolean {
  if (!text) return false;
  return TASK_CREATE_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTaskList(text: string): boolean {
  if (!text) return false;
  return TASK_LIST_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTaskAction(text: string): boolean {
  if (!text) return false;
  return TASK_ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTasks(text: string): boolean {
  return detectTaskCreate(text) || detectTaskList(text) || detectTaskAction(text);
}
