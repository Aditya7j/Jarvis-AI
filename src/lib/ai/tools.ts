import { memoryService } from "../memory";
import type { MemoryCategory } from "../memory/types";
import { aiLogger } from "./logger";
import type { ToolCall, ToolCallInvocation } from "./types";

const log = aiLogger.child("tools");

export type ToolExecutor = (args: Record<string, unknown>) => Promise<unknown>;

interface RegisteredTool {
  definition: ToolCall;
  execute: ToolExecutor;
}

const tools = new Map<string, RegisteredTool>();

export function registerTool(definition: ToolCall, execute: ToolExecutor): void {
  tools.set(definition.name, { definition, execute });
  log.info(`Registered tool "${definition.name}"`);
}

function stringArg(args: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(Math.min(value, 50));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(Math.min(parsed, 50));
  }
  return fallback;
}

function isMemoryCategory(value: string | undefined): value is MemoryCategory {
  if (!value) return false;
  return [
    "identity",
    "personal",
    "preference",
    "contact",
    "work",
    "routine",
    "project",
    "social",
    "custom",
  ].includes(value);
}

const TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

async function getCurrentTime(): Promise<unknown> {
  const now = new Date();
  return {
    iso: now.toISOString(),
    formatted: TIME_FORMATTER.format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function searchMemory(args: Record<string, unknown>): Promise<unknown> {
  const query = stringArg(args, "query");
  const entries = await memoryService.listEntries({
    status: "approved",
    search: query ?? "",
    category: isMemoryCategory(stringArg(args, "category")) ? (stringArg(args, "category") as MemoryCategory) : undefined,
    limit: numberArg(args, "limit", 5),
  });
  return {
    count: entries.length,
    query: query ?? "",
    entries: entries.map((entry) => ({
      id: entry.id,
      category: entry.category,
      content: entry.content,
      updatedAt: entry.updatedAt,
    })),
  };
}

async function listMemories(args: Record<string, unknown>): Promise<unknown> {
  const entries = await memoryService.listEntries({
    status: "approved",
    category: isMemoryCategory(stringArg(args, "category")) ? (stringArg(args, "category") as MemoryCategory) : undefined,
    limit: numberArg(args, "limit", 10),
  });
  return {
    count: entries.length,
    entries: entries.map((entry) => ({
      id: entry.id,
      category: entry.category,
      content: entry.content,
      updatedAt: entry.updatedAt,
    })),
  };
}

async function remember(args: Record<string, unknown>): Promise<unknown> {
  const content = stringArg(args, "content");
  if (!content) {
    return { error: "The 'content' argument is required." };
  }
  const category = isMemoryCategory(stringArg(args, "category"))
    ? (stringArg(args, "category") as MemoryCategory)
    : undefined;
  const entry = await memoryService.createEntry(
    { content, category },
    "ai"
  );
  return {
    id: entry.id,
    status: entry.status,
    message: `Memory stored for review (status: ${entry.status}).`,
  };
}

registerTool(
  {
    name: "get_current_time",
    description:
      "Get the current date, time and timezone of the machine JARVIS runs on.",
    parameters: { type: "object", properties: {} },
  },
  getCurrentTime
);

registerTool(
  {
    name: "search_memory",
    description:
      "Search JARVIS's long-term memory for previously stored facts about the owner, projects, preferences or anything else.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for in memory entries.",
        },
        category: {
          type: "string",
          description:
            "Filter by category: identity, personal, preference, contact, work, routine, project, social.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default 5).",
        },
      },
    },
  },
  searchMemory
);

registerTool(
  {
    name: "list_memories",
    description:
      "List the most recently stored approved memories without a keyword search.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Filter by category: identity, personal, preference, contact, work, routine, project, social.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default 10).",
        },
      },
    },
  },
  listMemories
);

registerTool(
  {
    name: "remember",
    description:
      "Store a new fact about the owner or the conversation into JARVIS's long-term memory. It will be saved as pending until reviewed.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The fact or preference to remember.",
        },
        category: {
          type: "string",
          description:
            "Optional category: identity, personal, preference, contact, work, routine, project, social.",
        },
      },
      required: ["content"],
    },
  },
  remember
);

export const JARVIS_TOOLS: ToolCall[] = [...tools.values()].map(
  (tool) => tool.definition
);

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    log.warn(`Unknown tool invoked: ${name}`);
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  const startedAt = Date.now();
  try {
    const result = await tool.execute(args ?? {});
    log.info(`Tool "${name}" executed`, {
      latencyMs: Date.now() - startedAt,
    });
    return JSON.stringify(result);
  } catch (error) {
    log.warn(`Tool "${name}" failed`, {
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function hasTool(name: string): boolean {
  return tools.has(name);
}

export { type ToolCallInvocation };
