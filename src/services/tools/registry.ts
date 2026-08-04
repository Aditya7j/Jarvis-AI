/**
 * Tool registry — the single place tools are registered and discovered.
 * Tools are keyed by their unique snake_case name; a duplicate registration is
 * rejected loudly so a typo can never silently shadow a production tool.
 */

import type { Tool } from "./types";

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (!TOOL_NAME_PATTERN.test(tool.definition.name)) {
      throw new Error(
        `Invalid tool name "${tool.definition.name}" — must match ${TOOL_NAME_PATTERN}.`
      );
    }
    if (this.tools.has(tool.definition.name)) {
      throw new Error(
        `Tool "${tool.definition.name}" is already registered. Refusing to shadow it.`
      );
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  listDefinitions(): Tool["definition"][] {
    return this.list().map((tool) => tool.definition);
  }

  size(): number {
    return this.tools.size;
  }
}

export const toolRegistry = new ToolRegistry();

export function registerTool(tool: Tool): void {
  toolRegistry.register(tool);
}

export function getTool(name: string): Tool | null {
  return toolRegistry.get(name);
}

export function hasTool(name: string): boolean {
  return toolRegistry.has(name);
}

export function listToolDefinitions(): Tool["definition"][] {
  return toolRegistry.listDefinitions();
}
