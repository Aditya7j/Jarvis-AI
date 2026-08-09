/**
 * Fact Authority unit suite.
 *
 * Locks the post-emission safety layer: any text about to reach the user from
 * a tool-backed class MUST contain the canonical values the tools computed.
 * A violation (LLM naturalization or formatting bug contradicting verified
 * data) is detected as { expected, actual } so the pipeline can drop the text
 * and emit a deterministic fallback instead.
 */

import { describe, expect, it } from "vitest";

import {
  assertFactInvariant,
  extractNumbers,
  HINDI_WEEKDAYS,
  numberInText,
} from "@/services/chat/fact-authority";
import { assertDateInvariant } from "@/services/chat/pipeline";
import type { VerifiedFact } from "@/services/planner";

function fact(tool: string, subject: string, value: unknown): VerifiedFact {
  return { tool, label: tool, subject, fact: value, executedAt: Date.now() };
}

describe("extractNumbers", () => {
  it("extracts plain integers", () => {
    expect(extractNumbers("the value is 23")).toEqual([23]);
  });

  it("extracts decimals and negative numbers", () => {
    expect(extractNumbers("-3.5 and 42")).toEqual([-3.5, 42]);
  });

  it("extracts numbers embedded in units and percentages", () => {
    expect(extractNumbers("It's 23°C, humidity 60%, wind 12 km/h")).toEqual([
      23, 60, 12,
    ]);
  });

  it("parses comma-grouped numbers", () => {
    expect(extractNumbers("population is 343,476")).toEqual([343476]);
  });

  it("returns nothing when there are no numbers", () => {
    expect(extractNumbers("no numbers here")).toEqual([]);
  });
});

describe("numberInText", () => {
  it("matches a value present in the text", () => {
    expect(numberInText("It's 23°C outside", 23)).toBe(true);
  });

  it("rejects a value absent from the text", () => {
    expect(numberInText("It's sunny", 23)).toBe(false);
  });

  it("treats equal fractional values as present", () => {
    expect(numberInText("current usage is 32.5%", 32.5)).toBe(true);
  });

  it("does not confuse distinct values", () => {
    expect(numberInText("current usage is 32%", 55)).toBe(false);
  });
});

