/**
 * Tool output validators.
 *
 * Every factual tool declares a validator. The executor runs it after a
 * successful run; an output that fails structural validation is reported as
 * `VERIFICATION_FAILED` instead of being treated as a verified fact. This is
 * the guarantee that JARVIS never naturalizes malformed or hallucinated tool
 * data.
 */

import type { ToolValidation } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function invalid(reason: string): ToolValidation {
  return { valid: false, reason };
}

/**
 * Extract the numeric value embedded in a formatted result ("343,476" /
 * "3.10686 miles" / "92 EUR") and check it matches the computed value within
 * `tolerance`. Catches a tool returning a value that its own formatted string
 * contradicts. The tolerance absorbs display rounding (e.g. toLocaleString
 * with maximumFractionDigits truncates/rounds beyond the stored value).
 */
function formattedMatches(formatted: unknown, value: number, tolerance = 1e-4): boolean {
  if (typeof formatted !== "string") return false;
  const match = formatted.match(/-?\d[\d,]*\.?\d*/);
  if (!match) return false;
  const parsed = parseFloat(match[0].replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(parsed - value) <= tolerance;
}

/** System clock fact: iso, time, date, timezone, unixMs. */
export function validateClockFact(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("get_current_time: expected an object");
  if (!isNonEmptyString(data.iso)) return invalid("get_current_time: missing 'iso' timestamp");
  if (!isNonEmptyString(data.time)) return invalid("get_current_time: missing 'time'");
  if (!isNonEmptyString(data.date)) return invalid("get_current_time: missing 'date'");
  if (!isNonEmptyString(data.timezone)) return invalid("get_current_time: missing 'timezone'");
  if (!isFiniteNumber(data.unixMs)) return invalid("get_current_time: invalid 'unixMs'");
  return { valid: true };
}

const WEEKDAYS = new Set([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Weekday of a Gregorian date via Zeller's congruence. This is an INDEPENDENT
 * implementation from the date tool's own calendar math: the validator
 * recomputes truth from the raw Y/M/D and rejects any weekday the tool could
 * not have computed — a wrong weekday can never be reported as verified.
 */
function zellerWeekday(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 100 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year ||
    probe.getMonth() !== month - 1 ||
    probe.getDate() !== day
  ) {
    return null; // not a real calendar date (e.g. 2026-02-31)
  }
  let y = year;
  let m = month;
  if (m < 3) {
    m += 12;
    y -= 1;
  }
  const k = y % 100;
  const j = Math.floor(y / 100);
  const h =
    (day + Math.floor((13 * (m + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) - 2 * j) %
    7;
  const index = ((h % 7) + 7) % 7; // 0 = Saturday … 6 = Friday
  return ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][index];
}

function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Cross-check an ISO date + weekday against the independent Zeller computation. */
function weekdayMatches(dateIso: string, weekday: string): boolean {
  const parts = parseIsoDate(dateIso);
  if (!parts) return false;
  return zellerWeekday(parts.year, parts.month, parts.day) === weekday;
}

/**
 * Deterministic date fact: the weekday (and/or day count) of a specific date,
 * computed by the date tool — never by the LLM.
 */
export function validateDateFact(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("get_weekday_for_date: expected an object");
  const kind = data.kind;
  if (
    kind !== "weekday" &&
    kind !== "days-until" &&
    kind !== "days-since" &&
    kind !== "days-between"
  ) {
    return invalid("get_weekday_for_date: unknown query kind");
  }
  if (kind === "days-between") {
    if (typeof data.start !== "string" || !ISO_DATE_RE.test(data.start)) {
      return invalid("get_weekday_for_date: invalid start date");
    }
    if (typeof data.end !== "string" || !ISO_DATE_RE.test(data.end)) {
      return invalid("get_weekday_for_date: invalid end date");
    }
    if (
      !isNonEmptyString(data.startDisplay) ||
      !isNonEmptyString(data.endDisplay)
    ) {
      return invalid("get_weekday_for_date: missing display dates");
    }
    if (!isFiniteNumber(data.days)) return invalid("get_weekday_for_date: missing days");
    if (!isFiniteNumber(data.startLocalMs) || !isFiniteNumber(data.endLocalMs)) {
      return invalid("get_weekday_for_date: invalid local timestamps");
    }
    return { valid: true };
  }
  if (typeof data.date !== "string" || !ISO_DATE_RE.test(data.date)) {
    return invalid("get_weekday_for_date: invalid date");
  }
  if (typeof data.weekday !== "string" || !WEEKDAYS.has(data.weekday)) {
    return invalid("get_weekday_for_date: invalid weekday");
  }
  // Independent recompute: the weekday MUST match Zeller's congruence on the
  // raw year/month/day. A date the tool could not have derived the weekday for
  // (e.g. 2026-13-99) or a weekday that contradicts the date is unverifiable.
  if (!weekdayMatches(data.date, data.weekday)) {
    return invalid("get_weekday_for_date: weekday contradicts the date");
  }
  if (!isNonEmptyString(data.display)) return invalid("get_weekday_for_date: missing display");
  if (!isFiniteNumber(data.localMs)) return invalid("get_weekday_for_date: invalid timestamp");
  if (
    (kind === "days-until" || kind === "days-since") &&
    !isFiniteNumber(data.days)
  ) {
    return invalid("get_weekday_for_date: missing days");
  }
  return { valid: true };
}

/** Weather fact: condition, location, observedAt, source (+ optional metrics). */
export function validateWeatherFact(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("get_weather: expected an object");
  if (!isNonEmptyString(data.condition)) return invalid("get_weather: missing condition");
  if (
    !isRecord(data.location) ||
    !isFiniteNumber(data.location.latitude) ||
    !isFiniteNumber(data.location.longitude)
  ) {
    return invalid("get_weather: invalid location");
  }
  if (!isNonEmptyString(data.observedAt)) return invalid("get_weather: missing observedAt");
  if (!isNonEmptyString(data.source)) return invalid("get_weather: missing source");
  if (Number.isNaN(new Date(data.observedAt).getTime())) {
    return invalid("get_weather: observedAt is not a valid timestamp");
  }
  // Physical range checks — a reading outside these bounds is garbage, never a
  // real verified value. When a field is present it must be plausible.
  const bounds: Array<[string, number, number, unknown]> = [
    ["temperatureC", -90, 60, data.temperatureC],
    ["feelsLikeC", -90, 60, data.feelsLikeC],
    ["humidity", 0, 100, data.humidity],
    ["windSpeedKmh", 0, 400, data.windSpeedKmh],
  ];
  for (const [name, min, max, value] of bounds) {
    if (value === null || value === undefined) continue;
    if (!isFiniteNumber(value) || value < min || value > max) {
      return invalid(`get_weather: ${name} outside plausible range [${min}, ${max}]`);
    }
  }
  return { valid: true };
}

/** Calculator result: expression, value, formatted. */
export function validateMathResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("calculate: expected an object");
  if (!isNonEmptyString(data.expression)) return invalid("calculate: missing expression");
  if (!isFiniteNumber(data.value)) return invalid("calculate: non-finite result");
  if (!isNonEmptyString(data.formatted)) return invalid("calculate: missing formatted result");
  if (!formattedMatches(data.formatted, data.value)) {
    return invalid("calculate: formatted result contradicts the computed value");
  }
  return { valid: true };
}

/** Unit conversion result: value, fromUnit, toUnit, category, formatted. */
export function validateConvertResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("convert_units: expected an object");
  if (!isFiniteNumber(data.value)) return invalid("convert_units: non-finite value");
  if (!isNonEmptyString(data.fromUnit) || !isNonEmptyString(data.toUnit)) {
    return invalid("convert_units: missing unit names");
  }
  if (!isNonEmptyString(data.category)) return invalid("convert_units: missing category");
  if (!isNonEmptyString(data.formatted)) return invalid("convert_units: missing formatted result");
  if (!formattedMatches(data.formatted, data.value)) {
    return invalid("convert_units: formatted result contradicts the computed value");
  }
  return { valid: true };
}

/** Currency conversion result: amount, from, to, rate, converted, formatted. */
export function validateCurrencyResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("convert_currency: expected an object");
  if (!isFiniteNumber(data.amount) || !isFiniteNumber(data.converted)) {
    return invalid("convert_currency: non-finite amounts");
  }
  if (!isFiniteNumber(data.rate)) return invalid("convert_currency: invalid rate");
  if (!isNonEmptyString(data.from) || !isNonEmptyString(data.to)) {
    return invalid("convert_currency: missing currency codes");
  }
  if (!isNonEmptyString(data.formatted)) return invalid("convert_currency: missing formatted result");
  // Independent recompute: converted MUST equal round(rate × amount), where
  // round() is the toolkit's 6-decimal rounding. Tolerance absorbs float noise.
  const recomputed = Math.round(data.rate * data.amount * 1_000_000) / 1_000_000;
  if (Math.abs(recomputed - data.converted) > 1e-6) {
    return invalid("convert_currency: converted amount contradicts the rate");
  }
  if (!formattedMatches(data.formatted, data.converted, 0.01)) {
    return invalid("convert_currency: formatted result contradicts the converted amount");
  }
  return { valid: true };
}

