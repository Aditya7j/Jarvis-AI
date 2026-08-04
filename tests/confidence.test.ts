import { describe, it, expect } from "vitest";
import {
  CONFIDENCE_HIGH,
  CONFIDENCE_MID,
  CONFIDENCE_LOW,
  confidenceBand,
  LOW_CONFIDENCE_FOLLOWUP,
} from "@/lib/vision/confidence";

describe("confidence contract", () => {
  it("defines a single ordered set of thresholds", () => {
    expect(CONFIDENCE_HIGH).toBeGreaterThan(CONFIDENCE_MID);
    expect(CONFIDENCE_MID).toBeGreaterThan(CONFIDENCE_LOW);
  });

  it("maps confidence to the correct band", () => {
    expect(confidenceBand(90)).toBe("high");
    expect(confidenceBand(80)).toBe("high");
    expect(confidenceBand(79)).toBe("uncertain");
    expect(confidenceBand(70)).toBe("uncertain");
    expect(confidenceBand(69)).toBe("low");
    expect(confidenceBand(50)).toBe("low");
    expect(confidenceBand(0)).toBe("low");
  });

  it("provides a low-confidence follow-up prompt", () => {
    expect(LOW_CONFIDENCE_FOLLOWUP.length).toBeGreaterThan(0);
    expect(LOW_CONFIDENCE_FOLLOWUP.toLowerCase()).toContain("reposition");
  });
});
