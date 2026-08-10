/**
 * Validator unit suite.
 *
 * Locks the independent-recomputation guarantees in the Tool Router validators:
 * the validator must reject any output whose raw data contradicts itself or an
 * independently recomputed truth (Zeller's congruence for weekdays, rate Ã—
 * amount for currency, physical ranges for weather, formatted-vs-value
 * consistency, non-empty web content).
 */

import { describe, expect, it } from "vitest";

import {
  validateConvertResult,
  validateCurrencyResult,
  validateDateFact,
  validateMathResult,
  validateWeatherFact,
  validateWebSearch,
} from "@/services/tools/validators";
import type { ToolValidation } from "@/services/tools/types";

function valid(v: { valid: boolean }): void {
  expect(v.valid).toBe(true);
}

function invalid(v: { valid: boolean; reason?: string }): void {
  expect(v.valid).toBe(false);
}

/** Assert the result is invalid and return its reason (narrows the union). */
function reasonOf(v: ToolValidation): string {
  if (v.valid) throw new Error("expected an invalid result");
  return v.reason;
}

describe("validateDateFact", () => {
  it("accepts a weekday matching Zeller's congruence", () => {
    valid(
      validateDateFact({
        kind: "weekday",
        date: "2026-08-15",
        weekday: "Saturday",
        display: "August 15, 2026 is a Saturday.",
        localMs: 1754064000000,
      })
    );
  });

  it("rejects a weekday that contradicts the date", () => {
    const v = validateDateFact({
      kind: "weekday",
      date: "2026-08-15",
      weekday: "Wednesday",
      display: "August 15, 2026 is a Wednesday.",
      localMs: 1754064000000,
    });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toContain("weekday contradicts the date");
  });

  it("rejects a non-existent calendar date", () => {
    const v = validateDateFact({
      kind: "weekday",
      date: "2026-02-31",
      weekday: "Saturday",
      display: "February 31, 2026 is a Saturday.",
      localMs: 1,
    });
    invalid(v);
  });

  it("rejects a weekday that is not a real weekday name", () => {
    invalid(
      validateDateFact({
        kind: "weekday",
        date: "2026-08-15",
        weekday: "Saturdai",
        display: "x",
        localMs: 1,
      })
    );
  });

  it("rejects a malformed ISO date", () => {
    invalid(
      validateDateFact({
        kind: "weekday",
        date: "15/08/2026",
        weekday: "Saturday",
        display: "x",
        localMs: 1,
      })
    );
  });

  it("accepts a days-between result with both display dates", () => {
    valid(
      validateDateFact({
        kind: "days-between",
        start: "2026-01-01",
        end: "2026-01-10",
        startDisplay: "January 1, 2026",
        endDisplay: "January 10, 2026",
        days: 9,
        startLocalMs: 1,
        endLocalMs: 2,
      })
    );
  });

  it("accepts a days-until result", () => {
    valid(
      validateDateFact({
        kind: "days-until",
        date: "2026-12-25",
        weekday: "Friday",
        display: "December 25, 2026 is a Friday.",
        localMs: 1,
        days: 140,
      })
    );
  });

  it("rejects a days-until result missing the day count", () => {
    const v = validateDateFact({
      kind: "days-until",
      date: "2026-12-25",
      weekday: "Friday",
      display: "x",
      localMs: 1,
    });
    invalid(v);
  });
});

