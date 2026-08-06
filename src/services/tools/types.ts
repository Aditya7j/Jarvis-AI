/**
 * Tool Router types — the shared vocabulary for JARVIS's production tool layer.
 *
 * A tool is the ONLY source of truth for factual information. The reasoning
 * model never measures, fetches, computes or recalls facts itself; it only
 * naturalizes verified tool output (or falls back to a graceful "not
 * available" reply). Every tool is registered, cached, timed out and retried
 * uniformly by the executor so individual tools stay small and testable.
 */

import type { Logger } from "@/lib/ai/logger";

export type ToolRuntime = "node" | "browser" | "any";

export type ToolCategory =
  | "system"
  | "time"
  | "weather"
  | "location"
  | "web"
  | "news"
  | "math"
  | "currency"
  | "unit-conversion"
  | "files"
  | "clipboard"
  | "memory"
  | "tasks"
  | "calendar"
  | "profile"
  | "vision"
  | "browser"
  | "communication";

export interface ToolParameter {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  description: string;
  required?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  runtime: ToolRuntime;
  parameters?: ToolParameter[];
  /** Results may be served from cache for identical calls within the TTL. */
  cacheable?: boolean;
  cacheTtlMs?: number;
  /** Per-attempt timeout. Defaults to the executor default. */
  timeoutMs?: number;
  /** Number of automatic retries after a retryable failure. Defaults to 0. */
  retries?: number;
  /**
   * Structural validation of the tool result. When present, a result that
   * fails validation is treated as a `VERIFICATION_FAILED` failure — it is
   * never cached and never fed to the LLM as a verified fact.
   */
  validate?: (data: unknown) => ToolValidation;
}

/**
 * Result of validating a tool's output. `{ valid: true }` means the output is
 * structurally sound enough to be treated as a verified fact.
 */
export type ToolValidation =
  | { valid: true }
  | { valid: false; reason: string };

export interface ToolContext {
  signal?: AbortSignal;
  log: Logger;
}

export interface Tool<Args = Record<string, unknown>, Out = unknown> {
  definition: ToolDefinition;
  run: (args: Args, ctx: ToolContext) => Promise<Out>;
}

export interface ToolFailure {
  code: string;
  message: string;
  /** true when a retry is likely to succeed (timeout, transient network). */
  retryable: boolean;
}

export interface ToolExecutionMeta {
  name: string;
  startedAt: number;
  durationMs: number;
  attempts: number;
  cacheHit: boolean;
  timedOut: boolean;
}

export type ToolResult =
  | { ok: true; data: unknown; meta: ToolExecutionMeta }
  | { ok: false; error: ToolFailure; meta: ToolExecutionMeta };

export const TOOL_ERROR_CODES = {
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  TIMEOUT: "TIMEOUT",
  INVALID_ARGS: "INVALID_ARGS",
  TOOL_FAILED: "TOOL_FAILED",
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  UNSUPPORTED_RUNTIME: "UNSUPPORTED_RUNTIME",
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[keyof typeof TOOL_ERROR_CODES];
