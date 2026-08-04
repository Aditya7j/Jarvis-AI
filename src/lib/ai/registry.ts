import type { ProviderName } from "./types";

const STORE_KEY = "__jarvis_runtime_keys__";

type RuntimeKeyStore = Map<ProviderName, string>;

/**
 * Next.js App Router compiles each route handler into its own bundle, so
 * module-scoped singletons are NOT shared between routes. Runtime API keys
 * configured via Settings must be visible to every route that builds the AI
 * provider set, so the map lives on `globalThis` (shared per process).
 */
function getStore(): RuntimeKeyStore {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[STORE_KEY] as RuntimeKeyStore | undefined;
  if (existing instanceof Map) return existing;
  const store: RuntimeKeyStore = new Map<ProviderName, string>();
  Object.defineProperty(g, STORE_KEY, {
    value: store,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

export function getRuntimeKey(name: ProviderName): string | undefined {
  return getStore().get(name);
}

export function setRuntimeKey(name: ProviderName, apiKey: string): void {
  getStore().set(name, apiKey);
}

export function clearRuntimeKey(name: ProviderName): void {
  getStore().delete(name);
}
