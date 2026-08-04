import { describe, it, expect } from "vitest";
import {
  classifyPlanIntent,
  planRoute,
  isDirectIntent,
  toolLabelForIntent,
} from "@/services/planner";

describe("Intent Planner", () => {
  describe("classifyPlanIntent", () => {
    it.each([
      ["What time is it?", "system-clock"],
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
      ["Hello there", "llm"],
    ])("%s → %s", (prompt, expected) => {
      expect(classifyPlanIntent(prompt)).toBe(expected);
    });

    it("falls back to LLM for empty or casual input", () => {
      expect(classifyPlanIntent("")).toBe("llm");
      expect(classifyPlanIntent("How are you feeling today?")).toBe("llm");
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
    expect(toolLabelForIntent("weather")).toBe("Weather API");
    expect(toolLabelForIntent("calculator")).toBe("Calculator");
    expect(toolLabelForIntent("system-clock")).toBe("System Clock");
  });
});
