import { describe, it, expect } from "vitest";
import {
  classifyToolIntent,
  toolLabelFor,
  buildVerifiedFactContext,
  detectSystemClock,
  detectGeolocation,
  detectWeather,
  detectBattery,
  detectOcr,
} from "@/lib/ai/intent-router";
import { getSystemClock } from "@/lib/ai/system-tools";

describe("classifyToolIntent", () => {
  it("routes time/date/timezone questions to System Clock", () => {
    expect(classifyToolIntent("What time is it?")).toBe("system-clock");
    expect(classifyToolIntent("What's the current time?")).toBe("system-clock");
    expect(classifyToolIntent("What is the date?")).toBe("system-clock");
    expect(classifyToolIntent("What day is it today?")).toBe("system-clock");
    expect(classifyToolIntent("Which timezone am I in?")).toBe("system-clock");
  });

  it("routes location questions to Browser Geolocation", () => {
    expect(classifyToolIntent("Where am I?")).toBe("geolocation");
    expect(classifyToolIntent("What city am I in?")).toBe("geolocation");
    expect(classifyToolIntent("What is my current location?")).toBe(
      "geolocation"
    );
  });

  it("routes weather questions to the Weather API", () => {
    expect(classifyToolIntent("What's the weather like?")).toBe("weather");
    expect(classifyToolIntent("Is it raining outside?")).toBe("weather");
    expect(classifyToolIntent("What's the temperature today?")).toBe("weather");
  });

  it("routes battery questions to the Battery Status API", () => {
    expect(classifyToolIntent("What's my battery level?")).toBe("battery");
    expect(classifyToolIntent("How much battery is left?")).toBe("battery");
  });

  it("routes camera questions to the vision pipeline", () => {
    expect(classifyToolIntent("What am I wearing?")).toBe("vision");
    expect(classifyToolIntent("What do you see?")).toBe("vision");
    expect(classifyToolIntent("What is in front of me?")).toBe("vision");
  });

  it("routes OCR requests to the vision model", () => {
    expect(classifyToolIntent("Read the text on the screen")).toBe("ocr");
    expect(classifyToolIntent("What does the sign say?")).toBe("ocr");
  });

  it("keeps general conversation on the LLM", () => {
    expect(classifyToolIntent("What is React?")).toBe("llm");
    expect(classifyToolIntent("Tell me a joke")).toBe("llm");
    expect(classifyToolIntent("Write a Python function that sorts a list")).toBe(
      "llm"
    );
    expect(classifyToolIntent("What is 2 + 2?")).toBe("llm");
    expect(classifyToolIntent("")).toBe("llm");
    expect(classifyToolIntent("   ")).toBe("llm");
  });

  it("does not hijack reference or scheduling questions", () => {
    expect(classifyToolIntent("What time does my flight leave?")).toBe("llm");
    expect(classifyToolIntent("Where is the git config file?")).toBe("llm");
    expect(classifyToolIntent("What temperature should I bake bread at?")).toBe(
      "llm"
    );
  });
});

describe("individual detectors", () => {
  it("detectSystemClock", () => {
    expect(detectSystemClock("What time is it?")).toBe(true);
    expect(detectSystemClock("What time does my flight leave?")).toBe(false);
  });

  it("detectGeolocation", () => {
    expect(detectGeolocation("Where am I?")).toBe(true);
    expect(detectGeolocation("Where is my phone?")).toBe(false);
  });

  it("detectWeather", () => {
    expect(detectWeather("Will it rain today?")).toBe(true);
    expect(detectWeather("Tell me about rain forests")).toBe(false);
  });

  it("detectBattery", () => {
    expect(detectBattery("How is my battery?")).toBe(true);
    expect(detectBattery("Explain battery recycling")).toBe(true);
  });

  it("detectOcr", () => {
    expect(detectOcr("Read the text on the screen")).toBe(true);
    expect(detectOcr("What does it say?")).toBe(true);
    expect(detectOcr("Tell me a story")).toBe(false);
  });
});

describe("toolLabelFor", () => {
  it("maps intents to human tool names", () => {
    expect(toolLabelFor("system-clock")).toBe("System Clock");
    expect(toolLabelFor("geolocation")).toBe("Browser Geolocation API");
    expect(toolLabelFor("weather")).toBe("Weather API");
    expect(toolLabelFor("battery")).toBe("Battery Status API");
    expect(toolLabelFor("vision")).toBe("Vision Manager");
    expect(toolLabelFor("ocr")).toBe("Vision Model");
    expect(toolLabelFor("llm")).toBe("LLM");
  });
});

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

describe("buildVerifiedFactContext", () => {
  it("marks the tool output as the only source of truth", () => {
    const block = buildVerifiedFactContext(
      "System Clock",
      "the current time",
      { time: "11:55 AM IST" }
    );
    expect(block).toContain("System Clock");
    expect(block).toContain("11:55 AM IST");
    expect(block).toContain("ONLY source of truth");
    expect(block).toContain("Never guess");
  });
});
