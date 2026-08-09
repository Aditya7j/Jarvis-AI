/**
 * Task Engine — create, execute, monitor, retry, schedule and repeat tasks.
 *
 * Tasks run Tool Router actions, so automation uses the same verified-tool
 * pipeline as conversation. The engine is UI-agnostic and testable: the action
 * runner is injectable and defaults to the Tool Router executor.
 */

import { randomUUID } from "crypto";
import { aiLogger } from "@/lib/ai/logger";
import type { ToolResult } from "../tools/types";
import type {
  JarvisTask,
  TaskFilter,
  TaskInput,
  TaskRecurrence,
  TaskRepository,
  TaskRunReport,
  TaskStatus,
} from "./types";

const log = aiLogger.child("tasks.engine");

export type TaskActionRunner = (
  type: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<ToolResult>;

async function defaultRunner(
  type: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ToolResult> {
  const { isAgentToolAllowed } = await import("../tools/agent-policy");
  if (!isAgentToolAllowed(type)) {
    return {
      ok: false,
      error: {
        code: "ACTION_NOT_ALLOWED",
        message: `Task action tool "${type}" is not on the agent allow-list.`,
        retryable: false,
      },
      meta: { name: type, startedAt: Date.now(), durationMs: 0, attempts: 1, cacheHit: false, timedOut: false },
    };
  }
  const { executeTool } = await import("../tools/executor");
  return executeTool(type, args, { signal });
}

const RETRY_BACKOFF_MS = [500, 1_500, 3_000];

export interface TaskEngineOptions {
  repository: TaskRepository;
  runner?: TaskActionRunner;
}

export function computeNextRun(
  recurrence: TaskRecurrence,
  fromMs: number
): number | null {
  const from = new Date(fromMs);
  switch (recurrence.kind) {
    case "interval": {
      const minutes = Math.max(1, recurrence.intervalMinutes ?? 60);
      return fromMs + minutes * 60_000;
    }
    case "daily": {
      const hour = recurrence.hour ?? 9;
      const next = new Date(from);
      next.setHours(hour, 0, 0, 0);
      if (next.getTime() <= fromMs) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    case "weekly": {
      const hour = recurrence.hour ?? 9;
      const weekday = recurrence.weekday ?? 0;
      const next = new Date(from);
      next.setHours(hour, 0, 0, 0);
      while (next.getDay() !== weekday) next.setDate(next.getDate() + 1);
      if (next.getTime() <= fromMs) {
        next.setDate(next.getDate() + 1);
        while (next.getDay() !== weekday) next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }
    case "monthly": {
      const hour = recurrence.hour ?? 9;
      const day = Math.min(28, Math.max(1, recurrence.dayOfMonth ?? 1));
      const next = new Date(from);
      next.setHours(hour, 0, 0, 0);
      next.setDate(day);
      if (next.getTime() <= fromMs) {
        next.setMonth(next.getMonth() + 1, day);
      }
      return next.getTime();
    }
    default:
      return null;
  }
}

function statusForScheduling(scheduledAt: number | null): TaskStatus {
  if (scheduledAt === null || scheduledAt <= Date.now()) return "pending";
  return "scheduled";
}

export class TaskEngine {
  constructor(private readonly options: TaskEngineOptions) {}

  private get repository(): TaskRepository {
    return this.options.repository;
  }

  private get runner(): TaskActionRunner {
    return this.options.runner ?? defaultRunner;
  }

  async createTask(input: TaskInput): Promise<JarvisTask> {
    const now = Date.now();
    const task: JarvisTask = {
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description?.trim() || null,
      status: statusForScheduling(input.scheduledAt ?? null),
      createdAt: now,
      scheduledAt: input.scheduledAt ?? null,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? 1),
      lastError: null,
      lastResult: null,
      recurrence: input.recurrence ?? null,
      nextRunAt: input.recurrence
        ? computeNextRun(input.recurrence, input.scheduledAt ?? now)
        : null,
      action: input.action ?? null,
      source: input.source ?? "user",
    };
    await this.repository.save(task);
    log.info(`Task created "${task.title}"`, {
      id: task.id,
      status: task.status,
      scheduledAt: task.scheduledAt,
    });
    return task;
  }

  async listTasks(filter: TaskFilter = {}): Promise<JarvisTask[]> {
    const tasks = await this.repository.loadAll();
    let result = tasks;
    if (filter.status && filter.status !== "all") {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter.search?.trim()) {
      const needle = filter.search.trim().toLowerCase();
      result = result.filter(
        (t) =>
          t.title.toLowerCase().includes(needle) ||
          (t.description?.toLowerCase().includes(needle) ?? false)
      );
    }
    result = [...result].sort(
      (a, b) => (b.scheduledAt ?? b.createdAt) - (a.scheduledAt ?? a.createdAt)
    );
    if (filter.limit && filter.limit > 0) result = result.slice(0, filter.limit);
    return result;
  }

  async getTask(id: string): Promise<JarvisTask | null> {
    const tasks = await this.repository.loadAll();
    return tasks.find((t) => t.id === id) ?? null;
  }

  async cancelTask(id: string): Promise<JarvisTask | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    if (task.status === "succeeded" || task.status === "cancelled") return task;
    task.status = "cancelled";
    task.finishedAt = Date.now();
    await this.repository.save(task);
    log.info(`Task cancelled "${task.title}"`, { id: task.id });
    return task;
  }

  async deleteTask(id: string): Promise<boolean> {
    const task = await this.getTask(id);
    if (!task) return false;
    await this.repository.remove(id);
    log.info(`Task deleted "${task.title}"`, { id: task.id });
    return true;
  }

  async retryTask(id: string): Promise<TaskRunReport | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    if (task.status !== "failed") {
      throw new Error(`Task "${task.title}" is ${task.status}, not failed — only failed tasks can be retried.`);
    }
    task.status = "pending";
    task.scheduledAt = Date.now();
    task.lastError = null;
    await this.repository.save(task);
    return this.runTask(id);
  }

  private async applyResult(task: JarvisTask, report: TaskRunReport): Promise<void> {
    task.status = report.status;
    task.finishedAt = report.finishedAt ?? Date.now();
    task.attempts = report.attempts;
    task.lastError = report.error;
    task.lastResult = report.result;
    if (report.success && task.recurrence) {
      const base = task.scheduledAt ?? task.createdAt;
      task.nextRunAt = computeNextRun(task.recurrence, base);
      if (task.nextRunAt) {
        task.status = "scheduled";
        task.scheduledAt = task.nextRunAt;
      }
    }
    await this.repository.save(task);
  }

  /** Execute a task's action now, with retries and a per-attempt timeout. */
  async runTask(id: string, signal?: AbortSignal): Promise<TaskRunReport> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task "${id}" not found.`);
    if (task.status === "running") {
      return { taskId: id, status: "running", attempts: task.attempts, success: false, result: null, error: "Task is already running." };
    }

    task.status = "running";
    task.startedAt = Date.now();
    task.attempts = 0;
    await this.repository.save(task);
    log.info(`Task running "${task.title}"`, { id: task.id });

    if (!task.action) {
      const report: TaskRunReport = {
        taskId: id,
        status: "succeeded",
        attempts: 1,
        success: true,
        result: null,
        error: null,
      };
      await this.applyResult(task, { ...report, finishedAt: Date.now() });
      return report;
    }

    for (let attempt = 1; attempt <= task.maxAttempts; attempt++) {
      const result = await this.runner(task.action.type, task.action.args, signal);
      task.attempts = attempt;
      if (result.ok) {
        const report: TaskRunReport = {
          taskId: id,
          status: "succeeded",
          attempts: attempt,
          success: true,
          result: result.data,
          error: null,
        };
        await this.applyResult(task, { ...report, finishedAt: Date.now() });
        log.info(`Task succeeded "${task.title}"`, { id: task.id, attempts: attempt });
        return report;
      }
      task.lastError = result.error.message;
      if (attempt < task.maxAttempts) {
        const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        log.warn(`Task attempt ${attempt} failed; retrying in ${delay}ms`, {
          id: task.id,
          error: result.error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    const report: TaskRunReport = {
      taskId: id,
      status: "failed",
      attempts: task.attempts,
      success: false,
      result: null,
      error: task.lastError,
    };
    await this.applyResult(task, { ...report, finishedAt: Date.now() });
    log.warn(`Task failed "${task.title}"`, {
      id: task.id,
      attempts: task.attempts,
      error: task.lastError,
    });
    return report;
  }

  /**
   * Find tasks that are due to run now and start them (fire-and-track).
   * Returns the ids of tasks that were launched. Never throws.
   */
  async tick(now = Date.now()): Promise<string[]> {
    const tasks = await this.repository.loadAll();
    const due = tasks.filter(
      (t) =>
        (t.status === "pending" || t.status === "scheduled") &&
        t.scheduledAt !== null &&
        t.scheduledAt <= now
    );
    const launched: string[] = [];
    for (const task of due) {
      launched.push(task.id);
      void this.runTask(task.id).catch((error) => {
        log.warn(`Scheduled task run threw`, {
          id: task.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    if (launched.length > 0) {
      log.info(`Scheduler launched ${launched.length} task(s)`, { now });
    }
    return launched;
  }
}

export function createTaskStatusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    pending: "Pending",
    scheduled: "Scheduled",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  return labels[status];
}
