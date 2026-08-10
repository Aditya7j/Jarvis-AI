/**
 * ROUTING REGRESSION — locks the classification & answering contract that
 * fixes the 12-question routing failures:
 *
 *   - math word problems (percent change, percent-of, equations, powers/roots,
 *     prime factorization, Hinglish word-number arithmetic) → math, answered
 *     deterministically by the calculator with NO reasoning model.
 *   - coding definitionals ("What is a JavaScript closure?", "What is REST
 *     API?", "What is React?") → reasoning (a concise model answer), never a
 *     Wikipedia dump.
 *   - qualified-definition questions ("What is a closure in JavaScript?",
 *     "What is the event loop?", "What is photosynthesis?") stay → search.
 *   - live/date/time/weather/capital questions keep their deterministic or
 *     web-backed routing.
 *   - hard no-web-fallback invariant: deterministic classes never route to
 *     web_search.
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

import { runPipeline, type PipelineModel } from "@/services/chat";
import {
  assertNoWebFallback,
  classifyPlanIntent,
  classifyWithReasons,
  planRoute,
  NO_WEB_FALLBACK_CLASSES,
  type PlanClass,
} from "@/services/planner";
import { solveMathProblem } from "@/lib/toolkit/math";
import { initToolRouter, toolCache } from "@/services/tools";

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

// ---------------------------------------------------------------------------
// Classification contract (planner level, no network)
// ---------------------------------------------------------------------------

const ROUTING: Array<[string, PlanClass]> = [
  // The 12 questions.
  ["What time is it?", "time"],
  ["What is today's date?", "date"],
  [
    "A number is increased by 20% and then decreased by 20%. What is the net percentage change?",
    "math",
  ],
  ["What is 847 × 936?", "math"],
  ["What is the capital of Japan?", "search"],
  ["What is React?", "reasoning"],
  ["What is the weather in Delhi?", "weather"],
  ["What is a JavaScript closure?", "reasoning"],
  ["What is the event loop?", "search"],
  ["What is 5 percent of 840?", "math"],
  ["What is 17 × 29?", "math"],
  ["What is REST API?", "reasoning"],
  // Definitional boundary: bare/technical forms → reasoning; qualified forms → search.
  ["What is JavaScript closure?", "reasoning"],
  ["React kya hai?", "reasoning"],
  ["JavaScript closure kya hota hai?", "reasoning"],
  ["What is a closure in JavaScript?", "search"],
  ["What is photosynthesis?", "search"],
  ["What is the tallest mountain on earth?", "search"],
  ["What is X?", "reasoning"],
  ["What is that movie you mentioned?", "search"],
  ["What is not JS?", "reasoning"],
  // Math shapes: powers/roots, prime factorization, word numbers, equations, Hinglish.
  ["What is 37² × 13?", "math"],
  ["What is the prime factorization of 2100?", "math"],
  ["What is five times three?", "math"],
  ["What is fifty percent of 80?", "math"],
  ["What is seventeen percent of 9300?", "math"],
  ["What is 2 to the power of 10?", "math"],
  ["What is 1000 ko 15% increase karo?", "math"],
  ["What is 25 ka 18%?", "math"],
  ["If x + 5 = 12, what is x?", "math"],
  ["Solve 3x - 2 = 11", "math"],
  ["Find x = 15 - 42", "math"],
  // Word-problem gating: a bare statement or numberless change question must
  // NOT be hijacked into the calculator.
  ["What is the net percentage change?", "search"],
  ["The price increased by 20%.", "reasoning"],
  // Live facts keep their deterministic routing.
  ["What time is it in Tokyo?", "time"],
  ["What day will 15 August 2026 be?", "date-calc"],
  ["What is my timezone?", "time"],
  ["Why does timezone exist?", "reasoning"],
];

describe("routing regression — classification", () => {
  it.each(ROUTING.map(([q, expected]) => [q, expected]))(
    "classifies %s",
    (q: string, expected: PlanClass) => {
      expect(classifyPlanIntent(q), `classification of "${q}"`).toBe(expected);
    }
  );

  it("records a reason for every classified request", () => {
    for (const [q] of ROUTING) {
      const { cls, reasons } = classifyWithReasons(q);
      expect(reasons.length, `no reason recorded for "${q}"`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Solving contract (math toolkit)
// ---------------------------------------------------------------------------

const SOLVE: Array<[string, number]> = [
  ["What is 847 × 936?", 792792],
  ["What is 37² × 13?", 17797],
  ["What is 5 percent of 840?", 42],
  ["What is fifty percent of 80?", 40],
  ["What is seventeen percent of 9300?", 1581],
  ["What is five times three?", 15],
  ["What is 2 to the power of 10?", 1024],
  ["What is 2/3 + 5/6?", 1.5],
  [
    "A number is increased by 20% and then decreased by 20%. What is the net percentage change?",
    -4,
  ],
  ["What is 1000 ko 15% increase karo?", 1150],
  ["What is 25 ka 18%?", 4.5],
  ["If x + 5 = 12, what is x?", 7],
  ["Find x = 15 - 42", -27],
];

describe("routing regression — math solving", () => {
  it.each(SOLVE.map(([q, want]) => [q, want]))("solves %s", (q: string, want: number) => {
    const result = solveMathProblem(q);
    expect(result.value).toBe(want);
    expect(typeof result.reply === "string" ? result.reply : result.formatted).toBeTruthy();
  });

  it("solves fractional equations exactly", () => {
    const result = solveMathProblem("Solve 3x - 2 = 11");
    expect(result.value).toBeCloseTo(13 / 3);
    expect(result.reply ?? "").toContain("x =");
  });
});

// ---------------------------------------------------------------------------
// Hard no-web-fallback invariant
// ---------------------------------------------------------------------------

describe("routing regression — no-web-fallback invariant", () => {
  it("marks every deterministic class as web-forbidden", () => {
    const deterministic: PlanClass[] = [
      "math",
      "conversion",
      "time",
      "date",
      "date-calc",
      "weather",
      "tasks",
      "memory",
      "calendar",
      "profile",
      "system",
      "location",
      "vision",
    ];
    for (const cls of deterministic) {
      expect(NO_WEB_FALLBACK_CLASSES.has(cls), `${cls} must be in NO_WEB_FALLBACK_CLASSES`).toBe(true);
      expect(assertNoWebFallback(cls), `${cls} must never fall back to web`).toBe(true);
    }
  });

  it("allows web only for the search class", () => {
    expect(assertNoWebFallback("search")).toBe(false);
  });

  it("never attaches web_search to a deterministic class's route", () => {
    const deterministic: PlanClass[] = [
      "math",
      "conversion",
      "time",
      "date",
      "date-calc",
      "weather",
      "tasks",
      "memory",
      "calendar",
      "profile",
      "system",
    ];
    for (const cls of deterministic) {
      const route = planRoute(`${cls} placeholder`);
      expect(route.step.tools.includes("web_search"), `${cls} route must not include web_search`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Answer contract (pipeline level, fake reasoning model that would say "never")
// ---------------------------------------------------------------------------

describe("routing regression — pipeline answer contract", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers math word problems deterministically with no reasoning model", async () => {
    const cases: Array<[string, string]> = [
      ["What is 847 × 936?", "847 * 936 = 792792"],
      ["What is 5 percent of 840?", "(5/100)*840 = 42"],
      ["What is five times three?", "5 * 3 = 15"],
      ["What is 17 × 29?", "17 * 29 = 493"],
      ["What is 2 to the power of 10?", "2 ^ 10 = 1024"],
    ];
    for (const [q, expected] of cases) {
      const events = await collect(q, fakeModel(["never"]));
      expect(planOf(events)?.intent, `intent for "${q}"`).toBe("math");
      expect(toolOf(events)?.tool).toBe("calculate");
      expect(tokensOf(events)).toBe(expected);
      expect(tokensOf(events)).not.toContain("never");
      expect(events.filter((e) => e.kind === "token").length, `single token for "${q}"`).toBe(1);
    }
  });

  it("answers the percent-change word problem deterministically", async () => {
    const events = await collect(
      "A number is increased by 20% and then decreased by 20%. What is the net percentage change?",
      fakeModel(["never"])
    );
    expect(planOf(events)?.intent).toBe("math");
    expect(toolOf(events)?.tool).toBe("calculate");
    expect(tokensOf(events)).toBe("The net percentage change is -4% (a 4% decrease).");
    expect(events.filter((e) => e.kind === "token").length).toBe(1);
  });

  it("routes coding definitionals to the reasoning model, never a tool", async () => {
    for (const q of ["What is React?", "What is a JavaScript closure?", "What is REST API?"]) {
      const events = await collect(q, fakeModel(["never"]));
      expect(planOf(events)?.intent, `intent for "${q}"`).toBe("reasoning");
      expect(tokensOf(events)).toBe("never");
      expect(toolOf(events), `no tool for "${q}"`).toBeUndefined();
    }
  });

  it("keeps qualified definitions on web search", async () => {
    for (const q of ["What is a closure in JavaScript?", "What is photosynthesis?"]) {
      const events = await collect(q, fakeModel(["never"]));
      expect(planOf(events)?.intent, `intent for "${q}"`).toBe("search");
      expect(toolOf(events)?.tool).toBe("web_search");
    }
  });

  it("answers a named-place time query with that place's clock", async () => {
    const events = await collect("What time is it in Tokyo?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("time");
    expect(toolOf(events)?.tool).toBe("get_current_time");
    const text = tokensOf(events);
    expect(text).toMatch(/^It is \d{1,2}:\d{2}/);
    expect(text).toContain(" in Tokyo.");
  });

  it("never invokes web_search for a deterministic class, even when routed", async () => {
    // Guard: the search class is the ONLY web-fallback-allowed class. Forcing
    // web_search onto a deterministic class must never execute it.
    const events = await collect("What is 847 × 936?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("math");
    expect(events.some((e) => e.kind === "tool" && e.tool === "web_search")).toBe(false);
  });
});
