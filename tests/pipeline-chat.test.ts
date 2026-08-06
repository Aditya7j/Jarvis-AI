import { describe, expect, it } from "vitest";
import {
  runPipeline,
  runPipelineText,
  type PipelineModel,
  type PipelineEvent,
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
  messages: { role: "user"; content: string }[],
  model: PipelineModel,
  options: Parameters<typeof runPipeline>[3] = {}
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline(prompt, messages, model, options)) {
    events.push(event);
  }
  return events;
}

describe("chat pipeline (next /api/chat adapter contract)", () => {
  it("strips chain-of-thought in-flight on the LLM path", async () => {
    const model = fakeModel(["<thinking>add the numbers</thinking>It is ", "22", "°C."]);
    const events = await collect("tell me a joke", [{ role: "user", content: "tell me a joke" }], model);
    const tokens = events.filter((e) => e.kind === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toBe("It is 22°C.");
    expect(events.map((e) => e.kind)).toContain("done");
    expect(events.some((e) => e.kind === "status")).toBe(true);
  });

  it("answers calculator requests directly from the tool (no LLM)", async () => {
    const model = fakeModel(["should never be called"]);
    const events = await collect("what is 2+2?", [{ role: "user", content: "what is 2+2?" }], model);
    const tokens = events.filter((e) => e.kind === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toMatch(/2\s*\+\s*2\s*=\s*4/);
    expect(events.some((e) => e.kind === "tool" && (e as { tool: string }).tool === "calculate")).toBe(true);
    expect(events.map((e) => e.kind)).toContain("done");
  });

  it("refuses vision questions with a direct answer when no camera is on", async () => {
    const model = fakeModel(["should never be called"]);
    const events = await collect(
      "what do you see?",
      [{ role: "user", content: "what do you see?" }],
      model,
      { vision: { state: "off", frames: [] } }
    );
    const tokens = events.filter((e) => e.kind === "token").map((e) => (e as { text: string }).text).join("");
    expect(tokens).toContain("camera");
    expect(events.some((e) => e.kind === "vision")).toBe(true);
    expect(events.map((e) => e.kind)).toContain("done");
  });

  it("runPipelineText returns the streamed text without chain of thought", async () => {
    const model = fakeModel(["<Thought>internal</Thought>Final answer here"]);
    const result = await runPipelineText(
      "tell me a joke",
      [{ role: "user", content: "tell me a joke" }],
      model
    );
    expect(result.text).toBe("Final answer here");
    expect(result.intent).toBe("reasoning");
  });
});
