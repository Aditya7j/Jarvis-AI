import { describe, it, expect } from "vitest";
import { getSystemClock } from "@/lib/ai/system-tools";

describe("getSystemClock", () => {
  it("returns a verified timestamp for a known instant", () => {
    const clock = getSystemClock(new Date("2026-08-04T06:11:00Z"));
    expect(clock.iso).toBe("2026-08-04T06:11:00.000Z");
    expect(clock.unixMs).toBe(new Date("2026-08-04T06:11:00Z").getTime());
    expect(clock.time).toMatch(/\d/);
    expect(clock.date.length).toBeGreaterThan(0);
    expect(clock.timezone.length).toBeGreaterThan(0);
    expect(clock.formatted.length).toBeGreaterThan(clock.time.length);
  });
});
