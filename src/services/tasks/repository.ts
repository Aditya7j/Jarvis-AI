/**
 * Task repository — JSON-file-backed persistence with a write-through in-memory
 * cache. Reads never touch disk after the first load; writes are atomic
 * (temp file + rename) so a crash mid-write cannot corrupt the store.
 */

import { promises as fs } from "fs";
import { dirname, resolve } from "path";
import { aiLogger } from "@/lib/ai/logger";
import type { JarvisTask, TaskRepository } from "./types";

const log = aiLogger.child("tasks.repository");

function isTask(value: unknown): value is JarvisTask {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.status === "string"
  );
}

export class JsonFileTaskRepository implements TaskRepository {
  private cache: JarvisTask[] | null = null;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly fileName = "tasks.json"
  ) {
    this.file = resolve(dataDir, fileName);
  }

  private async ensureFile(): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true });
    try {
      await fs.access(this.file);
    } catch {
      await fs.writeFile(this.file, "[]", "utf8");
    }
  }

  private async readAll(): Promise<JarvisTask[]> {
    await this.ensureFile();
    const raw = await fs.readFile(this.file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTask);
  }

  private async writeAll(tasks: JarvisTask[]): Promise<void> {
    await this.ensureFile();
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }

  async loadAll(): Promise<JarvisTask[]> {
    if (this.cache === null) {
      try {
        this.cache = await this.readAll();
      } catch (error) {
        log.warn("Failed to load task store; starting empty", {
          message: error instanceof Error ? error.message : String(error),
        });
        this.cache = [];
      }
    }
    return this.cache;
  }

  async save(task: JarvisTask): Promise<void> {
    const tasks = await this.loadAll();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index >= 0) tasks[index] = task;
    else tasks.push(task);
    this.cache = tasks;
    await this.writeAll(tasks);
  }

  async remove(id: string): Promise<void> {
    const tasks = await this.loadAll();
    const next = tasks.filter((t) => t.id !== id);
    this.cache = next;
    await this.writeAll(next);
  }
}
