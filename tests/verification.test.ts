/**
 * Verification contract suite — the "no LLM hallucination" guarantee.
 *
 * For every tool-backed class the pipeline MUST run its tool before the model
 * is allowed to speak. Direct classes never call the model at all. If a tool
 * (or required client fact) is missing, the assistant replies explicitly that
 * it could not verify — never by guessing.
 *
 * The suite runs the real Tool Router + real pipeline against fake models and
 * a mocked `fetch`, then asserts the hallucination monitor reports zero.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const memoryStub = vi.hoisted(() => ({
  listEntries: vi.fn(async () => []),
  createEntry: vi.fn(async (input: { content: string }) => ({
    id: "m-new",
    status: "pending",
    content: input.content,
    updatedAt: new Date().toISOString(),
  })),
  getProfile: vi.fn(async () => ({
    id: "owner-1",
    name: "Alex Developer",
    nickname: "Alex",
    email: "alex@example.com",
    occupation: "Software Engineer",
    skills: ["TypeScript"],
    interests: ["AI"],
    goals: ["Build reliable software"],
    dailyRoutine: "Morning coffee, then code",
    preferences: [],
    location: "Delhi, India",
    timezone: "Asia/Kolkata",
    birthday: "",
    emergencyContacts: [],
    socialLinks: [],
    customNotes: "",
    createdAt: 0,
    updatedAt: 0,
  })),
}));

const taskStub = vi.hoisted(() => {
  const now = new Date();
  const todayAtTen = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    10,
    0,
    0
  ).getTime();
  return {
    taskEngine: {
      listTasks: vi.fn(async () => [
        {
          id: "task-1",
          title: "Standup at 10",
          description: "Daily standup",
          status: "scheduled",
          scheduledAt: todayAtTen,
          nextRunAt: null,
        },
      ]),
      createTask: vi.fn(),
      runTask: vi.fn(),
      retryTask: vi.fn(),
      cancelTask: vi.fn(),
      deleteTask: vi.fn(),
    },
  };
});

vi.mock("@/lib/memory", () => ({
  memoryService: memoryStub,
  MemoryService: class {},
  JsonFileMemoryRepository: class {},
  buildOwnerContext: () => "",
  appendMemoryContext: (s: string) => s,
}));

vi.mock("@/services/tasks", () => taskStub);

import {
  initToolRouter,
  toolCache,
} from "@/services/tools";
import {
  hallucinationMonitor,
  isHallucination,
  runPipeline,
  runPipelineText,
  type PipelineModel,
  type ResponseSource,
} from "@/services/chat";
import { classifyPlanIntent } from "@/services/planner";

function tokensOf(events: Array<{ kind: string; [key: string]: unknown }>): string {
  return events
    .filter((e) => e.kind === "token")
    .map((e) => e.text as string)
    .join("");
}

function sourceOf(events: Array<{ kind: string; [key: string]: unknown }>): ResponseSource | null {
  const sourceEvent = events.find((e) => e.kind === "source") as
    | { source: ResponseSource }
    | undefined;
  return sourceEvent?.source ?? null;
}

function toolEventsOf(
  events: Array<{ kind: string; [key: string]: unknown }>
): Array<{ tool: string; ok: boolean; fallbackReason?: string }> {
  return events
    .filter((e) => e.kind === "tool")
    .map((e) => ({
      tool: e.tool as string,
      ok: e.ok as boolean,
      fallbackReason: e.fallbackReason as string | undefined,
    }));
}

/** Records the messages the model actually received. */
function recordingModel(tokens: string[], onMessages?: (messages: unknown[]) => void): PipelineModel {
  return {
    streamText: async function* ({ messages }) {
      onMessages?.(messages as unknown[]);
      for (const token of tokens) yield token;
    },
  };
}

