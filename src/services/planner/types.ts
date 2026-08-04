/**
 * Intent Planner types — the shape of a plan produced BEFORE any model call.
 *
 * The planner decides three things deterministically:
 *   1. WHICH verified tools must provide the facts (or none — LLM).
 *   2. HOW the answer must be produced:
 *        - direct      → tool output is formatted directly, no LLM (<500ms)
 *        - naturalize  → tool output is the ONLY truth; the reasoning model
 *                        presents it in natural language
 *        - llm         → general conversation, no factual tools involved
 *   3. WHICH client-gated facts (location/battery/clock) are required.
 */

import type { PlanIntent } from "./intents";

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
  intent: PlanIntent;
  /** Tool Router tool names to execute, in order. */
  tools: string[];
  /** Human-readable label for routing telemetry. */
  label: string;
  /** Subject(s) the facts describe, for naturalization blocks. */
  subject: string;
}

export type PlanRoute =
  | { kind: "direct"; step: PlanStep; reason: string }
  | { kind: "naturalize"; step: PlanStep; reason: string }
  | { kind: "llm"; step: PlanStep; reason: string };

export interface PlanInput {
  /** Browser-provided verified facts (client-gated tools). */
  clientTools?: {
    systemClock?: unknown;
    geolocation?: { granted: boolean; latitude?: number; longitude?: number; accuracyM?: number };
    battery?: { granted: boolean; level?: number; levelPercent?: number; charging?: boolean };
  };
  awareness?: unknown;
}

/** Intents whose verified tool output can be formatted directly, no LLM. */
export const DIRECT_TOOL_INTENTS: ReadonlySet<PlanIntent> = new Set([
  "calculator",
  "unit-conversion",
  "currency",
]);
