/**
 * Fact Authority — the post-emission safety layer.
 *
 * The deterministic tools are the ONLY source of truth. When any text derived
 * from verified facts is about to reach the user — directly formatted, or
 * naturalized by the reasoning model — this layer re-checks that the text
 * actually CONTAINS the canonical values the tools computed. A violation means
 * the model (or a formatting bug) contradicted the verified data; the text is
 * then dropped and a deterministic fallback is emitted instead.
 *
 * Checks are deliberately strict: if a verified value does not appear in the
 * emitted answer, the answer is unsafe.
 */

import type { SpokenLanguage } from "@/lib/lang/detect";
import type { PlanClass } from "@/services/planner";
import type { VerifiedFact } from "@/services/planner/types";

export const HINDI_WEEKDAYS: Record<string, string> = {
  Sunday: "रविवार",
  Monday: "सोमवार",
  Tuesday: "मंगलवार",
  Wednesday: "बुधवार",
  Thursday: "गुरुवार",
  Friday: "शुक्रवार",
  Saturday: "शनिवार",
};

export interface FactViolation {
  expected: string;
  actual: string;
}

/** Extract every numeric token from free text ("23°C" → [23], "3:45" → [3, 45]). */
export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d[\d,]*\.?\d*/g) ?? [];
  const out: number[] = [];
  for (const match of matches) {
    const n = parseFloat(match.replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function normalizeNumber(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** True when the expected value appears in the text as a number. */
export function numberInText(text: string, expected: number): boolean {
  const target = normalizeNumber(expected);
  return extractNumbers(text).some((n) => normalizeNumber(n) === target);
}

function factOf(facts: VerifiedFact[], tool: string): unknown {
  return facts.find((f) => f.tool === tool)?.fact ?? null;
}

/**
 * Verify that `text` (the answer about to reach the user) contains the canonical
 * value of every verifiable fact gathered for this request. Returns the first
 * violation, or null when the answer is consistent with the verified data.
 */
export function assertFactInvariant(
  cls: PlanClass,
  facts: VerifiedFact[],
  text: string | null,
  language: SpokenLanguage
): FactViolation | null {
  if (!text) return null;
  const actual = text;

  if (cls === "date-calc") {
    const d = factOf(facts, "get_weekday_for_date") as
      | { kind?: string; weekday?: string }
      | null;
    if (d?.kind !== "weekday" || !d.weekday) return null;
    const refs =
      language === "hindi" ? [HINDI_WEEKDAYS[d.weekday], d.weekday] : [d.weekday];
    if (refs.some((ref) => ref && actual.includes(ref))) return null;
    return { expected: d.weekday, actual };
  }

  if (cls === "math") {
    const d = factOf(facts, "calculate") as
      | { value?: number; formatted?: string }
      | null;
    const expected = d?.value;
    if (typeof expected !== "number" || !Number.isFinite(expected)) return null;
    if (numberInText(actual, expected)) return null;
    if (d?.formatted && actual.includes(d.formatted)) return null;
    return { expected: String(expected), actual };
  }

  if (cls === "conversion") {
    const currency = factOf(facts, "convert_currency") as
      | { converted?: number; formatted?: string }
      | null;
    const unit = factOf(facts, "convert_units") as
      | { value?: number; formatted?: string }
      | null;
    const expected =
      typeof currency?.converted === "number" ? currency.converted : unit?.value;
    if (typeof expected !== "number" || !Number.isFinite(expected)) return null;
    if (numberInText(actual, expected)) return null;
    if (currency?.formatted && actual.includes(currency.formatted)) return null;
    if (unit?.formatted && actual.includes(unit.formatted)) return null;
    return { expected: String(expected), actual };
  }

  if (cls === "weather") {
    const d = factOf(facts, "get_weather") as { temperatureC?: number | null } | null;
    const expected = d?.temperatureC;
    if (typeof expected !== "number" || !Number.isFinite(expected)) return null;
    if (numberInText(actual, expected)) return null;
    return { expected: `${expected}°C`, actual };
  }

  if (cls === "time") {
    const d = factOf(facts, "get_current_time") as { unixMs?: number } | null;
    if (typeof d?.unixMs !== "number" || !Number.isFinite(d.unixMs)) return null;
    const at = new Date(d.unixMs);
    const hour24 = at.getHours();
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const minutes = String(at.getMinutes()).padStart(2, "0");
    const refs = [`${hour24}:${minutes}`, `${hour12}:${minutes}`];
    if (refs.some((ref) => actual.includes(ref))) return null;
    return { expected: refs[0], actual };
  }

  if (cls === "date") {
    const d = factOf(facts, "get_current_time") as { date?: string } | null;
    const dateText = d?.date;
    const match = dateText?.match(/(\d{1,2}), (\d{4})/);
    if (!match || !dateText) return null;
    const [, day, year] = match;
    if (actual.includes(year) && actual.includes(day)) return null;
    return { expected: dateText, actual };
  }

  if (cls === "system") {
    const d = factOf(facts, "get_system_status") as
      | {
          cpu?: { loadPercent?: number };
          memory?: { usedPercent?: number };
          disk?: { usedPercent?: number | null };
        }
      | null;
    const values: number[] = [];
    if (typeof d?.cpu?.loadPercent === "number") values.push(Math.round(d.cpu.loadPercent));
    if (typeof d?.memory?.usedPercent === "number") values.push(Math.round(d.memory.usedPercent));
    if (typeof d?.disk?.usedPercent === "number") values.push(Math.round(d.disk.usedPercent));
    if (values.length === 0) return null;
    const missing = values.filter((v) => !numberInText(actual, v));
    if (missing.length === 0) return null;
    return { expected: missing.join(", "), actual };
  }

  return null;
}
