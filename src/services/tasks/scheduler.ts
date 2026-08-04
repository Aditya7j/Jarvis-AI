/**
 * Task Scheduler — background automation loop. Polls the Task Engine for due
 * tasks on an interval so nothing blocks the request path. Stop is idempotent;
 * the loop never throws and always recovers after a failed tick.
 */

import { aiLogger } from "@/lib/ai/logger";
import type { TaskEngine } from "./engine";

const log = aiLogger.child("tasks.scheduler");

export interface TaskEvent {
  type: "task-due" | "task-launched";
  taskId: string;
  at: number;
}

export interface SchedulerOptions {
  /** How often to scan for due tasks. Defaults to 5s. */
  pollIntervalMs?: number;
  /** Emitted for every task the scheduler picks up. */
  onEvent?: (event: TaskEvent) => void;
}

export class TaskScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly pollIntervalMs: number;
  private readonly onEvent: SchedulerOptions["onEvent"];

  constructor(
    private readonly engine: TaskEngine,
    options: SchedulerOptions = {}
  ) {
    this.pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? 5_000);
    this.onEvent = options.onEvent;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    log.info("Task Scheduler started", { pollIntervalMs: this.pollIntervalMs });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Task Scheduler stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  async tick(): Promise<void> {
    try {
      const launched = await this.engine.tick();
      for (const taskId of launched) {
        this.onEvent?.({ type: "task-launched", taskId, at: Date.now() });
      }
    } catch (error) {
      log.warn("Scheduler tick failed; will retry next interval", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
