import type { ProviderName } from "./types";

const runtimeKeys = new Map<ProviderName, string>();

export function getRuntimeKey(name: ProviderName): string | undefined {
  return runtimeKeys.get(name);
}

export function setRuntimeKey(name: ProviderName, apiKey: string): void {
  runtimeKeys.set(name, apiKey);
}

export function clearRuntimeKey(name: ProviderName): void {
  runtimeKeys.delete(name);
}
