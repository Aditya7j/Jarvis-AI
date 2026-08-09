/**
 * Task tools — automate work through the Task Engine. A task action is itself
 * a Tool Router invocation, so automation composes with the rest of the router.
 */

import { taskEngine } from "@/services/tasks";
import { getSystemClock, logTimeService } from "@/lib/time/time-service";
import { isAgentToolAllowed } from "../agent-policy";
import type { TaskRecurrence } from "@/services/tasks/types";
import { numberArg, stringArg } from "../args";
import type { Tool } from "../types";

function parseScheduledAt(args: Record<string, unknown>): number | null {
  const iso = stringArg(args, "scheduledAtIso");
  if (iso) {
    const parsed = new Date(iso).getTime();
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`Invalid 'scheduledAtIso' value: "${iso}".`);
  }
  const inMinutes = numberArg(args, "inMinutes", NaN);
  if (Number.isFinite(inMinutes) && inMinutes > 0) {
    const clock = getSystemClock();
    logTimeService("create_task", clock);
    return clock.unixMs + inMinutes * 60_000;
  }
  return null;
}

function parseRecurrence(args: Record<string, unknown>): TaskRecurrence | null {
  const kind = stringArg(args, "recurrenceKind");
  if (!kind) return null;
  switch (kind) {
    case "interval":
      return { kind, intervalMinutes: numberArg(args, "recurrenceIntervalMinutes", 60, { min: 1 }) };
    case "daily":
      return { kind, hour: numberArg(args, "recurrenceHour", 9, { min: 0, max: 23 }) };
    case "weekly":
      return {
        kind,
        hour: numberArg(args, "recurrenceHour", 9, { min: 0, max: 23 }),
        weekday: numberArg(args, "recurrenceWeekday", 0, { min: 0, max: 6 }),
      };
    case "monthly":
      return {
        kind,
        hour: numberArg(args, "recurrenceHour", 9, { min: 0, max: 23 }),
        dayOfMonth: numberArg(args, "recurrenceDay", 1, { min: 1, max: 31 }),
      };
    default:
      throw new Error(`Unknown recurrence kind "${kind}".`);
  }
}

export const createTask: Tool = {
  definition: {
    name: "create_task",
    description:
      "Create a task in JARVIS's task engine. Optionally schedule it (inMinutes or ISO timestamp) and give it a recurring rule.",
    category: "tasks",
    runtime: "node",
    parameters: [
      { name: "title", type: "string", description: "Task title.", required: true },
      { name: "description", type: "string", description: "Optional detail." },
      { name: "actionType", type: "string", description: "Optional tool name to run when the task executes. Only allow-listed read-only tools (web_search, get_weather, calculate, ...) may be used as task actions." },
      { name: "actionArgs", type: "object", description: "Arguments for the action tool." },
      { name: "inMinutes", type: "number", description: "Run this many minutes from now." },
      { name: "scheduledAtIso", type: "string", description: "ISO timestamp to run at." },
      { name: "recurrenceKind", type: "string", description: "interval | daily | weekly | monthly" },
    ],
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const title = stringArg(args, "title");
    if (!title) throw new Error("The 'title' argument is required.");
    const actionArgs = args.actionArgs;
    const actionType =
      typeof args.actionType === "string" ? args.actionType.trim() : "";
    if (actionType && !isAgentToolAllowed(actionType)) {
      throw new Error(
        `Tool "${actionType}" is not allowed as a task action — task actions are restricted to the agent allow-list.`
      );
    }
    const task = await taskEngine.createTask({
      title,
      description: stringArg(args, "description"),
      scheduledAt: parseScheduledAt(args),
      recurrence: parseRecurrence(args),
      action: actionType
        ? {
            type: actionType,
            args: actionArgs && typeof actionArgs === "object" ? (actionArgs as Record<string, unknown>) : {},
          }
        : null,
      maxAttempts: numberArg(args, "maxAttempts", 1, { min: 1, max: 5 }),
      source: "ai",
    });
    return { id: task.id, title: task.title, status: task.status, scheduledAt: task.scheduledAt, nextRunAt: task.nextRunAt };
  },
};

export const listTasks: Tool = {
  definition: {
    name: "list_tasks",
    description: "List tasks in the task engine with optional status filter.",
    category: "tasks",
    runtime: "node",
    parameters: [
      { name: "status", type: "string", description: "pending | scheduled | running | succeeded | failed | cancelled | all" },
      { name: "limit", type: "number", description: "Maximum results (default 20)." },
    ],
    cacheable: true,
    cacheTtlMs: 5_000,
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const status = stringArg(args, "status", "all") as "all" | "pending" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled";
    const valid = ["all", "pending", "scheduled", "running", "succeeded", "failed", "cancelled"];
    const filter = valid.includes(status) ? { status } : { status: "all" as const };
    const tasks = await taskEngine.listTasks({ ...filter, limit: numberArg(args, "limit", 20, { min: 1, max: 100 }) });
    return {
      count: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        scheduledAt: t.scheduledAt,
        nextRunAt: t.nextRunAt,
        lastError: t.lastError,
      })),
    };
  },
};

export const runTask: Tool = {
  definition: {
    name: "run_task",
    description: "Execute a task now, immediately, regardless of its schedule.",
    category: "tasks",
    runtime: "node",
    parameters: [
      { name: "id", type: "string", description: "Task id.", required: true },
    ],
    timeoutMs: 30_000,
  },
  run: async (args) => {
    const id = stringArg(args, "id");
    if (!id) throw new Error("The 'id' argument is required.");
    const report = await taskEngine.runTask(id);
    return { ...report };
  },
};

export const retryTask: Tool = {
  definition: {
    name: "retry_task",
    description: "Retry a previously failed task.",
    category: "tasks",
    runtime: "node",
    parameters: [
      { name: "id", type: "string", description: "Task id.", required: true },
    ],
    timeoutMs: 30_000,
  },
  run: async (args) => {
    const id = stringArg(args, "id");
    if (!id) throw new Error("The 'id' argument is required.");
    const report = await taskEngine.retryTask(id);
    if (!report) throw new Error(`Task "${id}" not found.`);
    return { ...report };
  },
};

export const cancelTask: Tool = {
  definition: {
    name: "cancel_task",
    description: "Cancel a scheduled or pending task.",
    category: "tasks",
    runtime: "node",
    parameters: [
      { name: "id", type: "string", description: "Task id.", required: true },
    ],
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const id = stringArg(args, "id");
    if (!id) throw new Error("The 'id' argument is required.");
    const task = await taskEngine.cancelTask(id);
    if (!task) throw new Error(`Task "${id}" not found.`);
    return { id: task.id, title: task.title, status: task.status };
  },
};

export const deleteTask: Tool = {
  definition: {
    name: "delete_task",
    description: "Permanently delete a task.",
    category: "tasks",
    runtime: "node",
    parameters: [
      { name: "id", type: "string", description: "Task id.", required: true },
    ],
    timeoutMs: 5_000,
  },
  run: async (args) => {
    const id = stringArg(args, "id");
    if (!id) throw new Error("The 'id' argument is required.");
    const removed = await taskEngine.deleteTask(id);
    if (!removed) throw new Error(`Task "${id}" not found.`);
    return { deleted: true, id };
  },
};

export const tasksTools: Tool[] = [
  createTask,
  listTasks,
  runTask,
  retryTask,
  cancelTask,
  deleteTask,
];
