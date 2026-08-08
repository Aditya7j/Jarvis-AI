/**
 * Deterministic date routing integration suite.
 *
 * Locks the acceptance contract of the date-hallucination fix: a question
 * about the weekday of a SPECIFIC date ("What day is 15 Aug 2026?") must be
 * answered by the get_weekday_for_date tool, formatted DIRECTLY (no LLM), with
 * the correct deterministic weekday. Conversation history can never change the
 * answer, and a user correction never triggers an LLM guess.
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
import { assertDateInvariant } from "@/services/chat/pipeline";

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

describe("deterministic date routing", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the weekday of 15 Aug 2026 directly from the date tool", async () => {
    const events = await collect("What day is 15 Aug 2026?", fakeModel(["never"]));
    expect(tokensOf(events)).toBe("August 15, 2026 is a Saturday.");
    expect(planOf(events)?.intent).toBe("date-calc");
    const tool = toolOf(events);
    expect(tool?.tool).toBe("get_weekday_for_date");
    expect(tool?.ok).toBe(true);
    // Exactly one token: the direct answer. The model was never invoked.
    expect(events.filter((e) => e.kind === "token").length).toBe(1);
    expect(memoryStub.listEntries).not.toHaveBeenCalled();
    expect(memoryStub.createEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["What weekday is August 15 2026?", "August 15, 2026 is a Saturday."],
    ["What day will it be on 15 August 2026?", "August 15, 2026 is a Saturday."],
    ["What day is 15/08/2026?", "August 15, 2026 is a Saturday."],
    ["What day of the week is 15 Aug 2026?", "August 15, 2026 is a Saturday."],
    ["What day is 1 January 2025?", "January 1, 2025 is a Wednesday."],
    ["What day is 29 February 2024?", "February 29, 2024 is a Thursday."],
  ])("answers %s as %s", async (prompt, expected) => {
    const events = await collect(prompt, fakeModel(["never"]));
    expect(tokensOf(events)).toBe(expected);
    expect(planOf(events)?.intent).toBe("date-calc");
    expect(toolOf(events)?.tool).toBe("get_weekday_for_date");
  });

  it("is deterministic across repeated calls and empty history", async () => {
    const first = tokensOf(await collect("What day is 15 Aug 2026?", fakeModel(["never"])));
    const second = tokensOf(await collect("What day is 15 Aug 2026?", fakeModel(["never"])));
    expect(first).toBe("August 15, 2026 is a Saturday.");
    expect(second).toBe(first);
  });

  it("routes a Hinglish date question to the deterministic tool", async () => {
    const events = await collect("15 August 2026 kaun sa din hai?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("date-calc");
    expect(toolOf(events)?.tool).toBe("get_weekday_for_date");
    expect(tokensOf(events)).toContain("Saturday");
  });

  it("routes a Hindi date question to the deterministic tool with a Hindi answer", async () => {
    const events = await collect("15 अगस्त 2026 कौन सा दिन है?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("date-calc");
    expect(toolOf(events)?.tool).toBe("get_weekday_for_date");
    expect(tokensOf(events)).toContain("शनिवार");
    expect(tokensOf(events)).not.toContain("Wednesday");
  });

  it("keeps 'what is today's date?' on the system clock path (current date only)", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const events = await collect("what is today's date?", fakeModel(["never"]));
    expect(tokensOf(events)).toBe(`Today is ${getSystemClock().date}.`);
    expect(planOf(events)?.intent).toBe("date");
    expect(toolOf(events)?.tool).toBe("get_current_time");
  });

  it("routes 'what date is today' to the verified clock tool, not the LLM", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const events = await collect("What date is today", fakeModel(["never"]));
    expect(tokensOf(events)).toBe(`Today is ${getSystemClock().date}.`);
    expect(planOf(events)?.intent).toBe("date");
    expect(toolOf(events)?.tool).toBe("get_current_time");
  });

  it("routes 'what is the date today' to the verified clock tool", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const events = await collect("What is the date today?", fakeModel(["never"]));
    expect(planOf(events)?.intent).toBe("date");
    expect(toolOf(events)?.tool).toBe("get_current_time");
  });

  it("grounds the LLM system context with a plain-language verified 'Today is ...' date", async () => {
    const captured: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const capturingModel: PipelineModel = {
      streamText: async function* (input: { messages: Array<{ role: string; content: string }> }) {
        captured.push(input);
        yield "ok";
      },
    };
    const events: TestEvent[] = [];
    for await (const event of runPipeline("What do you think about the future of AI?", [], capturingModel)) {
      events.push(event as TestEvent);
    }
    const systemText = captured[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemText).toMatch(/Today is .+? \(verified\)\./);
    expect(systemText).toMatch(/\d{4}/);
    expect(systemText).toContain("ONLY source of truth for the current date");
  });

  it("answers days-until with a deterministic count from the date tool", async () => {
    const events = await collect("How many days until 15 Aug 2026?", fakeModel(["never"]));
    expect(tokensOf(events)).toMatch(/^There are \d+ days until August 15, 2026\.$/);
    expect(planOf(events)?.intent).toBe("date-calc");
    expect(toolOf(events)?.tool).toBe("get_weekday_for_date");
  });

  it("never lets a user correction trigger an LLM weekday guess", async () => {
    const events = await collect("No, check again.", fakeModel(["would be a Wednesday"]));
    const text = tokensOf(events);
    expect(text).not.toContain("Wednesday");
    expect(text).not.toMatch(/2026/);
    expect(planOf(events)?.intent).not.toBe("date-calc");
    expect(events.filter((e) => e.kind === "token").length).toBe(1);
  });

  it("answers a date correction with the canned reply when no date exists in context", async () => {
    const events = await collect("No, check again.", fakeModel(["would be a Wednesday"]));
    expect(tokensOf(events)).toContain("I don't see a date to re-check");
    expect(toolOf(events)?.fallbackReason).toBe("date_correction_no_date");
    expect(toolOf(events)?.tool).toBe("none");
    const src = events.find((e) => e.kind === "source");
    expect(src?.source).toBe("reasoning");
  });

  it("never invokes the reasoning model for a date correction (model stays untouched)", async () => {
    const model = fakeModel(["would be a Wednesday"]);
    const history = [
      { role: "user" as const, content: "What day is 15 Aug 2026?" },
      { role: "assistant" as const, content: "August 15, 2026 is a Saturday." },
      { role: "user" as const, content: "No, check again." },
    ];
    const spy = vi.spyOn(model, "streamText");
    const events: TestEvent[] = [];
    for await (const event of runPipeline("No, check again.", history, model)) {
      events.push(event as TestEvent);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(tokensOf(events)).toBe("August 15, 2026 is a Saturday.");
  });

  it("re-runs the deterministic date tool when the user challenges a date answer", async () => {
    const history = [
      { role: "user" as const, content: "What day is 15 Aug 2026?" },
      { role: "assistant" as const, content: "August 15, 2026 is a Saturday." },
      { role: "user" as const, content: "No, check again." },
    ];
    const events: TestEvent[] = [];
    for await (const event of runPipeline(
      "No, check again.",
      history,
      fakeModel(["would be a Wednesday"])
    )) {
      events.push(event as TestEvent);
    }
    // The correction re-runs the tool and gets the SAME deterministic answer.
    expect(tokensOf(events)).toBe("August 15, 2026 is a Saturday.");
    expect(toolOf(events)?.tool).toBe("get_weekday_for_date");
    expect(toolOf(events)?.ok).toBe(true);
    expect(events.filter((e) => e.kind === "token").length).toBe(1);
  });
});

describe("assertDateInvariant (safety guard)", () => {
  const weekdayFact = {
    kind: "weekday",
    date: "2026-08-15",
    weekday: "Saturday",
    display: "August 15, 2026",
    localMs: 1776297600000,
  };

  it("returns null when the emitted English answer contains the computed weekday", () => {
    const text = "August 15, 2026 is a Saturday.";
    expect(assertDateInvariant("date-calc", weekdayFact, text, "english")).toBeNull();
  });

  it("returns null for a Hindi answer containing the Devanagari weekday", () => {
    const text = "15 अगस्त 2026 शनिवार का दिन है।";
    expect(assertDateInvariant("date-calc", weekdayFact, text, "hindi")).toBeNull();
  });

  it("returns null when the Hindi answer falls back to the English weekday", () => {
    const text = "15 अगस्त 2026 Saturday का दिन है।";
    expect(assertDateInvariant("date-calc", weekdayFact, text, "hindi")).toBeNull();
  });

  it("flags a violation when the weekday is missing from the emitted answer", () => {
    const violation = assertDateInvariant(
      "date-calc",
      weekdayFact,
      "August 15, 2026 is some day.",
      "english"
    );
    expect(violation).toEqual({ expected: "Saturday", actual: "August 15, 2026 is some day." });
  });

  it("flags a violation when the emitted answer contains the WRONG weekday", () => {
    const violation = assertDateInvariant(
      "date-calc",
      weekdayFact,
      "August 15, 2026 is a Wednesday.",
      "english"
    );
    expect(violation).toEqual({ expected: "Saturday", actual: "August 15, 2026 is a Wednesday." });
  });

  it("never flags day-count answers (no weekday to compare against)", () => {
    const daysFact = {
      kind: "days-until",
      date: "2026-08-15",
      weekday: "Saturday",
      display: "August 15, 2026",
      localMs: 1776297600000,
      days: 9,
    };
    const text = "There are 9 days until August 15, 2026.";
    expect(assertDateInvariant("date-calc", daysFact, text, "english")).toBeNull();
    const wrongText = "There are 999 days until August 15, 2026.";
    expect(assertDateInvariant("date-calc", daysFact, wrongText, "english")).toBeNull();
  });

  it("never flags answers for non-date classes", () => {
    expect(assertDateInvariant("math", weekdayFact, "anything", "english")).toBeNull();
  });

  it("returns null when the fact carries no weekday field", () => {
    const bare = { kind: "weekday", date: "2026-08-15", display: "August 15, 2026", localMs: 1 };
    expect(assertDateInvariant("date-calc", bare, "some answer", "english")).toBeNull();
  });
});
