/**
 * Reliability regression suite — the deterministic-execution contract.
 *
 * Covers: time, date, weather, calculator, unit + currency conversion, vision,
 * memory retrieval, tool failure handling and planner routing. Network-backed
 * tools run against mocked `fetch` so the suite is deterministic and offline.
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
import {
  registerTool,
} from "@/services/tools/registry";
import {
  TOOL_ERROR_CODES,
  type Tool,
} from "@/services/tools/types";
import { classifyPlanIntent, planRoute } from "@/services/planner";
import { runPipeline, type PipelineModel } from "@/services/chat";
import { parseVisionAnalysis } from "@/lib/ai/prompts";

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

describe("reliability regression", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------- time
  it("serves the verified system clock (time + date + timezone)", async () => {
    const result = await executeTool("get_current_time");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        iso: string;
        time: string;
        date: string;
        timezone: string;
        unixMs: number;
      };
      expect(Number.isFinite(new Date(data.iso).getTime())).toBe(true);
      expect(data.time.length).toBeGreaterThan(0);
      expect(data.date).toMatch(/20\d\d/);
      expect(typeof data.timezone).toBe("string");
      expect(Number.isFinite(data.unixMs)).toBe(true);
    }
  });

  it("routes time and date requests to the system clock", () => {
    expect(classifyPlanIntent("what time is it?")).toBe("time");
    expect(classifyPlanIntent("what is today's date?")).toBe("date");
    expect(classifyPlanIntent("tell me the time")).toBe("time");
    expect(classifyPlanIntent("give me the current date")).toBe("date");
    expect(classifyPlanIntent("what time does my flight leave?")).toBe(
      "reasoning"
    );
  });

  // ------------------------------------------------------------- weather
  it("answers weather from verified tool data (no LLM guesswork)", async () => {
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

    let seen = "";
    const model: PipelineModel = {
      streamText: async function* ({ messages }) {
        seen = JSON.stringify(messages);
        yield "presented";
      },
    };
    const events = await collect("what's the weather like?", model, {
      clientTools: {
        geolocation: { granted: true, latitude: 28.6, longitude: 77.2 },
      },
    });
    expect(tokensOf(events)).toBe("presented");
    const fact = events.find((e) => e.kind === "fact") as
      | { tool: string; subject: string }
      | undefined;
    expect(fact?.tool).toBe("get_weather");
    // The verified fact must be handed to the LLM as the only source of truth.
    expect(seen).toContain("21.5");
    expect(seen).toContain("Partly cloudy");
    const toolEvent = events.find((e) => e.kind === "tool") as
      | { ok: boolean; tool: string }
      | undefined;
    expect(toolEvent?.ok).toBe(true);
    expect(toolEvent?.tool).toBe("get_weather");
  });

  it("degrades weather failures to an explicit reply (never guesses)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const model = fakeModel(["should never be called"]);
    const events = await collect("what's the temperature today?", model, {
      clientTools: {
        geolocation: { granted: true, latitude: 10, longitude: 20 },
      },
    });
    expect(tokensOf(events)).toContain("couldn't verify the weather");
    expect(events.filter((e) => e.kind === "token").length).toBe(1);
    const toolEvent = events.find((e) => e.kind === "tool") as
      | { ok: boolean }
      | undefined;
    expect(toolEvent?.ok).toBe(false);
  });

  it("requests location before answering weather", async () => {
    const events = await collect(
      "what's the weather?",
      fakeModel(["never"]),
      {}
    );
    expect(tokensOf(events)).toContain("location");
  });

  // ---------------------------------------------------------- calculator
  it.each([
    ["10 percent of 200", 20],
    ["15% of 200", 30],
    ["10 % 3", 1],
    ["10 mod 3", 1],
    ["sqrt(16) * 3", 12],
    ["what is the square root of 81", 9],
    ["what is the square root of 81 times 2", 18],
    ["divide 20 by 4", 5],
    ["whats 100 / 5", 20],
    ["what is 2+2?", 4],
    ["5 minus 3", 2],
    ["7 to the power of 2", 49],
    ["6 times 7", 42],
    ["(2+3)*4", 20],
  ])("calculates %s = %d", async (expression, expected) => {
    const result = await executeTool("calculate", { expression });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { value: number }).value).toBe(expected);
    }
  });

  it("answers calculator requests directly without the LLM", async () => {
    const events = await collect("what is 2+2?", fakeModel(["never"]));
    expect(tokensOf(events)).toMatch(/2\s*\+\s*2\s*=\s*4/);
    const toolEvent = events.find((e) => e.kind === "tool") as
      | { tool: string; ok: boolean }
      | undefined;
    expect(toolEvent?.tool).toBe("calculate");
    expect(toolEvent?.ok).toBe(true);
  });

  it("routes arithmetic phrasings to the calculator intent", () => {
    expect(classifyPlanIntent("10 percent of 200")).toBe("math");
    expect(classifyPlanIntent("15% of 200")).toBe("math");
    expect(classifyPlanIntent("divide 20 by 4")).toBe("math");
    expect(classifyPlanIntent("what is the square root of 81?")).toBe("math");
    expect(classifyPlanIntent("7 to the power of 2")).toBe("math");
  });

  // ----------------------------------------------------- unit conversion
  it("converts units deterministically", async () => {
    const result = await executeTool("convert_units", {
      value: 5,
      from: "km",
      to: "miles",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        value: number;
        toUnit: string;
        formatted: string;
        category: string;
      };
      expect(data.category).toBe("length");
      expect(data.toUnit).toBe("mile");
      expect(data.value).toBeCloseTo(3.106856, 4);
      expect(data.formatted).toContain("mile");
    }
  });

  it("answers unit conversions directly without the LLM", async () => {
    const events = await collect("convert 5 km to miles", fakeModel(["never"]));
    expect(tokensOf(events)).toContain("mile");
    const toolEvent = events.find((e) => e.kind === "tool") as
      | { tool: string; ok: boolean }
      | undefined;
    expect(toolEvent?.tool).toBe("convert_units");
    expect(toolEvent?.ok).toBe(true);
  });

  // ------------------------------------------------------------- currency
  it("converts currency from a verified rate (mocked network)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(String(url)).toContain("frankfurter");
        return new Response(
          JSON.stringify({ date: "2026-08-06", rates: { EUR: 0.92 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );
    const result = await executeTool("convert_currency", {
      amount: 100,
      from: "USD",
      to: "EUR",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        converted: number;
        rate: number;
        to: string;
        formatted: string;
      };
      expect(data.to).toBe("EUR");
      expect(data.rate).toBe(0.92);
      expect(data.converted).toBe(92);
      expect(data.formatted).toContain("EUR");
    }
  });

  it("converts same-currency requests offline (identity)", async () => {
    const result = await executeTool("convert_currency", {
      amount: 50,
      from: "USD",
      to: "usd",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { converted: number }).converted).toBe(50);
      expect((result.data as { source: string }).source).toBe("identity");
    }
  });

  it("routes currency requests to the conversion intent", () => {
    expect(classifyPlanIntent("what is 100 usd in inr?")).toBe("conversion");
  });

  // --------------------------------------------------------------- vision
  it("parses OCR text from the structured vision analysis", () => {
    const analysis = parseVisionAnalysis(
      JSON.stringify({
        visible_objects: [{ name: "book", color: "red", confidence: 95 }],
        person: {
          shirt_color: null,
          shirt_type: null,
          pants_visible: false,
          pants_description: null,
          confidence: 0,
        },
        text: "Welcome to JARVIS",
        uncertain: false,
        reasoning: "A book and a sign are visible.",
      })
    );
    expect(analysis).not.toBeNull();
    expect(analysis?.text).toBe("Welcome to JARVIS");
    expect(analysis?.visible_objects[0]?.name).toBe("book");
    expect(analysis?.uncertain).toBe(false);
  });

  it("parses an empty text field when no readable text exists", () => {
    const analysis = parseVisionAnalysis(
      JSON.stringify({
        visible_objects: [],
        person: {
          shirt_color: null,
          shirt_type: null,
          pants_visible: false,
          pants_description: null,
          confidence: 0,
        },
        uncertain: true,
        reasoning: "Nothing meaningful is visible.",
      })
    );
    expect(analysis?.text).toBe("");
  });

  it("refuses vision questions with a direct answer when no camera is on", async () => {
    const events = await collect("what do you see?", fakeModel(["never"]), {
      vision: { state: "off", frames: [] },
    });
    expect(tokensOf(events)).toContain("camera");
  });

  // -------------------------------------------------------------- memory
  it("retrieves stored memories through the search_memory tool", async () => {
    const result = await executeTool("search_memory", {
      query: "coffee",
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        count: number;
        query: string;
        entries: Array<{ content: string; category: string }>;
      };
      expect(data.count).toBe(1);
      expect(data.entries[0].content).toContain("coffee");
      expect(memoryStub.listEntries).toHaveBeenCalledWith(
        expect.objectContaining({ status: "approved", search: "coffee" })
      );
    }
  });

  it("stores a new memory through the remember tool", async () => {
    const result = await executeTool("remember", {
      content: "The owner prefers tea",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { status: string; id: string };
      expect(data.status).toBe("pending");
      expect(data.id).toBe("m-new");
    }
  });

  // ---------------------------------------------------- tool failure paths
  it("returns a typed failure for unknown tools (never throws)", async () => {
    const result = await executeTool("no_such_tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(TOOL_ERROR_CODES.UNKNOWN_TOOL);
      expect(result.error.retryable).toBe(false);
    }
  });

  it("rejects tool output that fails structural validation", async () => {
    const broken: Tool = {
      definition: {
        name: "broken_out_test",
        description: "returns a malformed result",
        category: "math",
        runtime: "any",
        validate: () => ({ valid: false, reason: "not an object" }),
      },
      run: async () => 42,
    };
    registerTool(broken);
    const result = await executeTool("broken_out_test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(TOOL_ERROR_CODES.VERIFICATION_FAILED);
      expect(result.error.retryable).toBe(false);
    }
  });

  // ---------------------------------------------------- planner confidence
  it("scores routing confidence deterministically", () => {
    expect(planRoute("2 + 2").kind).toBe("direct");
    expect(planRoute("2 + 2").confidence).toBe(100);
    const naturalize = planRoute("what is the weather like?");
    expect(naturalize.kind).toBe("naturalize");
    expect(naturalize.confidence).toBe(90);
    const llm = planRoute("tell me a joke");
    expect(llm.kind).toBe("llm");
    expect(llm.confidence).toBeLessThan(naturalize.confidence);
  });

  it("emits a plan event with confidence through the pipeline", async () => {
    const events = await collect("2 + 2", fakeModel(["never"]));
    const plan = events.find((e) => e.kind === "plan") as
      | { intent: string; confidence: number }
      | undefined;
    expect(plan?.intent).toBe("math");
    expect(plan?.confidence).toBe(100);
  });

  // ---------------------------------------------- weather/date detection
  it("detects weather phrasings deterministically", () => {
    expect(classifyPlanIntent("is it cold outside?")).toBe("weather");
    expect(classifyPlanIntent("how hot is it right now?")).toBe("weather");
    expect(classifyPlanIntent("what's the forecast for tomorrow?")).toBe(
      "weather"
    );
    expect(classifyPlanIntent("is it raining?")).toBe("weather");
    expect(classifyPlanIntent("tell me about rain forests")).toBe("reasoning");
  });

  it("does not hijack non-battery questions", () => {
    expect(classifyPlanIntent("how is my battery?")).toBe("system");
    expect(classifyPlanIntent("explain battery recycling")).toBe("reasoning");
    expect(classifyPlanIntent("how do lithium batteries work?")).toBe(
      "reasoning"
    );
  });
});

describe("planner tool-invocation (pipeline level)", () => {
  it.each(["hi", "hello", "hey jarvis", "good morning", "how are you", "thanks"])(
    "%s runs the conversational LLM with zero tool events",
    async (prompt) => {
      const events = await collect(prompt, fakeModel(["greeting"]));
      expect(events.filter((e) => e.kind === "tool")).toHaveLength(0);
      expect(events.filter((e) => e.kind === "fact")).toHaveLength(0);
      expect(tokensOf(events)).toBe("greeting");
    }
  );

  it.each([
    ["what time is it", "get_current_time"],
    ["today's date", "get_current_time"],
  ])("%s executes only the clock tool", async (prompt, tool) => {
    const events = await collect(prompt, fakeModel(["never"]));
    const toolEvents = events.filter((e) => e.kind === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({ tool, ok: true });
    expect(tokensOf(events)).toMatch(/It is|Today is/);
  });

  it("my schedule today executes only get_calendar", async () => {
    const events = await collect("my schedule today", fakeModel(["schedule"]));
    const toolEvents = events.filter((e) => e.kind === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({ tool: "get_calendar", ok: true });
    const fact = events.find((e) => e.kind === "fact") as
      | { tool: string }
      | undefined;
    expect(fact?.tool).toBe("get_calendar");
  });

  it("what's the weather executes only get_weather", async () => {
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
    const events = await collect("what's the weather", fakeModel(["warm"]), {
      clientTools: {
        geolocation: { granted: true, latitude: 28.6, longitude: 77.2 },
      },
    });
    const toolEvents = events.filter((e) => e.kind === "tool");
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({ tool: "get_weather", ok: true });
    const fact = events.find((e) => e.kind === "fact") as
      | { tool: string }
      | undefined;
    expect(fact?.tool).toBe("get_weather");
  });
});
