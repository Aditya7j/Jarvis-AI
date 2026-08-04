import { aiLogger } from "../ai/logger";
import { buildOwnerContext } from "./context";
import type { MemoryRepository } from "./repository";
import {
  isMemoryCategory,
  newId,
  sanitizeEntryContent,
  sanitizeEntryPatch,
  sanitizeLearnedFacts,
  sanitizePrivacyPatch,
  sanitizeProfilePatch,
} from "./sanitize";
import type {
  LearnedFact,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryPatch,
  MemoryFilter,
  MemoryPrivacy,
  MemorySnapshot,
  MemorySource,
  OwnerProfile,
  ProfileInput,
} from "./types";

export interface MemoryServiceOptions {
  repository: MemoryRepository;
}

const CONTEXT_CACHE_TTL_MS = 10_000;

export class MemoryService {
  private readonly repository: MemoryRepository;
  private readonly log = aiLogger.child("memory");
  private contextCache: { context: string | null; at: number } | null = null;

  constructor(options: MemoryServiceOptions) {
    this.repository = options.repository;
  }

  /** Drop the cached owner context so the next buildContext re-reads disk. */
  invalidateContextCache(): void {
    this.contextCache = null;
  }

  async getProfile(): Promise<OwnerProfile> {
    return this.repository.getProfile();
  }

  async updateProfile(input: ProfileInput): Promise<OwnerProfile> {
    const current = await this.repository.getProfile();
    const patch = sanitizeProfilePatch(input as Record<string, unknown>);
    const updated: OwnerProfile = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    await this.repository.saveProfile(updated);
    this.invalidateContextCache();
    this.log.info("Owner profile updated");
    return updated;
  }

  async listEntries(filter: MemoryFilter = {}): Promise<MemoryEntry[]> {
    let entries = await this.repository.listEntries();

    if (filter.status && filter.status !== "all") {
      entries = entries.filter((entry) => entry.status === filter.status);
    }
    if (filter.category && filter.category !== "all") {
      entries = entries.filter((entry) => entry.category === filter.category);
    }
    if (filter.search && filter.search.trim()) {
      const query = filter.search.trim().toLowerCase();
      entries = entries.filter(
        (entry) =>
          entry.content.toLowerCase().includes(query) ||
          entry.note.toLowerCase().includes(query)
      );
    }

    entries = entries.sort((a, b) => b.updatedAt - a.updatedAt);
    if (filter.limit && filter.limit > 0) {
      entries = entries.slice(0, filter.limit);
    }
    return entries;
  }

  async createEntry(
    input: MemoryEntryInput,
    source: MemorySource = "manual"
  ): Promise<MemoryEntry> {
    const { content, category, note } = sanitizeEntryContent(input);
    const now = Date.now();
    const entry: MemoryEntry = {
      id: newId(),
      content,
      category,
      status: source === "manual" ? "approved" : "pending",
      source,
      confidence:
        typeof input.confidence === "number" && Number.isFinite(input.confidence)
          ? Math.min(1, Math.max(0, input.confidence))
          : null,
      note,
      createdAt: now,
      updatedAt: now,
      reviewedAt: null,
    };
    await this.repository.addEntry(entry);
    this.invalidateContextCache();
    this.log.info("Memory entry created", {
      id: entry.id,
      source: entry.source,
      status: entry.status,
      category: entry.category,
    });
    return entry;
  }

  async updateEntry(
    id: string,
    patch: MemoryEntryPatch
  ): Promise<MemoryEntry | null> {
    const entries = await this.repository.listEntries();
    const existing = entries.find((entry) => entry.id === id);
    if (!existing) return null;

    const cleaned = sanitizeEntryPatch(patch);
    const updated: MemoryEntry = {
      ...existing,
      ...cleaned,
      updatedAt: Date.now(),
    };
    await this.repository.updateEntry(updated);
    this.invalidateContextCache();
    this.log.info("Memory entry updated", { id });
    return updated;
  }

  async setEntryStatus(
    id: string,
    status: MemoryEntry["status"]
  ): Promise<MemoryEntry | null> {
    const entries = await this.repository.listEntries();
    const existing = entries.find((entry) => entry.id === id);
    if (!existing) return null;

    const updated: MemoryEntry = {
      ...existing,
      status,
      updatedAt: Date.now(),
      reviewedAt:
        status === "pending" ? existing.reviewedAt : Date.now(),
    };
    await this.repository.updateEntry(updated);
    this.invalidateContextCache();
    this.log.info("Memory entry reviewed", { id, status });
    return updated;
  }

  async deleteEntry(id: string): Promise<boolean> {
    const entries = await this.repository.listEntries();
    const exists = entries.some((entry) => entry.id === id);
    if (!exists) return false;
    await this.repository.deleteEntry(id);
    this.invalidateContextCache();
    this.log.info("Memory entry deleted", { id });
    return true;
  }

  async clearAll(): Promise<void> {
    await this.repository.clearEntries();
    this.invalidateContextCache();
    this.log.warn("All memories cleared");
  }

  async getPrivacy(): Promise<MemoryPrivacy> {
    return this.repository.getPrivacy();
  }

  async setPrivacy(
    patch: Partial<MemoryPrivacy>
  ): Promise<MemoryPrivacy> {
    const current = await this.repository.getPrivacy();
    const updated: MemoryPrivacy = {
      ...current,
      ...sanitizePrivacyPatch(patch as unknown as Record<string, unknown>),
    };
    await this.repository.savePrivacy(updated);
    this.invalidateContextCache();
    this.log.info("Memory privacy updated", { ...updated });
    return updated;
  }

  async learn(facts: LearnedFact[]): Promise<MemoryEntry[]> {
    const cleaned = sanitizeLearnedFacts(facts);
    if (cleaned.length === 0) return [];
    const created: MemoryEntry[] = [];
    for (const fact of cleaned) {
      created.push(
        await this.createEntry(
          {
            content: fact.content,
            category: isMemoryCategory(fact.category)
              ? fact.category
              : undefined,
            note: fact.note,
            confidence: fact.confidence ?? undefined,
          },
          "ai"
        )
      );
    }
    this.log.info("Learned facts proposed for approval", {
      count: created.length,
    });
    return created;
  }

  async buildContext(): Promise<string | null> {
    // buildContext() is called on every chat / vision request. Profile and
    // memory entries are read from disk each time, which is wasteful; cache the
    // assembled context for CONTEXT_CACHE_TTL_MS and invalidate on any write.
    if (
      this.contextCache &&
      Date.now() - this.contextCache.at < CONTEXT_CACHE_TTL_MS
    ) {
      return this.contextCache.context;
    }
    const privacy = await this.repository.getPrivacy();
    if (!privacy.enabled || !privacy.contextInjection) return null;
    const [profile, entries] = await Promise.all([
      this.repository.getProfile(),
      this.repository.listEntries(),
    ]);
    const context = buildOwnerContext(profile, entries);
    const result = context.length > 0 ? context : null;
    this.contextCache = { context: result, at: Date.now() };
    return result;
  }

  async getSnapshot(): Promise<MemorySnapshot> {
    const [profile, entries, privacy] = await Promise.all([
      this.repository.getProfile(),
      this.repository.listEntries(),
      this.repository.getPrivacy(),
    ]);
    return { profile, entries, privacy };
  }
}
