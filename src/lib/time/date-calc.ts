/**
 * Deterministic date calculations — the ONLY place JARVIS computes a weekday,
 * date difference or days-until/days-since for an arbitrary date. Pure
 * functions, no I/O, no LLM, no network.
 *
 * Timezone safety: weekdays are derived from the WALL-CLOCK date. A date like
 * 2026-08-15 is parsed into calendar components (year/month/day) and evaluated
 * with those exact local components (constructed at local noon, read via
 * local getDay()), never via a UTC instant. Because construction and read use
 * the same local timezone, a date-only input can never be shifted onto an
 * adjacent day by a timezone or DST boundary. Whole-day arithmetic uses
 * Date.UTC only for day counting (pure integer days, DST-proof).
 */

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export type DateQuery =
  | {
      kind: "weekday";
      date: CalendarDate;
      iso: string;
      weekday: string;
      display: string;
      localMs: number;
    }
  | {
      kind: "days-until";
      date: CalendarDate;
      iso: string;
      display: string;
      localMs: number;
      days: number;
    }
  | {
      kind: "days-since";
      date: CalendarDate;
      iso: string;
      display: string;
      localMs: number;
      days: number;
    }
  | {
      kind: "days-between";
      start: CalendarDate;
      startDisplay: string;
      end: CalendarDate;
      endDisplay: string;
      days: number;
    };

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  जनवरी: 1,
  फरवरी: 2,
  मार्च: 3,
  अप्रैल: 4,
  मई: 5,
  जून: 6,
  जुलाई: 7,
  अगस्त: 8,
  सितंबर: 9,
  अक्टूबर: 10,
  नवंबर: 11,
  दिसंबर: 12,
};

const MONTH_SRC =
  "(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december|जनवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर)";

/**
 * One combined token that matches the supported date spellings:
 *   - 15 Aug 2026 / 15th August 2026 (day, month, year)
 *   - August 15, 2026 / Aug 15th 2026 (month, day, year)
 *   - 2026-08-15 / 2026/08/15 (ISO, year first)
 *   - 15/08/2026 / 15-08-2026 / 15.08.2026 (day/month/year)
 */
const DATE_TOKEN_RE = new RegExp(
  `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_SRC}\\s*,?\\s*\\d{4}|${MONTH_SRC}\\s+\\d{1,2}(?:st|nd|rd|th)?\\s*,?\\s*\\d{4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{4})\\b`,
  "gi"
);

function isValidCalendarDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (y < 100 || y > 9999) return false; // avoid JS Date's 0-99 quirk
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const probe = new Date(y, m - 1, d);
  return (
    probe.getFullYear() === y &&
    probe.getMonth() === m - 1 &&
    probe.getDate() === d
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function isoDate(date: CalendarDate): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

const DISPLAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function displayDate(date: CalendarDate): string {
  return DISPLAY_FORMATTER.format(new Date(date.year, date.month - 1, date.day));
}

/**
 * Weekday of a calendar date. Constructed at local noon and read via local
 * getDay(), so the result is the wall-clock weekday in the machine's timezone
 * — a date-only input can never land on the wrong day.
 */
export function weekdayName(year: number, month: number, day: number): string {
  if (!isValidCalendarDate(year, month, day)) {
    throw new Error(`Invalid calendar date ${year}-${month}-${day}.`);
  }
  // Local noon: immune to DST midnights; the wall-clock date is what matters.
  const at = new Date(year, month - 1, day, 12, 0, 0, 0);
  return WEEKDAYS[at.getDay()];
}

/** Whole-day difference b - a in days (pure UTC day arithmetic, DST-proof). */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const msA = Date.UTC(a.year, a.month - 1, a.day);
  const msB = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((msB - msA) / 86_400_000);
}

function parseMonthName(name: string): number | null {
  const month = MONTH_NAMES[name.toLowerCase().replace(/[.,]/g, "")];
  return month ?? null;
}

