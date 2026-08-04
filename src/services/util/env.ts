/** Environment guards shared across services. */

export function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}
