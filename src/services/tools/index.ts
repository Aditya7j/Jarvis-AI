/**
 * Tool Router — the production tool layer of JARVIS.
 *
 * Everything factual flows through here. Tools are the ONLY source of truth;
 * the reasoning model naturalizes their output and never guesses. The router
 * provides a uniform registry, executor (timeout/retry/cache/error-recovery),
 * and typed results.
 *
 * Pipeline position: Intent Planner → Tool Router → Memory Engine → Reasoning.
 */

import { aiLogger } from "@/lib/ai/logger";
import { fileTools } from "./implementations/files";
import { mathTools } from "./implementations/math";
import { memoryTools } from "./implementations/memory";
import { systemControlTools } from "./implementations/system-control";
import { systemTools } from "./implementations/system";
import { tasksTools } from "./implementations/tasks";
import { timeTools } from "./implementations/time";
import { webTools } from "./implementations/web";
import { registerTool } from "./registry";

const log = aiLogger.child("tools");

let initialized = false;

function registerMany(tools: Parameters<typeof registerTool>[0][]): void {
  for (const tool of tools) registerTool(tool);
}

/**
 * Register the full production tool set. Idempotent: safe to call on every
 * server boot, hot reload, or test setup.
 */
export function initToolRouter(): void {
  if (initialized) return;
  initialized = true;
  registerMany([
    ...systemTools,
    ...systemControlTools,
    ...timeTools,
    ...mathTools,
    ...webTools,
    ...memoryTools,
    ...fileTools,
    ...tasksTools,
  ]);
  log.info(`Tool Router initialized with ${toolCount()} tools`);
}

export function toolCount(): number {
  return (
    systemTools.length +
    systemControlTools.length +
    timeTools.length +
    mathTools.length +
    webTools.length +
    memoryTools.length +
    fileTools.length +
    tasksTools.length
  );
}

export { executeTool, toolCache, DEFAULT_TOOL_TIMEOUT_MS } from "./executor";
export type { ExecuteOptions } from "./executor";
export {
  getTool,
  hasTool,
  listToolDefinitions,
  registerTool,
  toolRegistry,
} from "./registry";
export { ToolCache } from "./cache";
export {
  TOOL_ERROR_CODES,
  type Tool,
  type ToolCategory,
  type ToolContext,
  type ToolDefinition,
  type ToolFailure,
  type ToolResult,
  type ToolRuntime,
} from "./types";