describe("assertFactInvariant — date-calc", () => {
  const weekdayFact = fact("get_weekday_for_date", "the date", {
    kind: "weekday",
    date: "2026-08-15",
    weekday: "Saturday",
    display: "August 15, 2026 is a Saturday.",
  });

  it("accepts text containing the computed weekday", () => {
    expect(assertFactInvariant("date-calc", [weekdayFact], "August 15, 2026 is a Saturday.", "english")).toBeNull();
  });

  it("accepts the Hindi weekday in Hindi text", () => {
    expect(
      assertFactInvariant(
        "date-calc",
        [weekdayFact],
        `15 अगस्त 2026 ${HINDI_WEEKDAYS.Saturday} है।`,
        "hindi"
      )
    ).toBeNull();
  });

  it("rejects text that names a different weekday", () => {
    const violation = assertFactInvariant("date-calc", [weekdayFact], "August 15, 2026 is a Wednesday.", "english");
    expect(violation).toEqual({ expected: "Saturday", actual: "August 15, 2026 is a Wednesday." });
  });

  it("returns null when the fact is not a weekday", () => {
    const daysBetween = fact("get_weekday_for_date", "the date", { kind: "days-between", days: 9 });
    expect(assertFactInvariant("date-calc", [daysBetween], "anything", "english")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(assertFactInvariant("date-calc", [weekdayFact], null, "english")).toBeNull();
  });
});

describe("assertDateInvariant (wrapper)", () => {
  it("delegates to the general authority layer", () => {
    const data = { kind: "weekday", date: "2026-08-15", weekday: "Saturday" };
    expect(assertDateInvariant("date-calc", data, "15 Aug 2026 is a Saturday.", "english")).toBeNull();
    const violation = assertDateInvariant("date-calc", data, "15 Aug 2026 is a Tuesday.", "english");
    expect(violation?.expected).toBe("Saturday");
  });
});

describe("assertFactInvariant — math", () => {
  const mathFact = fact("calculate", "the calculation", {
    expression: "23*7",
    value: 161,
    formatted: "161",
  });

  it("accepts text containing the computed value", () => {
    expect(assertFactInvariant("math", [mathFact], "23 times 7 is 161.", "english")).toBeNull();
  });

  it("rejects text that contradicts the computed value", () => {
    const violation = assertFactInvariant("math", [mathFact], "23 times 7 is 162.", "english");
    expect(violation).toEqual({ expected: "161", actual: "23 times 7 is 162." });
  });

  it("accepts text containing the formatted result verbatim", () => {
    expect(assertFactInvariant("math", [mathFact], "The answer is 161", "english")).toBeNull();
  });

  it("returns null when the fact carries no finite value", () => {
    expect(assertFactInvariant("math", [fact("calculate", "x", { value: null })], "anything", "english")).toBeNull();
  });
});

describe("assertFactInvariant — conversion", () => {
  const currency = fact("convert_currency", "the currency", {
    amount: 100,
    from: "USD",
    to: "EUR",
    rate: 0.92,
    converted: 92,
    formatted: "92 EUR",
  });
  const unit = fact("convert_units", "the conversion", {
    value: 1.60934,
    fromUnit: "miles",
    toUnit: "kilometers",
    category: "length",
    formatted: "1.60934 km",
  });

  it("accepts text containing the converted currency value", () => {
    expect(assertFactInvariant("conversion", [currency], "That is 92 EUR.", "english")).toBeNull();
  });

  it("accepts the formatted unit value verbatim", () => {
    expect(assertFactInvariant("conversion", [unit], "3 miles is 1.60934 km.", "english")).toBeNull();
  });

  it("rejects text that contradicts the converted amount", () => {
    const violation = assertFactInvariant("conversion", [currency], "That is 91.5 EUR.", "english");
    expect(violation?.expected).toBe("92");
  });

  it("returns null when neither fact has a finite value", () => {
    const bare = fact("convert_units", "the conversion", { fromUnit: "miles", toUnit: "km" });
    expect(assertFactInvariant("conversion", [bare], "anything", "english")).toBeNull();
  });
});

describe("assertFactInvariant — weather", () => {
  const weatherFact = fact("get_weather", "the weather", {
    condition: "Clear",
    temperatureC: 23,
    location: { latitude: 28.6, longitude: 77.2 },
    observedAt: "2026-08-08T12:00:00.000Z",
    source: "test",
  });

  it("accepts text containing the verified temperature", () => {
    expect(assertFactInvariant("weather", [weatherFact], "It's 23°C and clear right now.", "english")).toBeNull();
  });

  it("rejects text that reports a different temperature", () => {
    const violation = assertFactInvariant("weather", [weatherFact], "It's 38°C and clear right now.", "english");
    expect(violation).toEqual({ expected: "23°C", actual: "It's 38°C and clear right now." });
  });

  it("accepts a Hindi answer containing the temperature", () => {
    expect(assertFactInvariant("weather", [weatherFact], "अभी 23°C है।", "hindi")).toBeNull();
  });

  it("returns null when temperatureC is absent (nothing to verify)", () => {
    const noTemp = fact("get_weather", "the weather", { condition: "Cloudy", temperatureC: null });
    expect(assertFactInvariant("weather", [noTemp], "It's cloudy.", "english")).toBeNull();
  });
});

describe("assertFactInvariant — time", () => {
  const timeFact = fact("get_current_time", "the time", { unixMs: 1754064000000 });

  it("accepts a 24-hour answer containing the canonical H:MM", () => {
    const at = new Date(1754064000000);
    const hour = at.getHours();
    const minutes = String(at.getMinutes()).padStart(2, "0");
    expect(assertFactInvariant("time", [timeFact], `It is ${hour}:${minutes} right now.`, "english")).toBeNull();
  });

  it("accepts a 12-hour answer with an identical H:MM", () => {
    const at = new Date(1754064000000);
    const minutes = String(at.getMinutes()).padStart(2, "0");
    const hour12 = (at.getHours() % 12 === 0 ? 12 : at.getHours() % 12);
    expect(assertFactInvariant("time", [timeFact], `It is ${hour12}:${minutes} PM.`, "english")).toBeNull();
  });

  it("rejects an answer with a different time", () => {
    const violation = assertFactInvariant("time", [timeFact], "It is 09:00 right now.", "english");
    expect(violation).not.toBeNull();
    expect(violation?.expected).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it("derives the expected H:MM from the canonical time string the user saw", () => {
    const t = fact("get_current_time", "the time", { unixMs: 1754064000000, time: "3:45 PM GMT+5:30" });
    expect(assertFactInvariant("time", [t], "It is 3:45 right now.", "english")).toBeNull();
    const wrong = assertFactInvariant("time", [t], "It is 9:00 right now.", "english");
    expect(wrong).not.toBeNull();
  });

  it("returns null when unixMs is missing", () => {
    expect(assertFactInvariant("time", [fact("get_current_time", "t", {})], "anything", "english")).toBeNull();
  });
});

describe("assertFactInvariant — date", () => {
  const dateFact = fact("get_current_time", "the date", { date: "August 15, 2026" });

  it("accepts text containing the day and year", () => {
    expect(assertFactInvariant("date", [dateFact], "Today is August 15, 2026.", "english")).toBeNull();
  });

  it("rejects text missing the verified date", () => {
    const violation = assertFactInvariant("date", [dateFact], "Today is Wednesday.", "english");
    expect(violation?.expected).toBe("August 15, 2026");
  });

  it("rejects the right day and year with the wrong month", () => {
    const violation = assertFactInvariant("date", [dateFact], "Today is September 15, 2026.", "english");
    expect(violation).not.toBeNull();
    expect(violation?.expected).toBe("August 15, 2026");
  });

  it("accepts a Hindi answer naming the correct Hindi month", () => {
    expect(assertFactInvariant("date", [dateFact], "आज 15 अगस्त 2026 है।", "hindi")).toBeNull();
  });

  it("accepts text that spells the month number instead of its name", () => {
    expect(assertFactInvariant("date", [dateFact], "Today is 15/8/2026.", "english")).toBeNull();
  });

  it("returns null when the date string cannot be parsed", () => {
    expect(assertFactInvariant("date", [fact("get_current_time", "d", { date: "n/a" })], "anything", "english")).toBeNull();
  });
});

describe("assertFactInvariant — system", () => {
  const systemFact = fact("get_system_status", "system status", {
    cpu: { loadPercent: 32.4 },
    memory: { usedPercent: 55.1 },
    disk: { usedPercent: 60.9 },
  });

  it("accepts text containing every rounded metric", () => {
    expect(assertFactInvariant("system", [systemFact], "CPU is 32%, memory 55%, disk 61%.", "english")).toBeNull();
  });

  it("rejects text that omits a verified metric", () => {
    const violation = assertFactInvariant("system", [systemFact], "CPU is 32%.", "english");
    expect(violation?.expected).toContain("55");
  });

  it("returns null when no numeric metric exists", () => {
    expect(assertFactInvariant("system", [fact("get_system_status", "s", {})], "anything", "english")).toBeNull();
  });

  it("ignores non-system facts (e.g. battery-only results)", () => {
    const battery = fact("battery-status", "battery", { chargePercent: 80 });
    expect(assertFactInvariant("system", [battery], "Battery at 80%.", "english")).toBeNull();
  });
});

describe("assertFactInvariant — unverifiable classes", () => {
  it("returns null for classes without a fact-containment rule", () => {
    const searchFact = fact("web_search", "the topic", { query: "x", abstract: "y" });
    expect(assertFactInvariant("search", [searchFact], "anything", "english")).toBeNull();
    expect(assertFactInvariant("memory", [], "anything", "english")).toBeNull();
    expect(assertFactInvariant("reasoning", [], "anything", "english")).toBeNull();
    expect(assertFactInvariant("vision", [], "anything", "english")).toBeNull();
  });

  it("returns null for an empty fact set", () => {
    expect(assertFactInvariant("weather", [], "anything", "english")).toBeNull();
  });
});
