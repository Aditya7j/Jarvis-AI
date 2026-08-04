/**
 * Task Engine facade — the automation service of JARVIS. Owns the repository,
 * engine and scheduler singletons used across the server.
 */

import { resolve } from "path";
import { aiLogger } from "@/lib/ai/logger";
import { TaskEngine } from "./engine";
import { JsonFileTaskRepository } from "./repository";
import { TaskScheduler } from "./scheduler";

const log = aiLogger.child("tasks");

export function taskDataDir(): string {
  const configured = process.env.TASKS_DATA_DIR?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "tasks");
}

export function createTaskEngine(): TaskEngine {
  const repository = new JsonFileTaskRepository(taskDataDir());
  return new TaskEngine({ repository });
}

export const taskEngine = createTaskEngine();
export const taskScheduler = new TaskScheduler(taskEngine);

export { computeNextRun, createTaskStatusLabel, TaskEngine } from "./engine";
export type { TaskActionRunner, TaskEngineOptions } from "./engine";
export { JsonFileTaskRepository } from "./repository";
export { TaskScheduler } from "./scheduler";
export type { SchedulerOptions, TaskEvent } from "./scheduler";
export type {
  JarvisTask,
  TaskAction,
  TaskFilter,
  TaskInput,
  TaskRecurrence,
  TaskRecurrenceKind,
  TaskRepository,
  TaskRunReport,
  TaskStatus,
} from "./types";

export function startTaskAutomation(): void {
  taskScheduler.start();
  log.info("Task automation enabled");
}

export function stopTaskAutomation(): void {
  taskScheduler.stop();
}
