/**
 * TimeService — the SINGLE source of truth for every date/time/greeting/timezone
 * in JARVIS. Exactly one implementation exists: dashboard, chat, context engine,
 * tools, calendar and display formatters all import from here. No other module
 * formats dates, detects the timezone or computes greetings.
 *
 * Every consumer logs the exact value it receives via `logTimeService(caller, clock)`.
 */

import { aiLogger } from "@/lib/ai/logger";
import type { SpokenLanguage } from "@/lib/lang/detect";

export type DayPart = "morning" | "afternoon" | "evening" | "night";

export interface SystemClockFact {
  iso: string;
  unixMs: number;
  time: string;
  date: string;
  timezone: string;
  formatted: string;
  greeting: string;
  dayPart: DayPart;
}

const FULL_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/** Dashboard widget clock: "04:34 PM". */
const CLOCK_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
});

/** Dashboard widget date: "Thursday, August 6". */
const CLOCK_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

/** Timestamp display: "4:34:56 PM" (replaces bare toLocaleTimeString calls). */
const STAMP_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

const GREETING_TEXT: Record<DayPart, string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  night: "Good night",
};

export function getDayPart(hour: number): DayPart {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

export function getGreeting(date = new Date()): string {
  return GREETING_TEXT[getDayPart(date.getHours())];
}

/** The local timezone, detected exactly once per process/browser session. */
let cachedTimezone: string | null = null;
export function getTimezone(): string {
  if (cachedTimezone === null) {
    cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return cachedTimezone;
}

/** Verified current date/time/timezone/greeting in the local timezone. */
export function getSystemClock(now = new Date()): SystemClockFact {
  const dayPart = getDayPart(now.getHours());
  return {
    iso: now.toISOString(),
    unixMs: now.getTime(),
    time: TIME_FORMATTER.format(now),
    date: DATE_FORMATTER.format(now),
    timezone: getTimezone(),
    formatted: FULL_TIME_FORMATTER.format(now),
    greeting: GREETING_TEXT[dayPart],
    dayPart,
  };
}

/** Calendar "today": start-of-day unix ms in the local timezone. */
export function getDayStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** Calendar "today": end-of-day unix ms (inclusive) in the local timezone. */
export function getDayEnd(now = new Date()): number {
  return getDayStart(now) + 24 * 60 * 60 * 1_000 - 1;
}

/** Shared display helpers — formatting never happens outside this module. */
export function formatClockTime(date: Date): string {
  return CLOCK_TIME_FORMATTER.format(date);
}

export function formatClockDate(date: Date): string {
  return CLOCK_DATE_FORMATTER.format(date);
}

export function formatTimestampTime(ms: number): string {
  return STAMP_TIME_FORMATTER.format(new Date(ms));
}

const LOCALIZED_DATE_FORMATTERS: Partial<
  Record<SpokenLanguage, Intl.DateTimeFormat>
> = {};

const LOCALIZED_TIME_FORMATTERS: Partial<
  Record<SpokenLanguage, Intl.DateTimeFormat>
> = {};

function localizedDateFormatter(language: SpokenLanguage): Intl.DateTimeFormat {
  if (!LOCALIZED_DATE_FORMATTERS[language]) {
    const locale = language === "hindi" ? "hi-IN" : "en-IN";
    LOCALIZED_DATE_FORMATTERS[language] = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }
  return LOCALIZED_DATE_FORMATTERS[language]!;
}

function localizedTimeFormatter(language: SpokenLanguage): Intl.DateTimeFormat {
  if (!LOCALIZED_TIME_FORMATTERS[language]) {
    const locale = language === "hindi" ? "hi-IN" : "en-IN";
    LOCALIZED_TIME_FORMATTERS[language] = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }
  return LOCALIZED_TIME_FORMATTERS[language]!;
}

/**
 * Localized date for direct answers ("6 अगस्त 2026" / "6 August 2026").
 * English returns null — the pipeline keeps the canonical English date.
 */
export function formatDateIn(
  language: SpokenLanguage,
  ms: number
): string | null {
  if (language === "english") return null;
  return localizedDateFormatter(language).format(new Date(ms));
}

/**
 * Localized clock time for direct answers ("1:04 अपराह्न" / "1:04 pm").
 * English returns null — the pipeline keeps the canonical English time.
 */
export function formatTimeIn(
  language: SpokenLanguage,
  ms: number
): string | null {
  if (language === "english") return null;
  return localizedTimeFormatter(language).format(new Date(ms));
}

const timeLog = aiLogger.child("time");

/**
 * Runtime trace of every clock read. Each consumer calls this with its own
 * caller label right after obtaining the clock so the exact value it received
 * is recorded.
 */
export function logTimeService(caller: string, clock: SystemClockFact): void {
  timeLog.info("[TimeService]", {
    caller,
    unixMs: clock.unixMs,
    iso: clock.iso,
    time: clock.time,
    date: clock.date,
    timezone: clock.timezone,
    greeting: clock.greeting,
    dayPart: clock.dayPart,
  });
}
