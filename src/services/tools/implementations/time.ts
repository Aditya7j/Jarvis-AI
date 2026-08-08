/**
 * Time tools — the verified system clock. The reasoning model never computes
 * the time itself; this tool is the only source of truth.
 */

import { analyzeDateQuery, isoDate, weekdayName } from "@/lib/time/date-calc";
import { getSystemClock, logTimeService } from "@/lib/time/time-service";
import { stringArg } from "../args";
import { validateClockFact, validateDateFact } from "../validators";
import type { Tool } from "../types";

export const getCurrentTime: Tool = {
  definition: {
    name: "get_current_time",
    description: "Get the current date, time and timezone of this machine.",
    category: "time",
    runtime: "any",
    cacheable: false,
    timeoutMs: 2_000,
    validate: validateClockFact,
  },
  run: async () => {
    const clock = getSystemClock();
    logTimeService("get_current_time", clock);
    return clock;
  },
};

/**
 * Deterministic date tool — the ONLY source of truth for the weekday of a
 * specific date ("What day is 15 Aug 2026?") and day counts. Pure calendar
 * arithmetic; the reasoning model never computes a weekday itself.
 */
export const getWeekdayForDate: Tool = {
  definition: {
    name: "get_weekday_for_date",
    description:
      "Deterministically compute the weekday, days-until or days-since of a specific date (e.g. '15 Aug 2026', 'August 15 2026', '15/08/2026').",
    category: "time",
    runtime: "any",
    cacheable: false,
    timeoutMs: 2_000,
    validate: validateDateFact,
    parameters: [
      {
        name: "text",
        type: "string",
        description: "The user's question containing a concrete date.",
        required: true,
      },
    ],
  },
  run: async (args) => {
    const text = stringArg(args, "text", "");
    const query = analyzeDateQuery(text ?? "");
    if (!query) {
      throw new Error("No date could be parsed from the request.");
    }
    if (query.kind === "days-between") {
      return {
        kind: query.kind,
        start: isoDate(query.start),
        startDisplay: query.startDisplay,
        end: isoDate(query.end),
        endDisplay: query.endDisplay,
        days: query.days,
        startLocalMs: new Date(
          query.start.year,
          query.start.month - 1,
          query.start.day
        ).getTime(),
        endLocalMs: new Date(
          query.end.year,
          query.end.month - 1,
          query.end.day
        ).getTime(),
      };
    }
    const weekday = weekdayName(
      query.date.year,
      query.date.month,
      query.date.day
    );
    return {
      kind: query.kind,
      date: query.iso,
      display: query.display,
      weekday,
      localMs: query.localMs,
      ...(query.kind === "days-until" || query.kind === "days-since"
        ? { days: query.days }
        : {}),
    };
  },
};

export const timeTools: Tool[] = [getCurrentTime, getWeekdayForDate];
