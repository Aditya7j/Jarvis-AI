/**
 * ACCEPTANCE-17 — the 17-query routing & answer contract, end to end.
 *
 * Every query runs through the REAL chat pipeline with a fake reasoning model
 * that would emit "never". If a tool-backed query answers directly, the fake
 * model must NOT be invoked, and the emitted answer must be exactly the
 * deterministic tool output. Reasoning queries (React, JS, closures, Atlantis)
 * must route to the reasoning model and never touch a tool. Search queries
 * must route to web_search (live verification), never the model.
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
import type { PlanClass } from "@/services/planner";

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

interface AcceptanceCase {
  q: string;
  cls: PlanClass;
  tool?: string;
  /** When set, the tool-backed answer must be EXACTLY this, with no model call. */
  tokens?: string;
}

const CASES: AcceptanceCase[] = [
  { q: "What date will be 27 August 2037?", cls: "date-calc", tool: "get_weekday_for_date", tokens: "August 27, 2037 is a Thursday." },
  { q: "What is the date on 27 August 2037?", cls: "date-calc", tool: "get_weekday_for_date", tokens: "August 27, 2037 is a Thursday." },
  { q: "What is today's date?", cls: "date", tool: "get_current_time" },
  { q: "What is React?", cls: "reasoning" },
  { q: "What is JS?", cls: "reasoning" },
  { q: "What is not JS?", cls: "reasoning" },
  { q: "What is JavaScript closure?", cls: "reasoning" },
  { q: "What is the square root of 144?", cls: "math", tool: "calculate", tokens: "sqrt(144) = 12" },
  { q: "Solve: (125 × 48) + 15", cls: "math", tool: "calculate", tokens: "(125 * 48) + 15 = 6015" },
  { q: "Who is the current Prime Minister of India?", cls: "search", tool: "web_search" },
  { q: "Who was the first Sikh Prime Minister of India?", cls: "search", tool: "web_search" },
  { q: "What is the capital of Japan?", cls: "search", tool: "web_search" },
  { q: "What is the capital of Atlantis?", cls: "reasoning" },
  { q: "What day is 15 August 2026?", cls: "date-calc", tool: "get_weekday_for_date", tokens: "August 15, 2026 is a Saturday." },
  { q: "React kya hai?", cls: "reasoning" },
  { q: "JavaScript closure kya hota hai?", cls: "reasoning" },
  { q: "144 ka square root kya hai?", cls: "math", tool: "calculate", tokens: "sqrt(144) = 12" },
  { q: "India ka pehla Sikh Prime Minister kaun tha?", cls: "search", tool: "web_search" },
];

describe("acceptance — 17-query routing & answer contract", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Live web_search cases make bounded concurrent Wikipedia discovery
  // (rank-qualified uses srlimit=10), which legitimately takes >5s — give the
  // live tool calls time to complete; the assertions are routing-only.
  it.each(CASES.map((c) => [c.q, c]))(
    "%s",
    async (q: string, c: AcceptanceCase) => {
      vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
      const events = await collect(c.q, fakeModel(["never"]));
      const plan = planOf(events);
      expect(plan?.intent, `intent for "${c.q}"`).toBe(c.cls);

      if (c.tokens !== undefined) {
        expect(tokensOf(events)).toBe(c.tokens);
        // Exactly one token: the deterministic answer. The model never ran.
        expect(events.filter((e) => e.kind === "token").length).toBe(1);
        expect(tokensOf(events)).not.toContain("never");
      }

      if (c.tool !== undefined) {
        const tool = toolOf(events);
        expect(tool?.tool).toBe(c.tool);
        expect(memoryStub.listEntries).not.toHaveBeenCalled();
        expect(memoryStub.createEntry).not.toHaveBeenCalled();
      }

      if (c.cls === "reasoning") {
        // The reasoning model answers; no tool must run.
        expect(tokensOf(events)).toBe("never");
        expect(toolOf(events)).toBeUndefined();
      }
    },
    20_000
  );

  it("answers the current-date query with the verified clock", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const events = await collect("What is today's date?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("date");
    expect(toolOf(events)?.tool).toBe("get_current_time");
    expect(tokensOf(events)).toBe(`Today is ${getSystemClock().date}.`);
  });

  it("routes live-data questions to web_search, never to the model directly", async () => {
    const events = await collect("Who is the current Prime Minister of India?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("search");
    expect(toolOf(events)?.tool).toBe("web_search");
  }, 20_000);
});
