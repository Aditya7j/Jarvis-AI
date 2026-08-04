import { describe, it, expect } from "vitest";
import {
  CoTFilter,
  sanitizeFinalAnswer,
  stripChainOfThought,
} from "@/services/reasoning";

describe("Reasoning Engine — chain-of-thought sanitization", () => {
  it("strips <think> blocks", () => {
    const input =
      "<think>Let me reason carefully about the math.</think>The total is 42.";
    expect(stripChainOfThought(input)).toBe("The total is 42.");
  });

  it("strips <reasoning> blocks", () => {
    const input =
      "<reasoning>The user asked for the weather.</reasoning>It is sunny.";
    expect(stripChainOfThought(input)).toBe("It is sunny.");
  });

  it("strips Thought: lines", () => {
    const input = "Thought: I should use the weather tool.\nIt is 22°C.";
    expect(stripChainOfThought(input)).toBe("It is 22°C.");
  });

  it("handles lowercase and mixed-case tags", () => {
    expect(stripChainOfThought("<thinking>hmm</thinking>hi")).toBe("hi");
    expect(stripChainOfThought("<Thought>x</Thought>hi")).toBe("hi");
  });

  it("keeps ordinary text intact", () => {
    const text = "The temperature is 22 degrees and the sky is clear.";
    expect(stripChainOfThought(text)).toBe(text);
  });

  it("sanitizeFinalAnswer delegates to the same contract", () => {
    expect(sanitizeFinalAnswer("<think>secret</think>Final answer")).toBe("Final answer");
  });

  describe("CoTFilter (streaming)", () => {
    it("reconstructs clean output across chunk boundaries", () => {
      const filter = new CoTFilter();
      const pieces = ["The ans", "wer is ", "<think>intern", "al chain", "</think>", "42."];
      const chunks = pieces.map((p) => filter.push(p));
      chunks.push(filter.flush());
      const output = chunks.join("");
      expect(output).toContain("The answer is");
      expect(output).toContain("42.");
      expect(output).not.toContain("internal");
      expect(output).not.toContain("<think>");
      expect(output).not.toContain("</think>");
    });

    it("tracks emitted character count", () => {
      const filter = new CoTFilter();
      filter.push("a");
      filter.push("<think>x</think>b");
      filter.flush();
      expect(filter.emitted()).toBe(2);
    });

    it("drops unclosed think blocks at end of stream", () => {
      const filter = new CoTFilter();
      filter.push("visible");
      filter.push("<think>never closed");
      const flushed = filter.flush();
      expect(flushed).not.toContain("<think>");
      expect(flushed).not.toContain("never closed");
    });
  });
});
