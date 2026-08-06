import { describe, expect, it } from "vitest";
import {
  evaluateExpression,
  normalizeExpression,
} from "@/lib/toolkit/math";
import {
  runPipeline,
  type PipelineEvent,
  type PipelineModel,
} from "@/services/chat";

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
      for (const token of tokens) yield token;
    },
  };
}

async function collect(
  prompt: string,
  options: Parameters<typeof runPipeline>[3] = {}
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline(
    prompt,
    [{ role: "user", content: prompt }],
    fakeModel(["should never be called"]),
    options
  )) {
    events.push(event);
  }
  return events;
}

function textOf(events: PipelineEvent[]): string {
  return events
    .filter((e) => e.kind === "token")
    .map((e) => (e as { text: string }).text)
    .join("");
}

describe("math toolkit normalizes Hindi/Hinglish arithmetic", () => {
  it("parses Devanagari operators", () => {
    expect(evaluateExpression("2 गुना 3").value).toBe(6);
    expect(evaluateExpression("10 भाग 5").value).toBe(2);
    expect(evaluateExpression("4 जोड़ 3").value).toBe(7);
    expect(evaluateExpression("10 घटा 4").value).toBe(6);
    expect(evaluateExpression("12 गुना 11").value).toBe(132);
  });

  it("parses Hinglish operators", () => {
    expect(evaluateExpression("5 guna 3").value).toBe(15);
    expect(evaluateExpression("12 bhag 4").value).toBe(3);
    expect(evaluateExpression("2 jod 2").value).toBe(4);
    expect(evaluateExpression("9 ghata 5").value).toBe(4);
  });

  it("strips Hindi and Hinglish wrapper phrases", () => {
    expect(evaluateExpression("kitna hoga 5 plus 3").value).toBe(8);
    expect(evaluateExpression("कितना होगा 5 + 3").value).toBe(8);
    expect(evaluateExpression("2+2 क्या है").value).toBe(4);
    expect(evaluateExpression("2 गुना 3").formatted).toBe("6");
  });

  it("keeps English arithmetic working", () => {
    expect(evaluateExpression("what is 2 + 2?").value).toBe(4);
    expect(evaluateExpression("5 times 3").value).toBe(15);
  });
});

describe("chat pipeline answers Hindi/Hinglish math directly", () => {
  it("answers Devanagari arithmetic with no LLM", async () => {
    const events = await collect("2 गुना 3");
    const text = textOf(events);
    expect(text).toMatch(/= 6/);
    expect(text).not.toContain("should never be called");
    expect(events.some((e) => e.kind === "tool" && (e as { tool: string }).tool === "calculate")).toBe(true);
  });

  it("answers Hinglish arithmetic with no LLM", async () => {
    const events = await collect("kitna hoga 5 plus 3");
    expect(textOf(events)).toMatch(/= 8/);
  });
});
