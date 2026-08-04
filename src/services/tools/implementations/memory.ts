/**
 * Memory tools — JARVIS's long-term memory facade over the memory engine.
 * Recall and storage are verified operations; the reasoning model never
 * pretends to remember something that is not in the store.
 */

import { memoryService } from "@/lib/memory";
import { MEMORY_CATEGORIES, type MemoryCategory } from "@/lib/memory/types";
import { numberArg, stringArg } from "../args";
import type { Tool } from "../types";

function categoryArg(args: Record<string, unknown>): MemoryCategory | undefined {
  const value = stringArg(args, "category");
  if (value && (MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    return value as MemoryCategory;
  }
  return undefined;
}

export const searchMemory: Tool = {
  definition: {
    name: "search_memory",
    description:
      "Search JARVIS's long-term memory for previously stored facts about the owner, projects, preferences or anything else.",
    category: "memory",
    runtime: "node",
    parameters: [
      { name: "query", type: "string", description: "Keywords to search for." },
      { name: "category", type: "string", description: "Optional category filter." },
      { name: "limit", type: "number", description: "Maximum results (default 5)." },
    ],
    cacheable: true,
    cacheTtlMs: 30_000,
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const query = stringArg(args, "query") ?? "";
    const entries = await memoryService.listEntries({
      status: "approved",
      search: query,
      category: categoryArg(args),
      limit: numberArg(args, "limit", 5, { min: 1, max: 20 }),
    });
    return {
      count: entries.length,
      query,
      entries: entries.map((entry) => ({
        id: entry.id,
        category: entry.category,
        content: entry.content,
        updatedAt: entry.updatedAt,
      })),
    };
  },
};

export const listMemories: Tool = {
  definition: {
    name: "list_memories",
    description: "List the most recently stored approved memories.",
    category: "memory",
    runtime: "node",
    parameters: [
      { name: "category", type: "string", description: "Optional category filter." },
      { name: "limit", type: "number", description: "Maximum results (default 10)." },
    ],
    cacheable: true,
    cacheTtlMs: 30_000,
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const entries = await memoryService.listEntries({
      status: "approved",
      category: categoryArg(args),
      limit: numberArg(args, "limit", 10, { min: 1, max: 50 }),
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
  },
};

export const remember: Tool = {
  definition: {
    name: "remember",
    description:
      "Store a new fact about the owner into JARVIS's long-term memory. Saved as pending until reviewed.",
    category: "memory",
    runtime: "node",
    parameters: [
      { name: "content", type: "string", description: "The fact to remember.", required: true },
      { name: "category", type: "string", description: "Optional category." },
    ],
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const content = stringArg(args, "content");
    if (!content) throw new Error("The 'content' argument is required.");
    const entry = await memoryService.createEntry(
      { content, category: categoryArg(args) },
      "ai"
    );
    return {
      id: entry.id,
      status: entry.status,
      message: `Memory stored for review (status: ${entry.status}).`,
    };
  },
};

export const memoryTools: Tool[] = [searchMemory, listMemories, remember];
