import type { MemoryEntry, MemoryPrivacy, OwnerProfile } from "./types";

export interface MemoryRepository {
  getProfile(): Promise<OwnerProfile>;
  saveProfile(profile: OwnerProfile): Promise<void>;
  listEntries(): Promise<MemoryEntry[]>;
  addEntry(entry: MemoryEntry): Promise<void>;
  updateEntry(entry: MemoryEntry): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  clearEntries(): Promise<void>;
  getPrivacy(): Promise<MemoryPrivacy>;
  savePrivacy(privacy: MemoryPrivacy): Promise<void>;
}