describe("verification contract", () => {
  beforeEach(() => {
    initToolRouter();
    toolCache.clear();
    hallucinationMonitor.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("direct classes answer from the tool — the model is never called", () => {
    it.each([
      ["What time is it?", "get_current_time", /^It is \d{1,2}:\d{2} [AP]M/],
      ["Today's date?", "get_current_time", /20\d\d/],
      ["Convert 5 km to miles.", "convert_units", /mile/],
      ["348 × 987", "calculate", /343476/],
    ] as const)("%s → %s", async (prompt, expectedTool, pattern) => {
      let modelCalled = false;
      const model: PipelineModel = {
        streamText: async function* () {
          modelCalled = true;
          yield "should never be called";
        },
      };
      const result = await runPipelineText(
        prompt,
        [{ role: "user", content: prompt }],
        model
      );
      expect(modelCalled).toBe(false);
      expect(result.text).toMatch(pattern);
      expect(result.intent).toBe(classifyPlanIntent(prompt));
      expect(result.source).toBe("tool");
      const tools = toolEventsOf(result.events);
      expect(tools).toHaveLength(1);
      expect(tools[0].tool).toBe(expectedTool);
      expect(tools[0].ok).toBe(true);
    });
  });

  describe("naturalize classes run the tool BEFORE the model speaks", () => {
    it("calendar → get_calendar first, then LLM summarizes the verified schedule", async () => {
      let seen: unknown[] = [];
      const model = recordingModel(["Summarized."], (messages) => (seen = messages));
      const result = await runPipelineText(
        "What's on my calendar today?",
        [{ role: "user", content: "What's on my calendar today?" }],
        model
      );
      const tools = toolEventsOf(result.events);
      expect(tools[0].tool).toBe("get_calendar");
      expect(tools[0].ok).toBe(true);
      expect(taskStub.taskEngine.listTasks).toHaveBeenCalled();
      // The verified fact must be in the model's messages.
      expect(JSON.stringify(seen)).toContain("Standup at 10");
      expect(JSON.stringify(seen)).toContain("ONLY source of truth");
      expect(result.source).toBe("tool");
    });

    it("profile → get_owner_profile first, never the model guessing the name", async () => {
      let seen: unknown[] = [];
      const model = recordingModel(["Verified."], (messages) => (seen = messages));
      const result = await runPipelineText(
        "What is my name?",
        [{ role: "user", content: "What is my name?" }],
        model
      );
      const tools = toolEventsOf(result.events);
      expect(tools[0].tool).toBe("get_owner_profile");
      expect(tools[0].ok).toBe(true);
      expect(JSON.stringify(seen)).toContain("Alex Developer");
      expect(result.source).toBe("tool");
    });

    it("weather → get_weather from a verified location before the LLM", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          expect(String(url)).toContain("open-meteo");
          return new Response(
            JSON.stringify({
              current: {
                temperature_2m: 31.2,
                relative_humidity_2m: 55,
                apparent_temperature: 30,
                weather_code: 1,
                wind_speed_10m: 10,
                time: "2026-08-06T10:00:00Z",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        })
      );
      let seen: unknown[] = [];
      const model = recordingModel(["Summary."], (messages) => (seen = messages));
      const result = await runPipelineText(
        "Weather in Delhi?",
        [{ role: "user", content: "Weather in Delhi?" }],
        model,
        {
          clientTools: { geolocation: { granted: true, latitude: 28.6, longitude: 77.2 } },
        }
      );
      const tools = toolEventsOf(result.events);
      expect(tools[0].tool).toBe("get_weather");
      expect(tools[0].ok).toBe(true);
      expect(JSON.stringify(seen)).toContain("31.2");
      expect(result.source).toBe("tool");
    });

    it("location → the verified geolocation fact is injected, never guessed", async () => {
      let seen: unknown[] = [];
      const model = recordingModel(["Verified."], (messages) => (seen = messages));
      const result = await runPipelineText(
        "Where am I?",
        [{ role: "user", content: "Where am I?" }],
        model,
        {
          clientTools: {
            geolocation: { granted: true, latitude: 28.6139, longitude: 77.209, accuracyM: 25 },
          },
        }
      );
      const tools = toolEventsOf(result.events);
      expect(tools[0].tool).toBe("browser-geolocation");
      expect(tools[0].ok).toBe(true);
      expect(JSON.stringify(seen)).toContain("28.6139");
      expect(result.source).toBe("tool");
    });

    it("vision → the model only sees Gemma-grounded facts, never a raw frame", async () => {
      const model: PipelineModel = {
        analyzeCameraFrame: async () =>
          JSON.stringify({
            visible_objects: [{ name: "cup", color: "white", confidence: 92 }],
            person: {
              shirt_color: null,
              shirt_type: null,
              pants_visible: false,
              pants_description: null,
              confidence: 0,
            },
            text: "",
            uncertain: false,
            reasoning: "A white cup is in view.",
          }),
        streamText: async function* () {
          yield "Verified.";
        },
      };
      const events: Array<{ kind: string; [key: string]: unknown }> = [];
      for await (const event of runPipeline(
        "Describe what I'm holding",
        [{ role: "user", content: "Describe what I'm holding" }],
        model,
        {
          vision: {
            state: "live",
            frames: [
              {
                image: "aGVsbG8=",
                mimeType: "image/jpeg",
                source: "webcam",
                width: 640,
                height: 480,
                capturedAt: Date.now(),
              },
            ],
          },
        }
      )) {
        events.push(event);
      }
      expect(events.some((e) => e.kind === "vision")).toBe(true);
      expect(sourceOf(events)).toBe("vision");
      expect(tokensOf(events)).toBe("Verified.");
    });
  });

  describe("client-gated denials are explicit — the model never guesses", () => {
    it("refuses location questions without permission, with no LLM", async () => {
      let modelCalled = false;
      const model: PipelineModel = {
        streamText: async function* () {
          modelCalled = true;
          yield "never";
        },
      };
      const result = await runPipelineText(
        "Where am I?",
        [{ role: "user", content: "Where am I?" }],
        model
      );
      expect(modelCalled).toBe(false);
      expect(result.text).toContain("location");
      const tools = toolEventsOf(result.events);
      expect(tools[0].tool).toBe("browser-geolocation");
      expect(tools[0].ok).toBe(false);
      expect(result.source).toBe("tool");
    });

    it("refuses weather without location, with no LLM", async () => {
      let modelCalled = false;
      const model: PipelineModel = {
        streamText: async function* () {
          modelCalled = true;
          yield "never";
        },
      };
      const result = await runPipelineText(
        "What's the weather?",
        [{ role: "user", content: "What's the weather?" }],
        model
      );
      expect(modelCalled).toBe(false);
      expect(result.text.toLowerCase()).toContain("location");
      const tools = toolEventsOf(result.events);
      expect(tools[0].ok).toBe(false);
    });
  });

  describe("hallucination monitor", () => {
    it("defines a hallucination as LLM output with zero verified facts", () => {
      expect(
        isHallucination({ llmInvoked: true, toolBacked: true, verifiedFactCount: 0 })
      ).toBe(true);
      expect(
        isHallucination({ llmInvoked: true, toolBacked: true, verifiedFactCount: 1 })
      ).toBe(false);
      expect(
        isHallucination({ llmInvoked: false, toolBacked: true, verifiedFactCount: 0 })
      ).toBe(false);
      expect(
        isHallucination({ llmInvoked: true, toolBacked: false, verifiedFactCount: 0 })
      ).toBe(false);
    });

    it("reports zero hallucinations across the whole verification battery", async () => {
      const model = recordingModel(["ok"]);
      const queries = [
        "What time is it?",
        "Today's date?",
        "What's on my calendar today?",
        "Convert 5 km to miles.",
        "348 × 987",
      ];
      for (const prompt of queries) {
        await runPipelineText(prompt, [{ role: "user", content: prompt }], model);
      }
      const report = hallucinationMonitor.getReport();
      expect(report.totalRequests).toBe(queries.length);
      expect(report.hallucinationCount).toBe(0);
      expect(report.hallucinationRate).toBe(0);
      expect(report.instances).toEqual([]);
    });

    it("counts a synthetic hallucination as a positive control", () => {
      hallucinationMonitor.record({
        requestId: "control",
        prompt: "control",
        cls: "weather",
        route: "naturalize",
        tools: [{ name: "get_weather", ok: null }],
        verifiedFactCount: 0,
        llmInvoked: true,
        source: "reasoning",
        hallucination: true,
        reason: "control",
      });
      const report = hallucinationMonitor.getReport();
      expect(report.hallucinationCount).toBe(1);
      expect(report.hallucinationRate).toBe(1);
      expect(report.instances[0].requestId).toBe("control");
      hallucinationMonitor.clear();
      expect(hallucinationMonitor.getReport().totalRequests).toBe(0);
    });
  });
});
