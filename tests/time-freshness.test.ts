/**
 * Live-fact freshness regression suite.
 *
 * Locks the contract that live system facts — time, date and weather — are
 * fetched fresh on EVERY request. No executor cache, no per-tool TTL that can
 * outlive the request, and no verified-facts context that overrides the tool
 * output. Memory is never asked to store live values.
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
  ToolCache,
} from "@/services/tools";
import { registerTool, getTool } from "@/services/tools/registry";
import type { Tool } from "@/services/tools/types";
import { runPipeline, type PipelineModel } from "@/services/chat";
import { getSystemClock } from "@/lib/ai/system-tools";

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
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

function weatherFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(String(url)).toContain("open-meteo");
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 21.5,
            relative_humidity_2m: 60,
            apparent_temperature: 20,
            weather_code: 2,
            wind_speed_10m: 12,
            time: "2026-08-06T10:00:00Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
}

describe("live-fact freshness", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns a fresh system clock on every call (time/date never cached)", async () => {
    const first = await executeTool("get_current_time");
    const second = await executeTool("get_current_time");
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.meta.cacheHit).toBe(false);
      expect(second.meta.cacheHit).toBe(false);
      expect((first.data as { unixMs: number }).unixMs).not.toBe(
        (second.data as { unixMs: number }).unixMs
      );
      expect(Math.abs(Date.now() - (second.data as { unixMs: number }).unixMs)).toBeLessThan(1_000);
    }
  });

  it("reports a timestamp within 1s of the wall clock", async () => {
    const before = Date.now();
    const result = await executeTool("get_current_time");
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const unixMs = (result.data as { unixMs: number }).unixMs;
      expect(unixMs).toBeGreaterThanOrEqual(before);
      expect(unixMs).toBeLessThanOrEqual(after);
      expect(Math.abs(Date.now() - unixMs)).toBeLessThan(1_000);
    }
  });

  it("answers time from the fresh tool output with no context override", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const expected = getSystemClock().time;
    const events = await collect("what time is it?", fakeModel(["never"]));
    expect(tokensOf(events)).toBe(`It is ${expected}.`);
    expect(events.filter((e) => e.kind === "token").length).toBe(1);
    const plan = events.find((e) => e.kind === "plan") as
      | { intent: string }
      | undefined;
    expect(plan?.intent).toBe("time");
    const toolEvent = events.find((e) => e.kind === "tool") as
      | { tool: string; ok: boolean }
      | undefined;
    expect(toolEvent?.tool).toBe("get_current_time");
    expect(toolEvent?.ok).toBe(true);
    expect(memoryStub.listEntries).not.toHaveBeenCalled();
    expect(memoryStub.createEntry).not.toHaveBeenCalled();
  });

  it("answers the date from the fresh tool output with no context override", async () => {
    vi.setSystemTime(new Date("2026-08-06T12:34:56.000Z"));
    const expected = getSystemClock().date;
    const events = await collect("what is today's date?", fakeModel(["never"]));
    expect(tokensOf(events)).toBe(`Today is ${expected}.`);
    const plan = events.find((e) => e.kind === "plan") as
      | { intent: string }
      | undefined;
    expect(plan?.intent).toBe("date");
    expect(memoryStub.createEntry).not.toHaveBeenCalled();
  });

  it("re-fetches weather on every request (never cached)", async () => {
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetchCount += 1;
        expect(String(url)).toContain("open-meteo");
        return new Response(
          JSON.stringify({
            current: {
              temperature_2m: 21.5,
              relative_humidity_2m: 60,
              apparent_temperature: 20,
              weather_code: 2,
              wind_speed_10m: 12,
              time: "2026-08-06T10:00:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const first = await executeTool("get_weather", {
      latitude: 28.6,
      longitude: 77.2,
    });
    const second = await executeTool("get_weather", {
      latitude: 28.6,
      longitude: 77.2,
    });
    expect(fetchCount).toBe(2);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.meta.cacheHit).toBe(false);
      expect(second.meta.cacheHit).toBe(false);
    }
    expect(toolCache.size()).toBe(0);
  });

  it("declares live tools non-cacheable so they never enter the executor cache", async () => {
    expect(getTool("get_current_time")?.definition.cacheable).toBe(false);
    expect(getTool("get_weather")?.definition.cacheable).toBe(false);
    await executeTool("get_current_time");
    expect(toolCache.size()).toBe(0);
  });

  it("never stores live values in memory during a weather request", async () => {
    weatherFetchMock();
    const events = await collect(
      "what's the weather like?",
      fakeModel(["naturalized"]),
      {
        clientTools: {
          geolocation: { granted: true, latitude: 28.6, longitude: 77.2 },
        },
      }
    );
    expect(tokensOf(events)).toContain("21.5");
    const fact = events.find((e) => e.kind === "fact") as
      | { tool: string }
      | undefined;
    expect(fact?.tool).toBe("get_weather");
    expect(memoryStub.createEntry).not.toHaveBeenCalled();
  });

  it("honors per-tool cache TTLs in the executor", async () => {
    const ttlTool: Tool = {
      definition: {
        name: "ttl_fresh_test",
        description: "counts wall-clock reads",
        category: "math",
        runtime: "any",
        cacheable: true,
        cacheTtlMs: 1_000,
      },
      run: async () => ({ at: Date.now() }),
    };
    registerTool(ttlTool);
    const a = await executeTool("ttl_fresh_test");
    const b = await executeTool("ttl_fresh_test");
    expect(a.ok && b.ok).toBe(true);
    let firstAt = 0;
    if (a.ok && b.ok) {
      expect(a.meta.cacheHit).toBe(false);
      expect(b.meta.cacheHit).toBe(true);
      firstAt = (a.data as { at: number }).at;
    }
    vi.setSystemTime(Date.now() + 2_000);
    const c = await executeTool("ttl_fresh_test");
    expect(c.ok).toBe(true);
    if (c.ok) {
      expect(c.meta.cacheHit).toBe(false);
      expect((c.data as { at: number }).at).not.toBe(firstAt);
    }
  });

  it("stores and expires per-entry TTLs in the cache", () => {
    const cache = new ToolCache(60_000);
    cache.set("k", { v: 1 }, 100);
    expect(cache.get("k")?.value).toEqual({ v: 1 });
    vi.setSystemTime(Date.now() + 200);
    expect(cache.get("k")).toBeNull();
  });
});
