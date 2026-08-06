import { describe, it, expect } from "vitest";
import {
  classifyPlanIntent,
  planRoute,
  isDirectClass,
  toolLabelForClass,
  CLASS_LABELS,
  detectSystemClock,
  detectTime,
  detectDate,
  detectCalendar,
  detectProfile,
  detectGeolocation,
  detectWeather,
  detectBattery,
  detectOcr,
  detectConversational,
} from "@/services/planner";
import { DIRECT_CLASSES } from "@/services/planner/types";
import { buildVerifiedFactContext } from "@/lib/ai/prompts";

describe("Intent Planner", () => {
  describe("classifyPlanIntent", () => {
    it.each([
      ["What time is it?", "time"],
      ["What's the current time?", "time"],
      ["What is the date?", "date"],
      ["What day is it today?", "date"],
      ["Which timezone am I in?", "time"],
      ["2 + 2", "math"],
      ["calculate 12.5 * 4", "math"],
      ["Convert 5 miles to kilometers", "conversion"],
      ["How many feet in 10 meters?", "conversion"],
      ["What is 100 USD in EUR?", "conversion"],
      ["Search the web for openai news", "search"],
      ["What are today's headlines?", "search"],
      ["Directions to the airport", "search"],
      ["How much RAM is used?", "system"],
      ["Remind me to buy milk", "tasks"],
      ["Remember that I like coffee", "memory"],
      ["Where am I?", "location"],
      ["What city am I in?", "location"],
      ["What is my current location?", "location"],
      ["What's the weather like?", "weather"],
      ["Is it raining outside?", "weather"],
      ["What's the temperature today?", "weather"],
      ["What's my battery level?", "system"],
      ["How much battery is left?", "system"],
      ["What's on my calendar today?", "calendar"],
      ["What meetings do I have tomorrow?", "calendar"],
      ["What is my name?", "profile"],
      ["What are my preferences?", "profile"],
      ["What am I wearing?", "vision"],
      ["What do you see?", "vision"],
      ["What is in front of me?", "vision"],
      ["Read the text on the screen", "vision"],
      ["What does the sign say?", "vision"],
      ["Hello there", "reasoning"],
    ])("%s → %s", (prompt, expected) => {
      expect(classifyPlanIntent(prompt)).toBe(expected);
    });

    it("keeps general conversation on the LLM", () => {
      expect(classifyPlanIntent("What is React?")).toBe("reasoning");
      expect(classifyPlanIntent("Tell me a joke")).toBe("reasoning");
      expect(
        classifyPlanIntent("Write a Python function that sorts a list")
      ).toBe("reasoning");
    });

    it("falls back to reasoning for empty or casual input", () => {
      expect(classifyPlanIntent("")).toBe("reasoning");
      expect(classifyPlanIntent("   ")).toBe("reasoning");
      expect(classifyPlanIntent("How are you feeling today?")).toBe("reasoning");
    });

    it("does not hijack reference or scheduling questions", () => {
      expect(classifyPlanIntent("What time does my flight leave?")).toBe(
        "reasoning"
      );
      expect(classifyPlanIntent("Where is the git config file?")).toBe(
        "reasoning"
      );
      expect(
        classifyPlanIntent("What temperature should I bake bread at?")
      ).toBe("reasoning");
    });

    it("covers every class in the DIRECT_CLASSES contract", () => {
      for (const c of DIRECT_CLASSES) {
        expect(CLASS_LABELS[c]).toBeTruthy();
      }
    });
  });

  describe("system-tool detectors (folded from the legacy intent router)", () => {
    it("detectSystemClock", () => {
      expect(detectSystemClock("What time is it?")).toBe(true);
      expect(detectSystemClock("What time does my flight leave?")).toBe(false);
    });

    it("detectTime / detectDate", () => {
      expect(detectTime("What time is it?")).toBe(true);
      expect(detectDate("What time is it?")).toBe(false);
      expect(detectDate("What is the date?")).toBe(true);
      expect(detectTime("What is the date?")).toBe(false);
      expect(detectTime("What time does my flight leave?")).toBe(false);
    });

    it("detectCalendar", () => {
      expect(detectCalendar("What's on my calendar today?")).toBe(true);
      expect(detectCalendar("Show me my meetings")).toBe(true);
      expect(detectCalendar("Set a calendar reminder")).toBe(false);
    });

    it("detectProfile", () => {
      expect(detectProfile("What is my name?")).toBe(true);
      expect(detectProfile("Who am I?")).toBe(true);
      expect(detectProfile("Tell me a story")).toBe(false);
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
      expect(detectBattery("What's my battery percentage?")).toBe(true);
      expect(detectBattery("Explain battery recycling")).toBe(false);
      expect(detectBattery("How do lithium batteries work?")).toBe(false);
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
      expect(planRoute("What time is it?").kind).toBe("direct");
      expect(planRoute("What is today's date?").kind).toBe("direct");
      expect(isDirectClass(classifyPlanIntent("2 + 2"))).toBe(true);
      expect(isDirectClass(classifyPlanIntent("What time is it?"))).toBe(true);
    });

    it("routes general conversation to the LLM", () => {
      const route = planRoute("Tell me a joke");
      expect(route.kind).toBe("llm");
      expect(route.step.label).toBe("Reasoning Model");
    });

    it("routes tool-backed facts to naturalization", () => {
      expect(planRoute("What is the weather like?").kind).toBe("naturalize");
      expect(planRoute("What is the current CPU usage?").kind).toBe(
        "naturalize"
      );
      expect(planRoute("What's on my calendar today?").kind).toBe("naturalize");
    });

    it("signals that profile/calendar/tasks are never LLM-hallucinated", () => {
      expect(planRoute("What is my name?").kind).toBe("naturalize");
      expect(planRoute("What's on my calendar today?").kind).toBe("naturalize");
      expect(planRoute("Remind me to buy milk").kind).toBe("naturalize");
    });
  });

  it("maps classes to human labels", () => {
    expect(toolLabelForClass("time")).toBe("System Clock");
    expect(toolLabelForClass("location")).toBe("Browser Geolocation API");
    expect(toolLabelForClass("weather")).toBe("Weather API");
    expect(toolLabelForClass("system")).toBe("System Monitor");
    expect(toolLabelForClass("vision")).toBe("Vision System");
    expect(toolLabelForClass("math")).toBe("Calculator");
    expect(toolLabelForClass("reasoning")).toBe("Reasoning Model");
  });
});