/** Memory search/list result: count + entries array. */
export function validateMemorySearch(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("memory: expected an object");
  if (typeof data.count !== "number" || data.count < 0) {
    return invalid("memory: invalid count");
  }
  if (!Array.isArray(data.entries)) return invalid("memory: missing entries array");
  return { valid: true };
}

/** Web search result: query + at least one usable piece of non-empty content. */
export function validateWebSearch(data: unknown): ToolValidation {
  if (data === null) return invalid("web_search: returned no result");
  if (!isRecord(data)) return invalid("web_search: expected an object");
  if (!isNonEmptyString(data.query)) return invalid("web_search: missing query");
  const topics = Array.isArray(data.topics) ? data.topics : [];
  const hasContent =
    isNonEmptyString(data.heading) ||
    isNonEmptyString(data.abstract) ||
    isNonEmptyString(data.answer) ||
    topics.some((t) => isRecord(t) && isNonEmptyString(t.text));
  if (!hasContent) return invalid("web_search: empty result");
  return { valid: true };
}

/** News result: { stories: [...] }. */
export function validateNewsResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("get_news: expected an object");
  if (!Array.isArray(data.stories)) return invalid("get_news: missing stories array");
  return { valid: true };
}

/** Vision structured analysis: objects/person/text + uncertainty. */
export function validateVisionAnalysis(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("vision: expected an object");
  if (!Array.isArray(data.visible_objects)) {
    return invalid("vision: missing visible_objects array");
  }
  if (!isRecord(data.person)) return invalid("vision: missing person details");
  if (typeof data.text !== "string") return invalid("vision: missing text field");
  if (typeof data.uncertain !== "boolean") return invalid("vision: missing uncertain flag");
  if (typeof data.reasoning !== "string") return invalid("vision: missing reasoning");
  return { valid: true };
}

/** Calendar result: count + items array for the requested day. */
export function validateCalendarResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("get_calendar: expected an object");
  if (typeof data.count !== "number" || data.count < 0) {
    return invalid("get_calendar: invalid count");
  }
  if (!isNonEmptyString(data.date)) return invalid("get_calendar: missing date");
  if (!Array.isArray(data.items)) return invalid("get_calendar: missing items array");
  return { valid: true };
}

/** Owner profile result: a verified record about the owner. */
export function validateProfileResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("get_owner_profile: expected an object");
  if (!isNonEmptyString(data.id)) return invalid("get_owner_profile: missing id");
  if (!isNonEmptyString(data.name)) return invalid("get_owner_profile: missing name");
  return { valid: true };
}