function toCalendarDate(y: number, m: number, d: number): CalendarDate | null {
  if (!isValidCalendarDate(y, m, d)) return null;
  return { year: y, month: m, day: d };
}

/** Parse a single date token (already matched by DATE_TOKEN_RE). */
export function parseDateToken(token: string): CalendarDate | null {
  const wordyText = token.trim().replace(/[.,]/g, " ");
  const wordy = wordyText.match(
    new RegExp(
      `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_SRC})\\s+(\\d{4})$|^(${MONTH_SRC})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(\\d{4})$`,
      "i"
    )
  );
  if (wordy) {
    if (wordy[1] !== undefined && wordy[2] !== undefined && wordy[3] !== undefined) {
      const month = parseMonthName(wordy[2]);
      if (month === null) return null;
      return toCalendarDate(Number(wordy[3]), month, Number(wordy[1]));
    }
    if (wordy[4] !== undefined && wordy[5] !== undefined && wordy[6] !== undefined) {
      const month = parseMonthName(wordy[4]);
      if (month === null) return null;
      return toCalendarDate(Number(wordy[6]), month, Number(wordy[5]));
    }
    return null;
  }
  const parts = token.trim().split(/[-/.]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isInteger(n))) return null;
  let [y, m, d] = numbers;
  if (y >= 100 && y <= 9999) {
    // ISO (year first): 2026-08-15
    return toCalendarDate(y, m, d);
  }
  // day/month/year with disambiguation: whichever segment is > 12 is the day.
  let first = numbers[0];
  let second = numbers[1];
  const year = numbers[2];
  if (first > 12) {
    return toCalendarDate(year, second, first);
  }
  if (second > 12) {
    return toCalendarDate(year, first, second);
  }
  // Both <= 12 (e.g. 15/08/2026 is already handled above; ambiguous cases
  // default to day-first, matching the common "15/08/2026" reading).
  return toCalendarDate(year, second, first);
}

/** Extract every date token present in free text (0..2 expected). */
export function extractDateTokens(text: string): CalendarDate[] {
  if (!text) return [];
  const seen = new Set<string>();
  const results: CalendarDate[] = [];
  for (const match of text.matchAll(DATE_TOKEN_RE)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    const parsed = parseDateToken(token);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Parse free text into a deterministic date query. Returns null when no date
 * can be found. `now` is injectable for tests.
 */
export function analyzeDateQuery(
  text: string,
  now: Date = new Date()
): DateQuery | null {
  const dates = extractDateTokens(text);
  if (dates.length === 0) return null;
  const lower = text.toLowerCase();
  const first = dates[0];

  if (/\b(?:until|till)\b/.test(lower)) {
    const today: CalendarDate = {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    };
    return {
      kind: "days-until",
      date: first,
      iso: isoDate(first),
      display: displayDate(first),
      localMs: new Date(first.year, first.month - 1, first.day).getTime(),
      days: daysBetween(today, first),
    };
  }
  if (/\b(?:since|ago)\b/.test(lower)) {
    const today: CalendarDate = {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
    };
    return {
      kind: "days-since",
      date: first,
      iso: isoDate(first),
      display: displayDate(first),
      localMs: new Date(first.year, first.month - 1, first.day).getTime(),
      days: Math.abs(daysBetween(first, today)),
    };
  }
  if (/\bbetween\b/.test(lower) && dates.length >= 2) {
    return {
      kind: "days-between",
      start: dates[0],
      startDisplay: displayDate(dates[0]),
      end: dates[1],
      endDisplay: displayDate(dates[1]),
      days: Math.abs(daysBetween(dates[0], dates[1])),
    };
  }

  const weekday = weekdayName(first.year, first.month, first.day);
  return {
    kind: "weekday",
    date: first,
    iso: isoDate(first),
    weekday,
    display: displayDate(first),
    localMs: new Date(first.year, first.month - 1, first.day).getTime(),
  };
}