describe("tool-invocation contract", () => {
  describe("greetings and casual conversation never invoke tools", () => {
    it.each([
      "hi",
      "hello",
      "hey jarvis",
      "good morning",
      "good evening",
      "how are you",
      "thanks",
      "thank you",
      "ok",
      "yes",
      "no",
      "great",
      "sure",
    ])("%s → reasoning with zero tools", (prompt) => {
      expect(detectConversational(prompt)).toBe(true);
      expect(classifyPlanIntent(prompt)).toBe("reasoning");
      const route = planRoute(prompt);
      expect(route.kind).toBe("llm");
      expect(route.step.tools).toEqual([]);
      expect(route.audit.toolsConsidered).toEqual([]);
      expect(route.audit.toolsSelected).toEqual([]);
      expect(route.audit.toolReasons).toEqual({});
      expect(route.audit.why.some((w) => /greeting|conversation/i.test(w))).toBe(true);
    });

    it("routes a greeting followed by a real request to the tool", () => {
      expect(classifyPlanIntent("hey jarvis what time is it")).toBe("time");
      expect(classifyPlanIntent("hey, what's the weather?")).toBe("weather");
      expect(classifyPlanIntent("hi there what is my name?")).toBe("profile");
    });
  });

  describe("tool-backed queries invoke exactly the single required tool", () => {
    it.each([
      ["what time is it", "time", ["get_current_time"]],
      ["what's the current time", "time", ["get_current_time"]],
      ["today's date", "date", ["get_current_time"]],
      ["what is today's date", "date", ["get_current_time"]],
      ["my schedule today", "calendar", ["get_calendar"]],
      ["what's on my calendar today", "calendar", ["get_calendar"]],
      ["what's the weather", "weather", ["get_weather"]],
      ["what is my name", "profile", ["get_owner_profile"]],
    ])("%s → %s with exactly %o", (prompt, expectedCls, expectedTools) => {
      expect(classifyPlanIntent(prompt)).toBe(expectedCls);
      const route = planRoute(prompt);
      expect(route.step.tools).toEqual(expectedTools);
      expect(route.audit.toolsSelected).toEqual(expectedTools);
      const tool = expectedTools[0];
      expect(route.audit.toolReasons).toHaveProperty(tool);
      expect(typeof route.audit.toolReasons[tool]).toBe("string");
    });
  });

  describe("reference questions never invoke tools", () => {
    it.each([
      "What time does my flight leave?",
      "What temperature should I bake bread at?",
      "Tell me about rain forests",
      "What is climate change?",
      "What is humidity?",
      "How does wind form?",
      "Where is the git config file?",
      "Explain battery recycling",
      "What is React?",
      "Tell me a joke",
    ])("%s → reasoning with zero tools", (prompt) => {
      expect(classifyPlanIntent(prompt)).toBe("reasoning");
      expect(planRoute(prompt).step.tools).toEqual([]);
    });
  });

  describe("plan audit", () => {
    it("explains why the intent was chosen and which tools are required", () => {
      const route = planRoute("what time is it");
      expect(route.audit.prompt).toBe("what time is it");
      expect(route.audit.intent).toBe("time");
      expect(route.audit.confidence).toBe(100);
      expect(route.audit.why.length).toBeGreaterThan(0);
      expect(route.audit.toolsConsidered).toEqual(["get_current_time"]);
      expect(route.audit.toolsSelected).toEqual(["get_current_time"]);
      expect(route.audit.toolReasons.get_current_time).toMatch(/system clock/);
    });

    it("records zero tools and a reason for casual conversation", () => {
      const route = planRoute("hi");
      expect(route.audit.intent).toBe("reasoning");
      expect(route.audit.toolsSelected).toEqual([]);
      expect(route.audit.why.some((w) => /no tool/i.test(w))).toBe(true);
    });
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
