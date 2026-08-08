/**
 * Deterministic date-calc unit tests — locks the weekday of specific dates.
 * These are the acceptance dates for the date-hallucination fix: the weekday
 * must be computed by pure calendar arithmetic and NEVER vary.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeDateQuery,
  daysBetween,
  displayDate,
  extractDateTokens,
  isoDate,
  parseDateToken,
  weekdayName,
} from "@/lib/time/date-calc";

describe("weekdayName (deterministic calendar arithmetic)", () => {
  it("knows 15 Aug 2026 is a Saturday", () => {
    expect(weekdayName(2026, 8, 15)).toBe("Saturday");
  });

  it("knows 1 Jan 2025 is a Wednesday", () => {
    expect(weekdayName(2025, 1, 1)).toBe("Wednesday");
  });

  it("knows 29 Feb 2024 is a Thursday", () => {
    expect(weekdayName(2024, 2, 29)).toBe("Thursday");
  });

  it("knows 1 Jan 2000 is a Saturday", () => {
    expect(weekdayName(2000, 1, 1)).toBe("Saturday");
  });

  it("is stable across repeated calls (no LLM, no clock dependence)", () => {
    const first = weekdayName(2026, 8, 15);
    const second = weekdayName(2026, 8, 15);
    expect(first).toBe(second);
    expect(first).toBe("Saturday");
  });

  it("rejects impossible calendar dates", () => {
    expect(() => weekdayName(2026, 2, 30)).toThrow();
    expect(() => weekdayName(2026, 13, 1)).toThrow();
    expect(() => weekdayName(2025, 2, 29)).toThrow();
  });
});

describe("parseDateToken / extractDateTokens", () => {
  it("parses day-month-year", () => {
    const d = parseDateToken("15 Aug 2026");
    expect(d).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("15 August 2026")).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("15th August 2026")).toEqual({ year: 2026, month: 8, day: 15 });
  });

  it("parses month-day-year", () => {
    expect(parseDateToken("August 15, 2026")).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("Aug 15 2026")).toEqual({ year: 2026, month: 8, day: 15 });
  });

  it("parses ISO and slash/dot formats day-first", () => {
    expect(parseDateToken("2026-08-15")).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("15/08/2026")).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("15.08.2026")).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("15-08-2026")).toEqual({ year: 2026, month: 8, day: 15 });
  });

  it("parses Devanagari month names", () => {
    expect(parseDateToken("15 अगस्त 2026")).toEqual({ year: 2026, month: 8, day: 15 });
    expect(parseDateToken("15 जनवरी 2025")).toEqual({ year: 2025, month: 1, day: 15 });
  });

  it("rejects dates with impossible days", () => {
    expect(parseDateToken("31 Feb 2026")).toBeNull();
    expect(parseDateToken("29 Feb 2025")).toBeNull();
  });

  it("extracts a date token from a full question", () => {
    expect(extractDateTokens("What day will it be on 15 Aug 2026?")).toEqual([
      { year: 2026, month: 8, day: 15 },
    ]);
    expect(extractDateTokens("what is today's date?")).toEqual([]);
  });
});

describe("daysBetween / displayDate / isoDate", () => {
  it("counts whole days between two calendar dates", () => {
    expect(daysBetween({ year: 2026, month: 8, day: 8 }, { year: 2026, month: 8, day: 15 })).toBe(7);
    expect(daysBetween({ year: 2026, month: 8, day: 15 }, { year: 2026, month: 8, day: 8 })).toBe(-7);
    // Leap year boundary: 2024-02-28 -> 2024-03-01 is 2 days.
    expect(daysBetween({ year: 2024, month: 2, day: 28 }, { year: 2024, month: 3, day: 1 })).toBe(2);
  });

  it("formats a stable English display", () => {
    expect(displayDate({ year: 2026, month: 8, day: 15 })).toBe("August 15, 2026");
  });

  it("formats a stable ISO date", () => {
    expect(isoDate({ year: 2026, month: 8, day: 15 })).toBe("2026-08-15");
    expect(isoDate({ year: 2026, month: 3, day: 5 })).toBe("2026-03-05");
  });
});

describe("analyzeDateQuery (routing-level parser)", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("classifies a weekday question", () => {
    const q = analyzeDateQuery("What day is 15 Aug 2026?", now);
    expect(q?.kind).toBe("weekday");
    if (q?.kind === "weekday") {
      expect(q.weekday).toBe("Saturday");
      expect(q.iso).toBe("2026-08-15");
      expect(q.display).toBe("August 15, 2026");
    }
  });

  it("classifies days-until", () => {
    const q = analyzeDateQuery("How many days until 15 Aug 2026?", now);
    expect(q?.kind).toBe("days-until");
    if (q?.kind === "days-until") {
      expect(q.days).toBe(7);
    }
  });

  it("classifies days-since", () => {
    const q = analyzeDateQuery("How many days since 1 Jan 2026?", now);
    expect(q?.kind).toBe("days-since");
    if (q?.kind === "days-since") {
      expect(q.days).toBeGreaterThan(0);
    }
  });

  it("returns null when no date is present", () => {
    expect(analyzeDateQuery("what is today's date?", now)).toBeNull();
    expect(analyzeDateQuery("hello", now)).toBeNull();
  });
});
