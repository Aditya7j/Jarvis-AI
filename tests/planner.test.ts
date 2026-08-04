import { describe, it, expect } from "vitest";
import {
  classifyPlanIntent,
  planRoute,
  isDirectIntent,
  toolLabelForIntent,
  detectSystemClock,
  detectGeolocation,
  detectWeather,
  detectBattery,
  detectOcr,
} from "@/services/planner";
import { buildVerifiedFactContext } from "@/lib/ai/prompts";

describe("Intent Planner", () => {
  describe("classifyPlanIntent", () => {
    it.each([
      ["What time is it?", "system-clock"],
      ["What's the current time?", "system-clock"],
      ["What is the date?", "system-clock"],
      ["What day is it today?", "system-clock"],
      ["Which timezone am I in?", "system-clock"],
      ["2 + 2", "calculator"],
      ["calculate 12.5 * 4", "calculator"],
      ["Convert 5 miles to kilometers", "unit-conversion"],
      ["How many feet in 10 meters?", "unit-conversion"],
      ["What is 100 USD in EUR?", "currency"],
      ["Search the web for openai news", "web-search"],
      ["What are today's headlines?", "news"],
      ["Directions to the airport", "maps"],
      ["How much RAM is used?", "system-status"],
      ["Remind me to buy milk", "tasks"],
      ["Remember that I like coffee", "memory"],
      ["Where am I?", "geolocation"],
      ["What city am I in?", "geolocation"],
      ["What is my current location?", "geolocation"],
      ["What's the weather like?", "weather"],
      ["Is it raining outside?", "weather"],
      ["What's the temperature today?", "weather"],
      ["What's my battery level?", "battery"],
      ["How much battery is left?", "battery"],
      ["What am I wearing?", "vision"],
      ["What do you see?", "vision"],
      ["What is in front of me?", "vision"],
      ["Read the text on the screen", "ocr"],
      ["What does the sign say?", "ocr"],
      ["Hello there", "llm"],
    ])("%s → %s", (prompt, expected) => {
      expect(classifyPlanIntent(prompt)).toBe(expected);
    });

    it("keeps general conversation on the LLM", () => {
      expect(classifyPlanIntent("What is React?")).toBe("llm");
      expect(classifyPlanIntent("Tell me a joke")).toBe("llm");
      expect(
        classifyPlanIntent("Write a Python function that sorts a list")
      ).toBe("llm");
    });

    it("falls back to LLM for empty or casual input", () => {
      expect(classifyPlanIntent("")).toBe("llm");
      expect(classifyPlanIntent("   ")).toBe("llm");
      expect(classifyPlanIntent("How are you feeling today?")).toBe("llm");
    });

    it("does not hijack reference or scheduling questions", () => {
      expect(classifyPlanIntent("What time does my flight leave?")).toBe("llm");
      expect(classifyPlanIntent("Where is the git config file?")).toBe("llm");
      expect(
        classifyPlanIntent("What temperature should I bake bread at?")
      ).toBe("llm");
    });
  });

  describe("system-tool detectors (folded from the legacy intent router)", () => {
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

  describe("planRoute", () => {
    it("routes deterministic tool output directly (no LLM)", () => {
      expect(planRoute("2 + 2").kind).toBe("direct");
      expect(planRoute("Convert 5 miles to km").kind).toBe("direct");
      expect(planRoute("100 USD to EUR").kind).toBe("direct");
      expect(isDirectIntent(classifyPlanIntent("2 + 2"))).toBe(true);
    });

    it("routes general conversation to the LLM", () => {
      const route = planRoute("Tell me a joke");
      expect(route.kind).toBe("llm");
      expect(route.step.label).toBe("LLM");
    });

    it("routes tool-backed facts to naturalization", () => {
      expect(planRoute("What time is it?").kind).toBe("naturalize");
      expect(planRoute("What is the weather like?").kind).toBe("naturalize");
      expect(planRoute("What is the current CPU usage?").kind).toBe("naturalize");
    });
  });

  it("maps intents to human labels", () => {
    expect(toolLabelForIntent("system-clock")).toBe("System Clock");
    expect(toolLabelForIntent("geolocation")).toBe("Browser Geolocation API");
    expect(toolLabelForIntent("weather")).toBe("Weather API");
    expect(toolLabelForIntent("battery")).toBe("Battery Status API");
    expect(toolLabelForIntent("vision")).toBe("Vision Manager");
    expect(toolLabelForIntent("ocr")).toBe("Vision Model");
    expect(toolLabelForIntent("calculator")).toBe("Calculator");
    expect(toolLabelForIntent("llm")).toBe("LLM");
  });
});

describe("buildVerifiedFactContext", () => {
  it("marks the tool output as the only source of truth", () => {
    const block = buildVerifiedFactContext("System Clock", "the current time", {
      time: "11:55 AM IST",
    });
    expect(block).toContain("System Clock");
    expect(block).toContain("11:55 AM IST");
    expect(block).toContain("ONLY source of truth");
    expect(block).toContain("Never guess");
  });
});
