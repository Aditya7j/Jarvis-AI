/**
 * Small TTL cache for tool results. Repeated identical calls (same tool +
 * same argument signature) never hit the network twice within the TTL.
 */

interface CacheEntry {
  value: unknown;
  at: number;
}

export class ToolCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries = 512
  ) {}

  key(tool: string, args: unknown): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(args ?? {});
    } catch {
      serialized = "<unserializable>";
    }
    return `${tool}:${serialized}`;
  }

  get(key: string, now = Date.now()): { value: unknown; at: number } | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (now - entry.at > this.defaultTtlMs) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  set(key: string, value: unknown, now = Date.now()): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, at: now });
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
