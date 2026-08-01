import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import type { MemoryEntry, MemoryPrivacy, OwnerProfile } from "./types";
import type { MemoryRepository } from "./repository";

export function defaultOwnerProfile(): OwnerProfile {
  return {
    id: "owner",
    name: "",
    nickname: "",
    email: "",
    occupation: "",
    skills: [],
    interests: [],
    goals: [],
    dailyRoutine: "",
    preferences: [],
    location: "",
    timezone: "",
    birthday: "",
    emergencyContacts: [],
    socialLinks: [],
    customNotes: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function defaultMemoryPrivacy(): MemoryPrivacy {
  return {
    enabled: true,
    contextInjection: true,
    autoLearn: true,
  };
}

interface JsonFileStoreOptions<T> {
  filePath: string;
  defaults: () => T;
}

class JsonFileStore<T> {
  private data: T;
  private lastMtime = 0;

  constructor(private readonly options: JsonFileStoreOptions<T>) {
    mkdirSync(path.dirname(options.filePath), { recursive: true });
    this.data = options.defaults();
    if (existsSync(options.filePath)) {
      this.read();
    } else {
      this.write();
    }
  }

  private read(): void {
    try {
      const raw = readFileSync(this.options.filePath, "utf8");
      const parsed = JSON.parse(raw) as T;
      this.data = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
          ? { ...this.options.defaults(), ...parsed }
          : this.options.defaults();
      this.lastMtime = statSync(this.options.filePath).mtimeMs;
    } catch (error) {
      console.error(
        `[memory] Failed to read ${this.options.filePath}:`,
        error
      );
      this.data = this.options.defaults();
    }
  }

  private write(): void {
    const filePath = this.options.filePath;
    const tmpPath = `${filePath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmpPath, filePath);
      this.lastMtime = statSync(filePath).mtimeMs;
    } catch (error) {
      console.error(`[memory] Failed to persist ${filePath}:`, error);
    }
  }

  get(): T {
    try {
      if (existsSync(this.options.filePath)) {
        const currentMtime = statSync(this.options.filePath).mtimeMs;
        if (currentMtime !== this.lastMtime) {
          this.read();
        }
      }
    } catch {
      // Fall through and return the in-memory copy.
    }
    return this.data;
  }

  set(next: T | ((previous: T) => T)): T {
    this.data =
      typeof next === "function"
        ? (next as (previous: T) => T)(this.data)
        : next;
    this.write();
    return this.data;
  }
}

export class JsonFileMemoryRepository implements MemoryRepository {
  private readonly profileStore: JsonFileStore<OwnerProfile>;
  private readonly entriesStore: JsonFileStore<MemoryEntry[]>;
  private readonly privacyStore: JsonFileStore<MemoryPrivacy>;

  constructor(dataDir: string) {
    this.profileStore = new JsonFileStore<OwnerProfile>({
      filePath: path.join(dataDir, "profile.json"),
      defaults: defaultOwnerProfile,
    });
    this.entriesStore = new JsonFileStore<MemoryEntry[]>({
      filePath: path.join(dataDir, "entries.json"),
      defaults: () => [],
    });
    this.privacyStore = new JsonFileStore<MemoryPrivacy>({
      filePath: path.join(dataDir, "privacy.json"),
      defaults: defaultMemoryPrivacy,
    });
  }

  async getProfile(): Promise<OwnerProfile> {
    return this.profileStore.get();
  }

  async saveProfile(profile: OwnerProfile): Promise<void> {
    this.profileStore.set(profile);
  }

  async listEntries(): Promise<MemoryEntry[]> {
    return this.entriesStore.get();
  }

  async addEntry(entry: MemoryEntry): Promise<void> {
    this.entriesStore.set((previous) => [...previous, entry]);
  }

  async updateEntry(entry: MemoryEntry): Promise<void> {
    this.entriesStore.set((previous) =>
      previous.map((existing) =>
        existing.id === entry.id ? entry : existing
      )
    );
  }

  async deleteEntry(id: string): Promise<void> {
    this.entriesStore.set((previous) =>
      previous.filter((entry) => entry.id !== id)
    );
  }

  async clearEntries(): Promise<void> {
    this.entriesStore.set(() => []);
  }

  async getPrivacy(): Promise<MemoryPrivacy> {
    return this.privacyStore.get();
  }

  async savePrivacy(privacy: MemoryPrivacy): Promise<void> {
    this.privacyStore.set(privacy);
  }
}
