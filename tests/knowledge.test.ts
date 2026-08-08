/**
 * Factual-knowledge routing suite.
 *
 * Locks the guarantee that a knowledge question ("Who was the first Sikh
 * prime minister of India?") is answered from a verified web snippet — never
 * from the reasoning model's training data (which hallucinates confidently).
 * The model is only ever allowed to naturalize the verified search result.
 */

import { beforeEach, afterEach, describe, expect, it, vi, type Mock } from "vitest";

const memoryStub = vi.hoisted(() => ({
  listEntries: vi.fn(async () => []),
  createEntry: vi.fn(async () => ({})),
}));

vi.mock("@/lib/memory", () => ({
  memoryService: memoryStub,
  MemoryService: class {},
  JsonFileMemoryRepository: class {},
  buildOwnerContext: () => "",
  appendMemoryContext: (s: string) => s,
}));

vi.mock("@/lib/toolkit/web", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/toolkit/web")>();
  return { ...actual, webSearch: vi.fn() };
});

import { webSearch } from "@/lib/toolkit/web";
import { initToolRouter, toolCache } from "@/services/tools";
import { runPipeline, type PipelineModel } from "@/services/chat";
import { detectKnowledge } from "@/services/planner";

const SIKH_SNIPPET = {
  query: "Who was the first Sikh prime minister of India?",
  heading: "Manmohan Singh",
  abstract:
    "Manmohan Singh was the first and remains the only Sikh prime minister of India, serving from 2004 to 2014.",
  answer: null,
  source: "DuckDuckGo",
  url: "https://en.wikipedia.org/wiki/Manmohan_Singh",
  topics: [{ text: "Manmohan Singh", url: "https://en.wikipedia.org/wiki/Manmohan_Singh" }],
  engine: "DuckDuckGo",
};

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
      for (const token of tokens) yield token;
    },
  };
}

type TestEvent = { kind: string; [key: string]: unknown };

async function collect(prompt: string, model: PipelineModel): Promise<TestEvent[]> {
  const events: TestEvent[] = [];
  for await (const event of runPipeline(prompt, [{ role: "user", content: prompt }], model)) {
    events.push(event as TestEvent);
  }
  return events;
}

function tokensOf(events: TestEvent[]): string {
  return events
    .filter((e) => e.kind === "token")
    .map((e) => e.text as string)
    .join("");
}

function planOf(events: TestEvent[]): TestEvent | undefined {
  return events.find((e) => e.kind === "plan");
}

function toolOf(events: TestEvent[]): TestEvent | undefined {
  return events.find((e) => e.kind === "tool");
}

describe("detectKnowledge", () => {
  it("detects factual-knowledge questions", () => {
    expect(detectKnowledge("Who is the prime minister of India now?")).toBe(true);
    expect(detectKnowledge("Who was the first Sikh prime minister of India?")).toBe(true);
    expect(detectKnowledge("What is the capital of France?")).toBe(true);
    expect(detectKnowledge("When did India become independent?")).toBe(true);
    expect(detectKnowledge("Which country has the largest population?")).toBe(true);
    expect(detectKnowledge("Who won the 2022 FIFA World Cup?")).toBe(true);
  });

  it("never detects identity, meta or routed-class questions", () => {
    expect(detectKnowledge("Who are you?")).toBe(false);
    expect(detectKnowledge("What is your name?")).toBe(false);
    expect(detectKnowledge("What can you do?")).toBe(false);
    expect(detectKnowledge("Who am I?")).toBe(false);
    expect(detectKnowledge("Where are you?")).toBe(false);
    expect(detectKnowledge("What's up?")).toBe(false);
    expect(detectKnowledge("What do you think?")).toBe(false);
    expect(detectKnowledge("What is today's date?")).toBe(false);
    expect(detectKnowledge("What time is it?")).toBe(false);
    expect(detectKnowledge("What is the weather today?")).toBe(false);
    expect(detectKnowledge("What is 2+2?")).toBe(false);
    expect(detectKnowledge("What is 100 usd in inr?")).toBe(false);
  });
});

describe("factual-knowledge routing", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("routes a factual question to web_search and answers directly from the verified snippet", async () => {
    (webSearch as Mock).mockResolvedValue(SIKH_SNIPPET);
    const model = fakeModel(["Manmohan Singh"]);
    const spy = vi.spyOn(model, "streamText");
    const events = await collect("Who was the first Sikh prime minister of India?", model);
    expect(planOf(events)?.intent).toBe("search");
    const tool = toolOf(events);
    expect(tool?.tool).toBe("web_search");
    expect(tool?.ok).toBe(true);
    expect((webSearch as Mock).mock.calls[0][0]).toContain("first Sikh prime minister");
    // The verified snippet is formatted directly — the reasoning model is never invoked.
    expect(spy).not.toHaveBeenCalled();
    expect(tokensOf(events)).toContain("only Sikh prime minister");
    expect(tokensOf(events)).toContain("According to DuckDuckGo");
  });

  it("answers 'who is the prime minister of India now' from the web, never from memory", async () => {
    (webSearch as Mock).mockResolvedValue({
      ...SIKH_SNIPPET,
      query: "Who is the prime minister of India now?",
      heading: "Narendra Modi",
      abstract:
        "Narendra Modi is the Prime Minister of India. He has been in office since May 26, 2014.",
    });
    const events = await collect("Who is the prime minister of India now?", fakeModel(["Narendra Modi"]));
    expect(planOf(events)?.intent).toBe("search");
    expect(toolOf(events)?.tool).toBe("web_search");
    expect(tokensOf(events)).toContain("Narendra Modi");
    expect(memoryStub.listEntries).not.toHaveBeenCalled();
  });

  it("never lets the model guess when the web source is unavailable", async () => {
    (webSearch as Mock).mockRejectedValue(new Error("network down"));
    const events = await collect(
      "Who was the first Sikh prime minister of India?",
      fakeModel(["Manmohan Singh won in 2022"])
    );
    const text = tokensOf(events);
    expect(text).not.toContain("Singh");
    expect(planOf(events)?.intent).toBe("search");
    const tool = toolOf(events);
    expect(tool?.tool).toBe("web_search");
    expect(tool?.ok).toBe(false);
  });
});
