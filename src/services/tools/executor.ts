/**
 * Tool executor — the production-grade execution layer of the Tool Router.
 *
 * Guarantees for every invocation:
 *   - Never throws: every failure is returned as a typed `ToolResult`.
 *   - Timeout enforcement: each attempt is bounded by the tool's timeout.
 *   - Retry with backoff for retryable failures (transient network, timeout).
 *   - Result caching for cacheable tools (identical calls within the TTL).
 *   - Runtime guards: node-only tools never pretend to run in the browser.
 *   - Graceful degradation: an unavailable tool is a first-class error result,
 *     never a crash and never an LLM guess.
 */

import { aiLogger } from "@/lib/ai/logger";
import { isBrowser } from "../util/env";
import { ToolCache } from "./cache";
import { getTool } from "./registry";
import {
  TOOL_ERROR_CODES,
  type Tool,
  type ToolContext,
  type ToolExecutionMeta,
  type ToolResult,
} from "./types";

export const DEFAULT_TOOL_TIMEOUT_MS = 8_000;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_BACKOFF_MS = 2_000;

const log = aiLogger.child("tools");

export interface ExecuteOptions {
  /** Caller-level cancellation (e.g. socket close). */
  signal?: AbortSignal;
  /** Skip the cache for this call. */
  disableCache?: boolean;
}

function retryDelayMs(attempt: number): number {
  return Math.min(100 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

function isRetryableError(code: string): boolean {
  return code === TOOL_ERROR_CODES.TIMEOUT || code === "ToolkitNetworkError";
}

/**
 * Run one attempt with a timeout. The tool receives a context whose signal is
 * wired to BOTH the attempt timeout and the caller's cancellation.
 */
async function runAttempt(
  tool: Tool,
  args: Record<string, unknown>,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<{ ok: true; data: unknown; timedOut: boolean } | { ok: false; error: { code: string; message: string; retryable: boolean }; timedOut: boolean }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const ctx: ToolContext = { signal: controller.signal, log };
    const data = await tool.run(args, ctx);
    return { ok: true, data, timedOut: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (outerSignal?.aborted) {
      return {
        ok: false,
        timedOut: false,
        error: { code: "CANCELLED", message: "Tool execution cancelled.", retryable: false },
      };
    }
    if (timedOut || controller.signal.aborted) {
      return {
        ok: false,
        timedOut: true,
        error: {
          code: TOOL_ERROR_CODES.TIMEOUT,
          message: `Tool "${tool.definition.name}" timed out after ${timeoutMs}ms.`,
          retryable: true,
        },
      };
    }
    const name = error?.constructor?.name ?? "Error";
    return {
      ok: false,
      timedOut: false,
      error: {
        code: name,
        message,
        retryable: isRetryableError(name) || isRetryableError(message),
      },
    };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

function meta(
  name: string,
  startedAt: number,
  attempts: number,
  cacheHit: boolean,
  timedOut: boolean
): ToolExecutionMeta {
  return {
    name,
    startedAt,
    durationMs: Date.now() - startedAt,
    attempts,
    cacheHit,
    timedOut,
  };
}

export const toolCache = new ToolCache(DEFAULT_CACHE_TTL_MS);

/**
 * Execute a registered tool by name. Never throws.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown> = {},
  options: ExecuteOptions = {}
): Promise<ToolResult> {
  const startedAt = Date.now();
  const tool = getTool(name);
  if (!tool) {
    return {
      ok: false,
      meta: meta(name, startedAt, 0, false, false),
      error: {
        code: TOOL_ERROR_CODES.UNKNOWN_TOOL,
        message: `Unknown tool "${name}".`,
        retryable: false,
      },
    };
  }
  if (tool.definition.runtime === "node" && isBrowser()) {
    return {
      ok: false,
      meta: meta(name, startedAt, 0, false, false),
      error: {
        code: TOOL_ERROR_CODES.UNSUPPORTED_RUNTIME,
        message: `Tool "${name}" is only available on the JARVIS server.`,
        retryable: false,
      },
    };
  }

  const cacheable = Boolean(tool.definition.cacheable);
  const cacheKey = cacheable ? toolCache.key(name, args) : null;
  if (!options.disableCache && cacheKey) {
    const hit = toolCache.get(cacheKey);
    if (hit) {
      return { ok: true, data: hit.value, meta: meta(name, startedAt, 0, true, false) };
    }
  }

  const timeoutMs = tool.definition.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxAttempts = 1 + (tool.definition.retries ?? 0);
  let lastError: Extract<ToolResult, { ok: false }> | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await runAttempt(tool, args, timeoutMs, options.signal);
    if (result.ok) {
      if (tool.definition.validate) {
        const check = tool.definition.validate(result.data);
        if (!check.valid) {
          log.warn(`Tool "${name}" produced an invalid result`, { reason: check.reason });
          return {
            ok: false,
            error: {
              code: TOOL_ERROR_CODES.VERIFICATION_FAILED,
              message: `Tool "${name}" returned an unverifiable result: ${check.reason}`,
              retryable: false,
            },
            meta: meta(name, startedAt, attempt, false, result.timedOut),
          };
        }
      }
      const out: ToolResult = {
        ok: true,
        data: result.data,
        meta: meta(name, startedAt, attempt, false, result.timedOut),
      };
      if (cacheKey) {
        toolCache.set(
          cacheKey,
          result.data,
          tool.definition.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
        );
      }
      return out;
    }
    lastError = {
      ok: false,
      error: result.error,
      meta: meta(name, startedAt, attempt, false, result.timedOut),
    };
    if (result.error.code === "CANCELLED") return lastError;
    if (attempt < maxAttempts && (result.error.retryable || result.timedOut)) {
      const delay = retryDelayMs(attempt);
      log.warn(`Tool "${name}" attempt ${attempt} failed; retrying in ${delay}ms`, {
        code: result.error.code,
        message: result.error.message,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    break;
  }

  const finalError: Extract<ToolResult, { ok: false }> = lastError ?? {
    ok: false,
    error: {
      code: TOOL_ERROR_CODES.TOOL_FAILED,
      message: `Tool "${name}" failed without a recorded error.`,
      retryable: false,
    },
    meta: meta(name, startedAt, maxAttempts, false, false),
  };
  log.warn(`Tool "${name}" failed`, {
    code: finalError.error.code,
    message: finalError.error.message,
    attempts: finalError.meta.attempts,
    durationMs: finalError.meta.durationMs,
  });
  return finalError;
}
