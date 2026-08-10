/**
 * Unit conversion toolkit. Deterministic conversions for length, mass,
 * temperature, speed, data and time. Used by the unit-conversion tool so
 * JARVIS answers conversion questions with verified math, never guesses.
 */

export type UnitCategory = "length" | "mass" | "temperature" | "speed" | "data" | "time";

interface UnitDef {
  name: string;
  aliases: string[];
  /** Factor to the category's base unit (SI for most). */
  toBase: (value: number) => number;
  fromBase: (value: number) => number;
}

function linear(factor: number): UnitDef["toBase"] {
  return (v: number) => v * factor;
}

const UNITS: Record<UnitCategory, UnitDef[]> = {
  length: [
    { name: "meter", aliases: ["m", "meter", "meters", "metre", "metres"], toBase: linear(1), fromBase: linear(1) },
    { name: "kilometer", aliases: ["km", "kilometer", "kilometers", "kilometre", "kilometres"], toBase: linear(1000), fromBase: linear(1 / 1000) },
    { name: "centimeter", aliases: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"], toBase: linear(0.01), fromBase: linear(100) },
    { name: "millimeter", aliases: ["mm", "millimeter", "millimeters"], toBase: linear(0.001), fromBase: linear(1000) },
    { name: "mile", aliases: ["mi", "mile", "miles"], toBase: linear(1609.344), fromBase: linear(1 / 1609.344) },
    { name: "yard", aliases: ["yd", "yard", "yards"], toBase: linear(0.9144), fromBase: linear(1 / 0.9144) },
    { name: "foot", aliases: ["ft", "foot", "feet"], toBase: linear(0.3048), fromBase: linear(1 / 0.3048) },
    { name: "inch", aliases: ["in", "inch", "inches"], toBase: linear(0.0254), fromBase: linear(1 / 0.0254) },
  ],
  mass: [
    { name: "kilogram", aliases: ["kg", "kilogram", "kilograms", "kilo", "kilos"], toBase: linear(1), fromBase: linear(1) },
    { name: "gram", aliases: ["g", "gram", "grams"], toBase: linear(0.001), fromBase: linear(1000) },
    { name: "milligram", aliases: ["mg", "milligram", "milligrams"], toBase: linear(1e-6), fromBase: linear(1e6) },
    { name: "tonne", aliases: ["tonne", "tonnes", "metric ton", "metric tons", "t"], toBase: linear(1000), fromBase: linear(0.001) },
    { name: "pound", aliases: ["lb", "lbs", "pound", "pounds"], toBase: linear(0.45359237), fromBase: linear(1 / 0.45359237) },
    { name: "ounce", aliases: ["oz", "ounce", "ounces"], toBase: linear(0.028349523125), fromBase: linear(1 / 0.028349523125) },
    { name: "stone", aliases: ["st", "stone", "stones"], toBase: linear(6.35029318), fromBase: linear(1 / 6.35029318) },
  ],
  temperature: [
    { name: "celsius", aliases: ["c", "celsius", "degree celsius", "degrees celsius", "centigrade"], toBase: (v) => v, fromBase: (v) => v },
    { name: "fahrenheit", aliases: ["f", "fahrenheit", "degree fahrenheit", "degrees fahrenheit"], toBase: (v) => ((v - 32) * 5) / 9, fromBase: (v) => (v * 9) / 5 + 32 },
    { name: "kelvin", aliases: ["k", "kelvin"], toBase: (v) => v - 273.15, fromBase: (v) => v + 273.15 },
  ],
  speed: [
    { name: "kilometers per hour", aliases: ["km/h", "kmh", "kph", "kilometer per hour", "kilometers per hour", "kilometres per hour"], toBase: linear(1), fromBase: linear(1) },
    { name: "miles per hour", aliases: ["mph", "mile per hour", "miles per hour"], toBase: linear(1.609344), fromBase: linear(1 / 1.609344) },
    { name: "meters per second", aliases: ["m/s", "mps", "meter per second", "meters per second", "metres per second"], toBase: linear(3.6), fromBase: linear(1 / 3.6) },
    { name: "knots", aliases: ["kt", "knot", "knots"], toBase: linear(1.852), fromBase: linear(1 / 1.852) },
  ],
  data: [
    { name: "byte", aliases: ["b", "byte", "bytes"], toBase: linear(1), fromBase: linear(1) },
    { name: "kilobyte", aliases: ["kb", "kilobyte", "kilobytes"], toBase: linear(1000), fromBase: linear(0.001) },
    { name: "megabyte", aliases: ["mb", "megabyte", "megabytes"], toBase: linear(1e6), fromBase: linear(1e-6) },
    { name: "gigabyte", aliases: ["gb", "gigabyte", "gigabytes"], toBase: linear(1e9), fromBase: linear(1e-9) },
    { name: "terabyte", aliases: ["tb", "terabyte", "terabytes"], toBase: linear(1e12), fromBase: linear(1e-12) },
    { name: "kibibyte", aliases: ["kib", "kibibyte", "kibibytes"], toBase: linear(1024), fromBase: linear(1 / 1024) },
    { name: "mebibyte", aliases: ["mib", "mebibyte", "mebibytes"], toBase: linear(1024 ** 2), fromBase: linear(1 / 1024 ** 2) },
    { name: "gibibyte", aliases: ["gib", "gibibyte", "gibibytes"], toBase: linear(1024 ** 3), fromBase: linear(1 / 1024 ** 3) },
  ],
  time: [
    { name: "second", aliases: ["s", "sec", "second", "seconds"], toBase: linear(1), fromBase: linear(1) },
    { name: "minute", aliases: ["min", "minute", "minutes"], toBase: linear(60), fromBase: linear(1 / 60) },
    { name: "hour", aliases: ["h", "hr", "hour", "hours"], toBase: linear(3600), fromBase: linear(1 / 3600) },
    { name: "day", aliases: ["d", "day", "days"], toBase: linear(86400), fromBase: linear(1 / 86400) },
    { name: "week", aliases: ["wk", "week", "weeks"], toBase: linear(604800), fromBase: linear(1 / 604800) },
  ],
};

export const CONVERT_CATEGORIES: UnitCategory[] = ["length", "mass", "temperature", "speed", "data", "time"];

interface ParsedUnit {
  category: UnitCategory;
  def: UnitDef;
}

const UNIT_LOOKUP: Map<string, ParsedUnit> = new Map();
for (const category of CONVERT_CATEGORIES) {
  for (const def of UNITS[category]) {
    for (const alias of def.aliases) {
      UNIT_LOOKUP.set(alias, { category, def });
    }
  }
}

export function findUnit(token: string): ParsedUnit | null {
  const clean = token.toLowerCase().replace(/^degree\s+/, "").trim();
  if (clean.length === 0) return null;
  // An exact alias match is unambiguous and always wins (e.g. "g" is gram,
  // not a prefix of "gb"; "feet" is foot, not a prefix of "fahrenheit").
  const exact = UNIT_LOOKUP.get(clean);
  if (exact) return exact;
  // Fall back to prefix/suffix candidates, longest alias wins so "in" doesn't
  // shadow "inch" incorrectly.
  const candidates: ParsedUnit[] = [];
  for (const [alias, parsed] of UNIT_LOOKUP) {
    if (clean.startsWith(alias) || alias.startsWith(clean)) {
      candidates.push(parsed);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.def.aliases.reduce((m, x) => Math.max(m, x.length), 0) - a.def.aliases.reduce((m, x) => Math.max(m, x.length), 0));
  return candidates[0];
}

export interface ConvertResult {
  value: number;
  fromUnit: string;
  toUnit: string;
  category: UnitCategory;
  formatted: string;
}

function round(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

/** Convert a value between two units. Throws if units are unknown/incompatible. */
export function convertUnit(value: number, fromUnit: string, toUnit: string): ConvertResult {
  const from = findUnit(fromUnit);
  const to = findUnit(toUnit);
  if (!from || !to) {
    const unknown = !from ? fromUnit : toUnit;
    throw new Error(`Unknown unit "${unknown}".`);
  }
  if (from.category !== to.category) {
    throw new Error(`Cannot convert ${from.def.name} (${from.category}) to ${to.def.name} (${to.category}).`);
  }
  const inBase = from.def.toBase(value);
  const result = to.def.fromBase(inBase);
  const formatted = `${round(result)} ${to.def.name}${round(result) === 1 ? "" : "s"}`;
  return { value: round(result), fromUnit: from.def.name, toUnit: to.def.name, category: from.category, formatted };
}

const NUMBER_PATTERN = /\d[\d.,]*/;

const REVERSED_CUE_PATTERN = /^(?:how\s+many|how\s+much)\b/i;

/** Trim trailing punctuation/filler so "miles please." becomes "miles". */
function cleanUnit(unit: string): string {
  return unit
    .trim()
    .replace(/[.,!?]+$/, "")
    .replace(/\s+(?:please|for\s+me)$/i, "")
    .trim();
}

/**
 * Extract a conversion request from free text like
 * "convert 5 km to miles" / "5 kilograms in pounds" / "how many feet in 10 meters"
 * / "what is 32 degrees celsius in fahrenheit".
 * Returns null when the phrase is not a unit conversion.
 *
 * Units are split on the LAST separator word (to/into/in) so a source unit
 * named "in" (inch) is never mistaken for the separator in "convert 5 in to cm".
 * Units may span multiple words ("degrees celsius", "kilometers per hour").
 */
export function parseConversionRequest(input: string): { value: number; from: string; to: string } | null {
  const text = input.toLowerCase().trim();
  if (!text) return null;

  const separators = [...text.matchAll(/\b(?:to|into|in)\b/g)];
  if (separators.length === 0) return null;
  const sep = separators[separators.length - 1];
  const left = text.slice(0, sep.index).trim();
  const right = text.slice(sep.index + sep[0].length).trim();

  const leftNumber = left.match(NUMBER_PATTERN);
  const rightNumber = right.match(NUMBER_PATTERN);

  let valueText: string;
  let from: string;
  let to: string;
  if (leftNumber) {
    // "convert 5 km to miles" / "5 kilograms in pounds" / "what is 32 degrees celsius in fahrenheit"
    valueText = leftNumber[0];
    from = left.slice(leftNumber.index! + valueText.length).trim();
    to = right;
  } else if (rightNumber && REVERSED_CUE_PATTERN.test(left)) {
    // "how many feet in 10 meters" — target unit first, value+source after "in".
    to = left.replace(REVERSED_CUE_PATTERN, "").replace(/^\s*are\b/i, "").trim();
    valueText = rightNumber[0];
    from = right.slice(rightNumber.index! + valueText.length).trim();
  } else {
    return null;
  }

  const value = Number(valueText.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  if (!from || !to) return null;
  return { value, from: cleanUnit(from), to: cleanUnit(to) };
}

export function listSupportedUnits(): string[] {
  const names = new Set<string>();
  for (const category of CONVERT_CATEGORIES) {
    for (const def of UNITS[category]) names.add(`${def.name} (${category})`);
  }
  return [...names].sort();
}
