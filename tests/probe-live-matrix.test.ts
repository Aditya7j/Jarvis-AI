/**
 * LIVE MATRIX PROBE — 21 self-chosen questions across every knowledge shape
 * plus the 4 user regression strings, run through the REAL chat pipeline with
 * a fake reasoning model that would emit "never". Real network (live Wikipedia
 * discovery). The probe logs [PROBE] intent/classify/output for every case and
 * asserts the routing + tool wiring; output is the live evidence.
 *
 * TEMPORARY — run on request, then delete.
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
import { classifyKnowledgeQuery } from "@/lib/toolkit/web";

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

function compactClassify(q: string): string {
  try {
    const c = classifyKnowledgeQuery(q);
    if (!c) return "generic";
    const { kind, ...rest } = c as unknown as Record<string, unknown>;
    const key = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${JSON.stringify(rest[k])}`)
      .join(" ");
    return `${String(kind)}${key ? ` ${key}` : ""}`;
  } catch {
    return "classify-error";
  }
}

interface ProbeCase {
  q: string;
  category: string;
}

const CASES: ProbeCase[] = [
  // officeholder — full / Hinglish / abbreviated
  { q: "Who is the current PM of Canada?", category: "officeholder" },
  { q: "Who is the current pradhan mantri of Australia?", category: "officeholder" },
  { q: "Who is the current CM of Maharashtra?", category: "officeholder" },
  { q: "Bharat ka pradhan mantri kaun hai?", category: "officeholder" },
  { q: "America ka rashtrapati kaun hai?", category: "officeholder" },
  // rank-qualified — English + Hinglish, various offices/places
  { q: "Who was the first PM of Australia?", category: "rank-qualified" },
  { q: "Who was the first PM of India?", category: "rank-qualified" },
  { q: "Who was the last PM of the United Kingdom?", category: "rank-qualified" },
  { q: "Who was the first female PM of India?", category: "rank-qualified" },
  { q: "Who was the first Sikh VP of India?", category: "rank-qualified" },
  { q: "Who was the first President of the USA?", category: "rank-qualified" },
  { q: "Who was the first Vice President of the United States?", category: "rank-qualified" },
  { q: "Japan ka pehla pradhan mantri kaun tha?", category: "rank-qualified" },
  // capital
  { q: "Australia ki rajdhani kya hai?", category: "capital" },
  { q: "Bharat ki rajdhani kya hai?", category: "capital" },
  // generic knowledge
  { q: "What is a telephone?", category: "generic" },
  { q: "What is the tallest mountain on earth?", category: "generic" },
  // math
  { q: "What is the square root of 625?", category: "math" },
  { q: "144 ka square root kya hai?", category: "math" },
  // time / date
  { q: "What time is it?", category: "time" },
  { q: "What day is 25 December 2037?", category: "date-calc" },
  // user's four regression strings (fail-before / pass-after)
  { q: "Who was the first Sikh PM of India?", category: "regression" },
  { q: "Who was the first Sikh Prime Minister of India?", category: "regression" },
  { q: "Who was the first Sikh CM of Punjab?", category: "regression" },
  { q: "India ka pehla Sikh PM kaun tha?", category: "regression" },
];

describe("LIVE MATRIX PROBE", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(CASES.map((c) => [c.q, c]))(
    "%s",
    async (q: string, c: ProbeCase) => {
      vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
      const events = await collect(c.q, fakeModel(["never"]));
      const plan = events.find((e) => e.kind === "plan");
      const tool = events.find((e) => e.kind === "tool");
      const modelTouched = tokensOf(events).includes("never");

      const toolName = (tool?.tool as string) ?? "(none)";
      const output = tokensOf(events) || "(no output)";

      console.log(`[PROBE] ${c.category}`);
      console.log(`  intent: ${plan?.intent ?? "?"} | tool: ${toolName} | modelTouched: ${modelTouched}`);
      if (plan?.intent === "search" && toolName === "web_search") {
        const raw = (tool?.input as { query?: string })?.query ?? q;
        console.log(`  classify: ${compactClassify(String(raw))}`);
      }
      console.log(`  output: ${output}`);

      expect(plan).toBeDefined();
      expect(plan?.intent).not.toBe("vision");
      if (c.category === "math") expect(tool?.tool).toBe("calculate");
      if (c.category === "time") expect(tool?.tool).toBe("get_current_time");
      if (c.category === "date-calc") expect(tool?.tool).toBe("get_weekday_for_date");
      if (plan?.intent === "reasoning") expect(modelTouched).toBe(true);
      expect(memoryStub.listEntries).not.toHaveBeenCalled();
      expect(memoryStub.createEntry).not.toHaveBeenCalled();
    },
    25_000
  );

  it("answers the current-date query with the verified clock", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const events = await collect("What is today's date?", fakeModel(["never"]));
    expect(events.find((e) => e.kind === "plan")?.intent).toBe("date");
    expect(tokensOf(events)).toBe(`Today is ${getSystemClock().date}.`);
  });
});
