/**
 * Knowledge-answer integrity suite.
 *
 * 1. Title-only invariant: a search result that contains ONLY a heading can
 *    never become the final answer. When DuckDuckGo returns a heading plus
 *    real topic text, the answer is the topic content. When it returns only a
 *    heading, the tool fails honestly instead of echoing it.
 * 2. Date runtime proof: the "current date" answer matches the REAL system
 *    clock (no fake timers) — the reported wrong year came from the machine
 *    clock, not the code.
 * 3. Hinglish knowledge questions route to the reasoning model (no tool) and
 *    the model answers — by design, no change needed.
 *
 * Runs the real Tool Router + real pipeline against fake models and a mocked
 * `fetch` for the search cases.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

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

import { getSystemClock } from "@/lib/ai/system-tools";
import { initToolRouter, toolCache } from "@/services/tools";
import { runPipeline, type PipelineModel } from "@/services/chat";

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

/** Mock DuckDuckGo + a Wikipedia fallback that finds nothing. */
function mockSearchSources(ddgPayload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.duckduckgo.com")) {
        return { ok: true, json: async () => ddgPayload } as Response;
      }
      if (url.includes("list=search") && !url.includes("opensearch")) {
        return { ok: true, json: async () => ({ query: { search: [] } }) } as Response;
      }
      if (url.includes("action=opensearch")) {
        return { ok: true, json: async () => ["q", []] } as Response;
      }
      if (url.includes("prop=extracts")) {
        return { ok: true, json: async () => ({ query: { pages: [{ extract: null }] } }) } as Response;
      }
      throw new Error(`unmocked url: ${url}`);
    })
  );
}

describe("knowledge answer integrity", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a search answer is the real topic content, never the bare heading", async () => {
    mockSearchSources({
      Heading: "Event loop",
      AbstractText: "",
      Answer: "",
      RelatedTopics: [
        {
          Text: "Event loop (JavaScript) — The mechanism that handles asynchronous operations in JavaScript.",
          FirstURL: "https://duckduckgo.com/?q=event-loop",
        },
      ],
    });
    const events = await collect("What is the event loop?", fakeModel(["never"]));
    const text = tokensOf(events);
    expect(planOf(events)?.intent).toBe("search");
    expect(toolOf(events)?.tool).toBe("web_search");
    expect(toolOf(events)?.ok).toBe(true);
    expect(text).not.toBe("Event loop");
    expect(text).toContain("asynchronous operations");
  });

  it("a search result that is ONLY a heading can never become the answer — the tool fails honestly", async () => {
    mockSearchSources({ Heading: "Closure", AbstractText: "", Answer: "", RelatedTopics: [] });
    const events = await collect("What is a closure in JavaScript?", fakeModel(["never"]));
    const text = tokensOf(events);
    expect(planOf(events)?.intent).toBe("search");
    expect(toolOf(events)?.tool).toBe("web_search");
    expect(toolOf(events)?.ok).toBe(false);
    expect(text).not.toContain("Closure");
  });

  it("the date answer matches the REAL system clock (live runtime proof, no fake timers)", async () => {
    const events = await collect("What is today's date?", fakeModel(["never"]));
    const text = tokensOf(events);
    const clock = getSystemClock();
    expect(text).toBe(`Today is ${clock.date}.`);
    expect(clock.date).toContain(String(new Date().getFullYear()));
    expect(planOf(events)?.intent).toBe("date");
    expect(toolOf(events)?.tool).toBe("get_current_time");
  });

  it("Hinglish knowledge questions route to the reasoning model (no tool) and it answers", async () => {
    const events = await collect("React kya hai?", fakeModel(["React ek JavaScript UI library hai."]));
    const text = tokensOf(events);
    expect(planOf(events)?.intent).toBe("reasoning");
    expect(events.filter((e) => e.kind === "tool").length).toBe(0);
    expect(text).toBe("React ek JavaScript UI library hai.");
  });
});
