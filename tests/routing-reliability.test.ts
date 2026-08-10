/**
 * Routing & handling reliability suite — the 8-question acceptance set, end
 * to end through the REAL pipeline (offline: fake models, mocked web_search).
 *
 * Locks the fixes:
 *   1. "What is not X?" reasons — the web returns unrelated pages for it.
 *   2. A rank-qualified office question ("who is the FIRST x of y?") never
 *      answers with the current incumbent: when the web has no usable answer
 *      the pipeline defers to the reasoning model instead of a canned refusal.
 *   3. Genuine search AVAILABILITY failures (network down) still refuse — the
 *      model is never asked to guess when the web simply could not be reached.
 *   4. "What is React?" reasons from training — it never hits the web and
 *      never returns a bullet list.
 *   5. Math answers survive polite framing ("I ask you what is the square
 *      root of 16").
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
import { runPipeline, runPipelineText, type PipelineModel } from "@/services/chat";

const REACT_TOPIC = {
  query: "What is React?",
  heading: "React",
  abstract: null,
  answer: null,
  source: null,
  url: null,
  topics: [
    {
      text: "React (software) — A free and open-source front-end JavaScript library for building user interfaces.",
      url: "https://duckduckgo.com/?q=react",
    },
    {
      text: "React (JavaScript library) is used for building component-based UIs.",
      url: "https://duckduckgo.com/?q=react2",
    },
  ],
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

function sourceOf(events: TestEvent[]): string | undefined {
  const source = events.find((e) => e.kind === "source");
  return source?.source as string | undefined;
}

describe("the 8-question acceptance set (offline pipeline)", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("What is React? → reasoning, single clean answer, no tools, no web", async () => {
    const model = fakeModel(["React is a free and open-source front-end JavaScript library for building user interfaces."]);
    const spy = vi.spyOn(model, "streamText");
    const events = await collect("What is React?", model);
    const text = tokensOf(events);
    expect(planOf(events)?.intent).toBe("reasoning");
    expect(events.filter((e) => e.kind === "tool").length).toBe(0);
    expect(text).toContain("JavaScript library");
    expect(text).not.toContain("- ");
    expect(webSearch).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("What is not just? → reasoning (the web surfaces unrelated pages)", async () => {
    const model = fakeModel(["That phrase is a request for a definition by negation — here is the reasoning answer."]);
    const events = await collect("What is not just?", model);
    expect(planOf(events)?.intent).toBe("reasoning");
    expect(events.filter((e) => e.kind === "tool").length).toBe(0);
    expect(tokensOf(events)).toContain("reasoning answer");
    expect(webSearch).not.toHaveBeenCalled();
  });

  it("What is not JS? → reasoning, never web", async () => {
    const model = fakeModel(["The reasoning answer for what is not JS."]);
    const events = await collect("What is not JS?", model);
    expect(planOf(events)?.intent).toBe("reasoning");
    expect(events.filter((e) => e.kind === "tool").length).toBe(0);
    expect(tokensOf(events)).toContain("reasoning answer");
    expect(webSearch).not.toHaveBeenCalled();
  });

  it("first Sikh PM: search yields nothing usable → defers to reasoning, never the current incumbent", async () => {
    // A null search result is an unverifiable content failure (VERIFICATION_FAILED).
    (webSearch as Mock).mockResolvedValue(null);
    const model = fakeModel(["Manmohan Singh was the first Sikh Prime Minister of India, serving 2004-2014."]);
    const spy = vi.spyOn(model, "streamText");
    const events = await collect("Who is the first Sikh Prime Minister of India?", model);
    expect(planOf(events)?.intent).toBe("search");
    const tool = toolOf(events);
    expect(tool?.tool).toBe("web_search");
    expect(tool?.ok).toBe(false);
    expect(sourceOf(events)).toBe("reasoning");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(tokensOf(events)).toContain("Manmohan Singh was the first Sikh Prime Minister");
  });

  it("Is the first Sikh PM of India? → reasoning, no tools", async () => {
    const model = fakeModel(["Yes — Manmohan Singh was the first Sikh Prime Minister of India."]);
    const events = await collect("Is the first Sikh Prime Minister of India?", model);
    expect(planOf(events)?.intent).toBe("reasoning");
    expect(events.filter((e) => e.kind === "tool").length).toBe(0);
    expect(tokensOf(events)).toContain("Manmohan Singh");
  });

  it("What is the square root of 16? → math, verified 4, no LLM", async () => {
    const model = fakeModel(["never"]);
    const spy = vi.spyOn(model, "streamText");
    const events = await collect("What is the square root of 16?", model);
    expect(planOf(events)?.intent).toBe("math");
    expect(sourceOf(events)).toBe("tool");
    expect(tokensOf(events)).toContain("4");
    expect(spy).not.toHaveBeenCalled();
  });

  it("I ask you what is the square root of 16 → math survives polite framing", async () => {
    const model = fakeModel(["never"]);
    const spy = vi.spyOn(model, "streamText");
    const events = await collect("I ask you what is the square root of 16", model);
    expect(planOf(events)?.intent).toBe("math");
    expect(sourceOf(events)).toBe("tool");
    expect(tokensOf(events)).toContain("4");
    expect(spy).not.toHaveBeenCalled();
  });

  it("Write the table of 19 → reasoning", async () => {
    const model = fakeModel(["The 19 times table: 19, 38, 57, 76, 95, ..."]);
    const events = await collect("Write the table of 19", model);
    expect(planOf(events)?.intent).toBe("reasoning");
    expect(events.filter((e) => e.kind === "tool").length).toBe(0);
    expect(tokensOf(events)).toContain("19 times table");
  });

  it("search AVAILABILITY failure still refuses — the model is never asked to guess", async () => {
    (webSearch as Mock).mockRejectedValue(new Error("network down"));
    const model = fakeModel(["Manmohan Singh won in 2022"]);
    const spy = vi.spyOn(model, "streamText");
    const events = await collect("Who is the first Sikh Prime Minister of India?", model);
    expect(planOf(events)?.intent).toBe("search");
    const tool = toolOf(events);
    expect(tool?.tool).toBe("web_search");
    expect(tool?.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(tokensOf(events)).not.toContain("Singh");
  });
});

describe("runPipelineText convenience wrapper", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
  });

  it("reports intent, source and text for the polite-math case", async () => {
    const result = await runPipelineText(
      "I ask you what is the square root of 16",
      [{ role: "user", content: "I ask you what is the square root of 16" }],
      fakeModel(["never"])
    );
    expect(result.intent).toBe("math");
    expect(result.source).toBe("tool");
    expect(result.text).toContain("4");
  });
});
