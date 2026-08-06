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
  return { valid: true };
}

/** Calculator result: expression, value, formatted. */
export function validateMathResult(data: unknown): ToolValidation {
  if (!isRecord(data)) return invalid("calculate: expected an object");
  if (!isNonEmptyString(data.expression)) return invalid("calculate: missing expression");
  if (!isFiniteNumber(data.value)) return invalid("calculate: non-finite result");
  if (!isNonEmptyString(data.formatted)) return invalid("calculate: missing formatted result");
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

/** Web search result: query + at least one usable piece of content. */
export function validateWebSearch(data: unknown): ToolValidation {
  if (data === null) return invalid("web_search: returned no result");
  if (!isRecord(data)) return invalid("web_search: expected an object");
  if (!isNonEmptyString(data.query)) return invalid("web_search: missing query");
  const topics = Array.isArray(data.topics) ? data.topics : [];
  const hasContent =
    (data.heading !== null && data.heading !== undefined) ||
    (data.abstract !== null && data.abstract !== undefined) ||
    (data.answer !== null && data.answer !== undefined) ||
    topics.length > 0;
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
