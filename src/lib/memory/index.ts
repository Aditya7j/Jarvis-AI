import { resolve } from "path";
import { JsonFileMemoryRepository } from "./json-file-repository";
import { MemoryService } from "./memory-service";

export function memoryDataDir(): string {
  const configured = process.env.MEMORY_DATA_DIR?.trim();
  if (configured) return resolve(configured);
  return resolve(process.cwd(), "data", "memory");
}

export function createMemoryService(): MemoryService {
  const repository = new JsonFileMemoryRepository(memoryDataDir());
  return new MemoryService({ repository });
}

export const memoryService = createMemoryService();

export { MemoryService } from "./memory-service";
export { JsonFileMemoryRepository } from "./json-file-repository";
export type { MemoryRepository } from "./repository";
export { buildOwnerContext, appendMemoryContext } from "./context";
export * from "./types";
