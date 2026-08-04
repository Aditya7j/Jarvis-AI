/**
 * Typed argument extraction shared by tool implementations. All reads are
 * defensive: wrong types degrade to the fallback instead of throwing, so a
 * misbehaving caller can never take a tool down.
 */

export function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback?: string
): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

export function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {}
): number {
  const { min, max } = opts;
  let value = args[key];
  if (typeof value === "string" && value.trim()) value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (min !== undefined && value < min) return fallback;
  if (max !== undefined && value > max) return fallback;
  return value;
}

export function booleanArg(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean
): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  return fallback;
}
