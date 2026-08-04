import { describe, it, expect } from "vitest";
import {
  computeNextRun,
  TaskEngine,
  createTaskStatusLabel,
} from "@/services/tasks/engine";
import type { JarvisTask, TaskRepository } from "@/services/tasks/types";
import type { ToolResult } from "@/services/tools/types";

class MemoryRepository implements TaskRepository {
  private store = new Map<string, JarvisTask>();
  async loadAll(): Promise<JarvisTask[]> {
    return [...this.store.values()];
  }
  async save(task: JarvisTask): Promise<void> {
    this.store.set(task.id, task);
  }
  async remove(id: string): Promise<void> {
    this.store.delete(id);
  }
}

function okResult(data: unknown): ToolResult {
  return { ok: true, data, meta: { name: "x", startedAt: 0, durationMs: 0, attempts: 1, cacheHit: false, timedOut: false } };
}

function failResult(message: string): ToolResult {
  return { ok: false, error: { code: "ERR", message, retryable: false }, meta: { name: "x", startedAt: 0, durationMs: 0, attempts: 1, cacheHit: false, timedOut: false } };
}

describe("Task Engine", () => {
  it("creates a task with default pending status", async () => {
    const engine = new TaskEngine({ repository: new MemoryRepository() });
    const task = await engine.createTask({ title: "Buy milk" });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
    expect(task.attempts).toBe(0);
    expect(task.scheduledAt).toBeNull();
  });

  it("runs a task action to success", async () => {
    const engine = new TaskEngine({
      repository: new MemoryRepository(),
      runner: async () => okResult({ value: 42 }),
    });
    const task = await engine.createTask({
      title: "Calculate",
      action: { type: "calculate", args: { expression: "6*7" } },
    });
    const report = await engine.runTask(task.id);
    expect(report.success).toBe(true);
    const stored = await engine.getTask(task.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.lastResult).toEqual({ value: 42 });
  });

  it("marks the task failed and keeps the error", async () => {
    const engine = new TaskEngine({
      repository: new MemoryRepository(),
      runner: async () => failResult("boom"),
    });
    const task = await engine.createTask({
      title: "Fail",
      action: { type: "x", args: {} },
    });
    const report = await engine.runTask(task.id);
    expect(report.success).toBe(false);
    expect(report.error).toBe("boom");
    const stored = await engine.getTask(task.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.lastError).toBe("boom");
  });

  it("retries within a single run up to maxAttempts", async () => {
    let calls = 0;
    const engine = new TaskEngine({
      repository: new MemoryRepository(),
      runner: async () => {
        calls += 1;
        return calls < 3 ? failResult("transient") : okResult("done");
      },
    });
    const task = await engine.createTask({
      title: "Retry",
      maxAttempts: 3,
      action: { type: "x", args: {} },
    });
    const report = await engine.runTask(task.id);
    expect(report.success).toBe(true);
    expect(report.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("retryTask only allows failed tasks", async () => {
    const engine = new TaskEngine({
      repository: new MemoryRepository(),
      runner: async () => okResult("ok"),
    });
    const task = await engine.createTask({ title: "Once" });
    await expect(engine.retryTask(task.id)).rejects.toThrow(/not failed/i);
  });

  it("retryTask re-runs a failed task", async () => {
    let calls = 0;
    const engine = new TaskEngine({
      repository: new MemoryRepository(),
      runner: async () => {
        calls += 1;
        return calls === 1 ? failResult("boom") : okResult("recovered");
      },
    });
    const task = await engine.createTask({
      title: "Flaky",
      action: { type: "x", args: {} },
    });
    const first = await engine.runTask(task.id);
    expect(first.success).toBe(false);
    const second = await engine.retryTask(task.id);
    expect(second?.success).toBe(true);
    expect(calls).toBe(2);
  });

  it("cancels pending and running tasks", async () => {
    const engine = new TaskEngine({ repository: new MemoryRepository() });
    const task = await engine.createTask({ title: "Cancel me" });
    const cancelled = await engine.cancelTask(task.id);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.finishedAt).toBeTruthy();
    expect(await engine.getTask(task.id)).toHaveProperty("status", "cancelled");
  });

  it("deletes tasks", async () => {
    const engine = new TaskEngine({ repository: new MemoryRepository() });
    const task = await engine.createTask({ title: "Delete me" });
    expect(await engine.deleteTask(task.id)).toBe(true);
    expect(await engine.deleteTask(task.id)).toBe(false);
    expect(await engine.getTask(task.id)).toBeNull();
  });

  it("filters and sorts listTasks", async () => {
    const engine = new TaskEngine({ repository: new MemoryRepository() });
    const a = await engine.createTask({ title: "Alpha", scheduledAt: 1000 });
    const b = await engine.createTask({ title: "Beta beta", scheduledAt: 500 });
    await engine.cancelTask(b.id);
    expect((await engine.listTasks({})).length).toBe(2);
    expect((await engine.listTasks({ status: "cancelled" })).length).toBe(1);
    expect((await engine.listTasks({ search: "alpha" }))[0].id).toBe(a.id);
    const sorted = await engine.listTasks({});
    expect(sorted[0].id).toBe(a.id);
  });

  it("tick launches only due pending/scheduled tasks", async () => {
    const engine = new TaskEngine({
      repository: new MemoryRepository(),
      runner: async () => okResult("done"),
    });
    const due = await engine.createTask({ title: "Due", scheduledAt: 0 });
    const future = await engine.createTask({ title: "Future", scheduledAt: Date.now() + 60_000 });
    const launched = await engine.tick();
    expect(launched).toContain(due.id);
    expect(launched).not.toContain(future.id);
  });
});

describe("computeNextRun", () => {
  it("computes interval recurrence", () => {
    const from = new Date("2026-08-04T10:00:00Z").getTime();
    const next = computeNextRun({ kind: "interval", intervalMinutes: 30 }, from);
    expect(next).toBe(from + 30 * 60_000);
  });

  it("computes next daily run at the given hour", () => {
    const from = new Date();
    from.setHours(8, 0, 0, 0);
    const next = new Date(computeNextRun({ kind: "daily", hour: 9 }, from.getTime()) as number);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getHours()).toBe(9);
  });

  it("computes next weekly run on the right weekday", () => {
    const from = new Date();
    from.setHours(10, 0, 0, 0);
    const next = new Date(computeNextRun({ kind: "weekly", weekday: 1, hour: 8 }, from.getTime()) as number); // Monday 08:00 local
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(8);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it("returns null for unsupported kinds", () => {
    expect(computeNextRun({ kind: "interval" } as never, 0)).not.toBeNull();
  });
});

describe("createTaskStatusLabel", () => {
  it("labels every status", () => {
    expect(createTaskStatusLabel("succeeded")).toBe("Succeeded");
    expect(createTaskStatusLabel("scheduled")).toBe("Scheduled");
    expect(createTaskStatusLabel("failed")).toBe("Failed");
  });
});
