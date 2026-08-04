/**
 * Task Engine types — the vocabulary for JARVIS's background automation.
 *
 * A task is a unit of work that can be created by the user or by JARVIS, run
 * on demand or on a schedule, retried on failure, and repeated on a
 * recurrence rule. Tasks execute Tool Router actions so automation shares the
 * exact same verified-tool pipeline as conversation.
 */

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskRecurrenceKind = "interval" | "daily" | "weekly" | "monthly";

export interface TaskRecurrence {
  kind: TaskRecurrenceKind;
  /** interval: repeat every N minutes. */
  intervalMinutes?: number;
  /** daily: local hour 0-23. */
  hour?: number;
  /** weekly: 0 (Sunday) - 6 (Saturday). */
  weekday?: number;
  /** monthly: day of month 1-31. */
  dayOfMonth?: number;
}

/** A task's action is a Tool Router invocation (type = tool name). */
export interface TaskAction {
  type: string;
  args: Record<string, unknown>;
}

export interface JarvisTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  createdAt: number;
  scheduledAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lastResult: unknown | null;
  recurrence: TaskRecurrence | null;
  nextRunAt: number | null;
  action: TaskAction | null;
  source: "user" | "ai" | "system";
}

export interface TaskInput {
  title: string;
  description?: string;
  scheduledAt?: number | null;
  recurrence?: TaskRecurrence | null;
  action?: TaskAction | null;
  maxAttempts?: number;
  source?: "user" | "ai" | "system";
}

export interface TaskFilter {
  status?: TaskStatus | "all";
  search?: string;
  limit?: number;
}

export interface TaskRepository {
  loadAll(): Promise<JarvisTask[]>;
  save(task: JarvisTask): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface TaskRunReport {
  taskId: string;
  status: TaskStatus;
  attempts: number;
  success: boolean;
  result: unknown | null;
  error: string | null;
  finishedAt?: number;
}
