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

  it("strips Hinglish/Hindi compute commands without touching English or numbers", () => {
    expect(evaluateExpression("ginti karo 15*4").value).toBe(60);
    expect(evaluateExpression("hisab karo 12/3").value).toBe(4);
    expect(evaluateExpression("hisaab nikalo 10+5").value).toBe(15);
    expect(evaluateExpression("15*4 batao").value).toBe(60);
    expect(evaluateExpression("15*4 batao").formatted).toBe("60");
    expect(evaluateExpression("calculate karo 2+2").value).toBe(4);
    expect(evaluateExpression("solve karo 100-30").value).toBe(70);
    expect(evaluateExpression("ginti kijiye 7*6").value).toBe(42);
    expect(evaluateExpression("गिनती करो 15*4").value).toBe(60);
    expect(evaluateExpression("हिसाब करो 12/3").value).toBe(4);
    expect(evaluateExpression("5 गुना करो 3").value).toBe(15);
    expect(evaluateExpression("2 जोड़ करो 3").value).toBe(5);
  });

  it("does not break English expressions or numbers", () => {
    expect(evaluateExpression("calculate 2 + 2").value).toBe(4);
    expect(evaluateExpression("10 percent of 50").value).toBe(5);
    expect(evaluateExpression("3 times 2").value).toBe(6);
    expect(evaluateExpression("2.5 plus 1.5").value).toBe(4);
    expect(evaluateExpression("what is the value of 12 / 4").value).toBe(3);
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

  it("answers Hinglish compute commands with no LLM", async () => {
    const events = await collect("ginti karo 15*4");
    const text = textOf(events);
    expect(text).toMatch(/= 60/);
    expect(text).not.toContain("should never be called");
    const tool = events.find((e) => e.kind === "tool") as { tool: string; ok: boolean } | undefined;
    expect(tool?.tool).toBe("calculate");
    expect(tool?.ok).toBe(true);
  });

  it("answers Devanagari compute commands with no LLM", async () => {
    const events = await collect("गिनती करो 15*4");
    expect(textOf(events)).toMatch(/= 60/);
  });
});
