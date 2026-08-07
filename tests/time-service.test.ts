/**
 * TimeService — single-source-of-truth regression suite.
 *
 * Locks the contract that EVERY date/time/greeting/timezone consumer reads the
 * SAME clock: dashboard widget + header greeting, chat tool + LLM context,
 * calendar "today" and the detected timezone. If any consumer drifts to its own
 * clock, these tests fail.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const memoryStub = vi.hoisted(() => {
  const entries = [
    {
      id: "m1",
      category: "preferences",
      content: "The owner likes black coffee",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  return {
    listEntries: vi.fn(async () => entries),
    createEntry: vi.fn(async (input: { content: string }) => ({
      id: "m-new",
      status: "pending",
      content: input.content,
      updatedAt: new Date().toISOString(),
    })),
  };
});

vi.mock("@/lib/memory", () => ({
  memoryService: memoryStub,
  MemoryService: class {},
  JsonFileMemoryRepository: class {},
  buildOwnerContext: () => "",
  appendMemoryContext: (s: string) => s,
}));

import {
  executeTool,
  initToolRouter,
  toolCache,
} from "@/services/tools";
import { runPipeline, type PipelineModel } from "@/services/chat";
import {
  formatClockDate,
  formatClockTime,
  getDayEnd,
  getDayStart,
  getGreeting,
  getSystemClock,
  getTimezone,
} from "@/lib/time/time-service";

function local(day: number, hour: number, minute = 0, second = 0): Date {
  return new Date(2026, 7, day, hour, minute, second);
}

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
      for (const token of tokens) yield token;
    },
  };
}

function recordingModel(
  tokens: string[],
  onMessages?: (messages: unknown[]) => void
): PipelineModel {
  return {
    streamText: async function* ({ messages }) {
      onMessages?.(messages);
      for (const token of tokens) yield token;
    },
  };
}

async function collect(
  prompt: string,
  model: PipelineModel,
  options: Parameters<typeof runPipeline>[3] = {}
) {
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  for await (const event of runPipeline(prompt, [{ role: "user", content: prompt }], model, options)) {
    events.push(event as { kind: string; [key: string]: unknown });
  }
  return events;
}

function tokensOf(
  events: Array<{ kind: string; [key: string]: unknown }>
): string {
  return events
    .filter((e) => e.kind === "token")
    .map((e) => e.text as string)
    .join("");
}

describe("TimeService — single source of truth", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports the exact instant for a fixed date", () => {
    const clock = getSystemClock(new Date("2026-08-06T12:34:56.000Z"));
    expect(clock.iso).toBe("2026-08-06T12:34:56.000Z");
    expect(clock.unixMs).toBe(new Date("2026-08-06T12:34:56.000Z").getTime());
    expect(clock.timezone).toBe(getTimezone());
    expect(clock.timezone.length).toBeGreaterThan(0);
  });

  it("greets by local hour: 05:00 morning, 13:00 afternoon, 19:00 evening, 23:00 night", () => {
    expect(getGreeting(local(6, 5))).toBe("Good morning");
    expect(getGreeting(local(6, 13))).toBe("Good afternoon");
    expect(getGreeting(local(6, 19))).toBe("Good evening");
    expect(getGreeting(local(6, 23))).toBe("Good night");
    expect(getSystemClock(local(6, 5)).greeting).toBe("Good morning");
    expect(getSystemClock(local(6, 13)).greeting).toBe("Good afternoon");
    expect(getSystemClock(local(6, 19)).greeting).toBe("Good evening");
    expect(getSystemClock(local(6, 23)).greeting).toBe("Good night");
  });

  it("timezone is detected exactly once and reused", async () => {
    vi.resetModules();
    const mod = await import("@/lib/time/time-service");
    const spy = vi.spyOn(
      Intl.DateTimeFormat.prototype,
      "resolvedOptions"
    );
    mod.getTimezone();
    mod.getTimezone();
    mod.getSystemClock();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("dashboard clock equals the chat time/date tool at the same instant", async () => {
    vi.setSystemTime(local(6, 13, 4, 5));
    const clock = getSystemClock();
    const tool = await executeTool("get_current_time");
    expect(tool.ok).toBe(true);
    if (!tool.ok) return;
    const fact = tool.data as {
      iso: string;
      unixMs: number;
      time: string;
      date: string;
      timezone: string;
      greeting: string;
    };

    expect(fact.iso).toBe(clock.iso);
    expect(fact.unixMs).toBe(clock.unixMs);
    expect(fact.time).toBe(clock.time);
    expect(fact.date).toBe(clock.date);
    expect(fact.timezone).toBe(clock.timezone);
    expect(fact.greeting).toBe(clock.greeting);

    const dashboardTime = formatClockTime(new Date(clock.unixMs));
    const dashboardDate = formatClockDate(new Date(clock.unixMs));
    expect(dashboardTime).toBe("01:04 PM");
    expect(dashboardDate).toBe("Thursday, August 6");
    expect(fact.time.startsWith("1:04 PM")).toBe(true);
    expect(fact.date).toContain(dashboardDate);
  });

  it("date tool answer carries the same date the dashboard shows", async () => {
    vi.setSystemTime(local(6, 13, 4, 5));
    const events = await collect("what's today's date", fakeModel(["never"]));
    const expected = getSystemClock();
    expect(tokensOf(events)).toBe(`Today is ${expected.date}.`);
    expect(formatClockDate(new Date(expected.unixMs))).toBe(
      "Thursday, August 6"
    );
    expect(expected.date).toContain(formatClockDate(new Date(expected.unixMs)));
  });

  it("date phrasings that fall through to the LLM still receive the verified clock", async () => {
    vi.setSystemTime(local(6, 13, 4, 5));
    let captured: unknown[] = [];
    const model = recordingModel(["ok"], (messages) => {
      captured = messages;
    });
    const events = await collect("what is today date", model);
    const plan = events.find((e) => e.kind === "plan") as
      | { intent: string }
      | undefined;
    expect(plan?.intent).toBe("reasoning");
    const system = captured.find(
      (m) => (m as { role?: string }).role === "system"
    ) as { content?: string } | undefined;
    const text = system?.content ?? "";
    expect(text).toContain("Verified data from the TimeService tool");
    expect(text).toContain(getSystemClock().date);
  });

  it("calendar 'today' day bounds derive from the shared clock", () => {
    vi.setSystemTime(local(6, 13, 4, 5));
    const clock = getSystemClock();
    const start = getDayStart();
    const end = getDayEnd();
    const startDate = new Date(start);
    expect(startDate.getFullYear()).toBe(2026);
    expect(startDate.getMonth()).toBe(7);
    expect(startDate.getDate()).toBe(6);
    expect(startDate.getHours()).toBe(0);
    expect(new Date(end).getDate()).toBe(6);
    expect(end - start).toBe(24 * 60 * 60 * 1_000 - 1);
    expect(start).toBeLessThanOrEqual(clock.unixMs);
    expect(end).toBeGreaterThanOrEqual(clock.unixMs);
  });

  it("injects the shared verified clock into the LLM context for conversational prompts", async () => {
    vi.setSystemTime(local(6, 13, 4, 5));
    let captured: unknown[] = [];
    const model = recordingModel(["Hey there"], (messages) => {
      captured = messages;
    });
    const events = await collect("hey jarvis, what can you do?", model);
    expect(tokensOf(events)).toBe("Hey there");

    const expected = getSystemClock();
    const system = captured.find(
      (m) => (m as { role?: string }).role === "system"
    ) as { content?: string } | undefined;
    expect(system).toBeDefined();
    const text = system?.content ?? "";

    expect(text).toContain("Verified data from the TimeService tool");
    expect(text).toContain(expected.iso);
    expect(text).toContain(expected.date);
    expect(text).toContain(expected.timezone);
    expect(text).toContain('"greeting":"Good afternoon"');
    expect(text).toContain('"dayPart":"afternoon"');
  });

  it("greeting varies with the hour inside the injected LLM context", async () => {
    vi.setSystemTime(local(6, 23, 4, 5));
    let captured: unknown[] = [];
    const model = recordingModel(["ok"], (messages) => {
      captured = messages;
    });
    await collect("hey jarvis, what can you do?", model);
    const system = captured.find(
      (m) => (m as { role?: string }).role === "system"
    ) as { content?: string } | undefined;
    expect(system?.content ?? "").toContain('"greeting":"Good night"');
  });
});
