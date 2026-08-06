/**
 * Intent Planner types — the shape of a plan produced BEFORE any model call.
 *
 * The planner classifies every request into one of 14 classes and decides
 * deterministically:
 *   1. WHICH verified tools (if any) must provide the facts. A class with a
 *      tool must NEVER be answered by the reasoning model before that tool
 *      has executed successfully.
 *   2. HOW the answer must be produced:
 *        - direct      → tool output is formatted directly, no LLM (<500ms)
 *        - naturalize  → tool output is the ONLY truth; the reasoning model
 *                        summarizes it in natural language
 *        - llm         → general conversation (reasoning), no factual tools
 *   3. WHICH client-gated facts (location/battery/clock) are required.
 */

/**
 * The 14 request classes. Every user request maps to exactly one.
 * Classes with an available tool are tool-backed: the LLM never answers them
 * from memory — it only summarizes verified tool output.
 */
export type PlanClass =
  | "reasoning" // general conversation — no factual tool
  | "math" // arithmetic — calculate tool
  | "memory" // long-term memory — remember / search_memory
  | "vision" // camera/screen content — vision pipeline
  | "time" // current time — get_current_time
  | "date" // today's date / day of week — get_current_time
  | "weather" // current conditions — get_weather
  | "location" // where the user is — browser geolocation
  | "calendar" // schedule/appointments — get_calendar
  | "tasks" // task engine — create/list/run tasks
  | "profile" // owner profile — get_owner_profile
  | "system" // CPU/memory/disk/network/battery — get_system_status or battery
  | "conversion" // unit or currency conversion — convert_units/convert_currency
  | "search"; // web/news/maps lookup — web_search/get_news/maps_link

export interface VerifiedFact {
  /** Tool Router tool name that produced the fact. */
  tool: string;
  /** Human tool label (e.g. "Weather API"). */
  label: string;
  /** Subject the fact is about, for the naturalization block. */
  subject: string;
  fact: unknown;
  executedAt: number;
}

export interface PlanStep {
  /** The request class. */
  cls: PlanClass;
  /** Tool Router tool names to execute, in order. Empty = client-gated or none. */
  tools: string[];
  /** Human-readable label for routing telemetry. */
  label: string;
  /** Subject(s) the facts describe, for naturalization blocks. */
  subject: string;
}

/**
 * Debuggability trail attached to every plan. Explains, without any model call,
 * why the intent was chosen and exactly which tools are required and why.
 */
export interface PlanAudit {
  /** The user's original input. */
  prompt: string;
  /** The chosen request class. */
  intent: PlanClass;
  /** Deterministic routing confidence (0-100). */
  confidence: number;
  /** Why this intent was chosen over the others. */
  why: string[];
  /** Every tool the class can use across phrasings (before refinement). */
  toolsConsidered: string[];
  /** The final tools that will actually execute. */
  toolsSelected: string[];
  /** For each selected tool, why it is required for this request. */
  toolReasons: Record<string, string>;
}

export type PlanRoute =
  | { kind: "direct"; step: PlanStep; reason: string; confidence: number; audit: PlanAudit }
  | { kind: "naturalize"; step: PlanStep; reason: string; confidence: number; audit: PlanAudit }
  | { kind: "llm"; step: PlanStep; reason: string; confidence: number; audit: PlanAudit };

/**
 * Deterministic confidence score (0-100) that the planner's routing is
 * correct and the answer can be produced from verified data:
 *   - direct: tool output is formatted exactly -> maximum confidence.
 *   - naturalize: a verified tool backs every fact, the LLM only formats.
 *   - llm: no tool backs the answer; confidence is low for anything factual.
 */
export function routeConfidence(route: PlanRoute): number {
  return route.confidence;
}

export interface PlanInput {
  /** Browser-provided verified facts (client-gated tools). */
  clientTools?: {
    systemClock?: unknown;
    geolocation?: { granted: boolean; latitude?: number; longitude?: number; accuracyM?: number };
    battery?: { granted: boolean; level?: number; levelPercent?: number; charging?: boolean };
  };
  awareness?: unknown;
}

/**
 * Classes whose verified tool output can be formatted directly, no LLM.
 * The reasoning model must NEVER be invoked for these.
 */
export const DIRECT_CLASSES: ReadonlySet<PlanClass> = new Set([
  "math",
  "conversion",
  "time",
  "date",
]);