describe("validateWeatherFact", () => {
  const base = {
    condition: "Clear",
    location: { latitude: 28.6, longitude: 77.2 },
    observedAt: "2026-08-08T12:00:00.000Z",
    source: "test",
    temperatureC: 23,
  };

  it("accepts a plausible reading", () => {
    valid(validateWeatherFact({ ...base, temperatureC: 23, humidity: 60, windSpeedKmh: 12 }));
  });

  it("rejects a physically impossible temperature", () => {
    const v = validateWeatherFact({ ...base, temperatureC: 500 });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toContain("temperatureC outside plausible range");
  });

  it("rejects a sub-zero absolute temperature", () => {
    invalid(validateWeatherFact({ ...base, temperatureC: -120 }));
  });

  it("rejects an impossible humidity", () => {
    const v = validateWeatherFact({ ...base, humidity: 150 });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toContain("humidity outside plausible range");
  });

  it("rejects an absurd wind speed", () => {
    invalid(validateWeatherFact({ ...base, windSpeedKmh: 5000 }));
  });

  it("accepts null metrics as unverifiable", () => {
    valid(validateWeatherFact({ ...base, temperatureC: null, humidity: null, windSpeedKmh: null }));
  });

  it("rejects a missing location", () => {
    const { location, ...rest } = base;
    void location;
    invalid(validateWeatherFact(rest));
  });

  it("rejects a location of exactly (0, 0) only if absent", () => {
    valid(validateWeatherFact({ ...base, location: { latitude: 0, longitude: 0 } }));
  });

  it("rejects an invalid observedAt timestamp", () => {
    invalid(validateWeatherFact({ ...base, observedAt: "not-a-date" }));
  });
});

describe("validateMathResult", () => {
  it("accepts a result whose formatted string matches the value", () => {
    valid(validateMathResult({ expression: "23*7", value: 161, formatted: "161" }));
  });

  it("rejects a formatted string that contradicts the value", () => {
    const v = validateMathResult({ expression: "23*7", value: 161, formatted: "162" });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toContain("contradicts the computed value");
  });

  it("rejects a non-finite value", () => {
    invalid(validateMathResult({ expression: "1/0", value: Infinity, formatted: "Infinity" }));
  });
});

describe("validateConvertResult", () => {
  it("accepts a consistent conversion", () => {
    valid(
      validateConvertResult({
        value: 1.60934,
        fromUnit: "miles",
        toUnit: "kilometers",
        category: "length",
        formatted: "1.60934 km",
      })
    );
  });

  it("rejects a formatted string that contradicts the value", () => {
    invalid(
      validateConvertResult({
        value: 1.60934,
        fromUnit: "miles",
        toUnit: "kilometers",
        category: "length",
        formatted: "2.5 km",
      })
    );
  });
});

describe("validateCurrencyResult", () => {
  const base = {
    amount: 100,
    from: "USD",
    to: "EUR",
    rate: 0.92,
    converted: 92,
    formatted: "92 EUR",
  };

  it("accepts converted equal to the 6-decimal rate Ã— amount", () => {
    valid(validateCurrencyResult(base));
  });

  it("accepts float noise around the recomputed value", () => {
    valid(validateCurrencyResult({ ...base, converted: 92.0000004, formatted: "92 EUR" }));
  });

  it("rejects converted that contradicts the rate", () => {
    const v = validateCurrencyResult({ ...base, converted: 88, formatted: "88 EUR" });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toContain("contradicts the rate");
  });

  it("rejects a formatted string that contradicts converted", () => {
    const v = validateCurrencyResult({ ...base, formatted: "91 EUR" });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toContain("contradicts the converted amount");
  });
});

describe("validateWebSearch", () => {
  it("accepts a result with a non-empty abstract", () => {
    valid(validateWebSearch({ query: "x", abstract: "real content" }));
  });

  it("accepts a result with contentful topic text", () => {
    valid(validateWebSearch({ query: "x", topics: [{ text: "Event loop (JavaScript) — The mechanism that handles asynchronous operations." }] }));
  });

  it("rejects a result whose only topic is a bare title — a heading is not an answer", () => {
    const v = validateWebSearch({ query: "x", topics: [{ text: "Event loop" }] });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toBe("web_search: empty result");
  });

  it("rejects a result with only empty strings", () => {
    const v = validateWebSearch({ query: "x", heading: "", abstract: "", answer: "", topics: [] });
    expect(v.valid).toBe(false);
    expect(reasonOf(v)).toBe("web_search: empty result");
  });

  it("rejects a result that contains ONLY a title — a bare heading is not an answer", () => {
    const v = validateWebSearch({ query: "x", heading: "React", abstract: "", answer: "", topics: [] });
    expect(v.valid).toBe(false);
  });

  it("rejects a null result", () => {
    const v = validateWebSearch(null);
    expect(v.valid).toBe(false);
  });

  it("rejects a result missing the query", () => {
    invalid(validateWebSearch({ abstract: "content" }));
  });
});
