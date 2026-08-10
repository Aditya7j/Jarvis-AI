import { describe, expect, it, vi } from "vitest";

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
import { classifyWithReasons, planRoute } from "@/services/planner";
import { initToolRouter } from "@/services/tools";

import * as tools from "@/services/tools";
import { detectLanguage } from "@/lib/lang/detect";
import { normalizeExpression } from "@/lib/toolkit/math";
import { extractDateTokens } from "@/lib/time/date-calc";

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
      for (const token of tokens) yield token;
    },
  };
}

const QUERIES = [
  "847 × 936",
  "25% of 840",
  "A number is increased by 20% and then decreased by 20%. What is the net percentage change?",
  "What is today's date?",
  "What day will 27 August 2037 be?",
  "What time is it in Tokyo?",
  "What is React?",
  "What is a JavaScript closure?",
  "Who is the current Prime Minister of India?",
  "847 × 936 batao",
  "JavaScript closure kya hota hai?",
  "What is REST API?",
];

function summarizeResult(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return { array: data.length };
  if (!data || typeof data !== "object") return { v: data };
  const r = data as Record<string, unknown>;
  if (typeof r.abstract === "string")
    return {
      engine: r.engine,
      heading: r.heading,
      abstractLen: r.abstract.length,
      abstract: r.abstract.slice(0, 160),
      answer: r.answer,
      source: r.source,
      topics: Array.isArray(r.topics) ? r.topics.length : undefined,
    };
  return { ...r };
}

describe("trace 12", () => {
  it("prints routing traces for the 12 questions", async () => {
    initToolRouter();
    const execSpy = vi.spyOn(tools, "executeTool");
    for (const q of QUERIES) {
      const callLog: unknown[] = [];
      execSpy.mockClear();
      try {
        const { cls, reasons } = classifyWithReasons(q);
        const route = planRoute(q);
        const language = detectLanguage(q).language;
        const events: any[] = [];
        const model = fakeModel(["never"]);
        for await (const event of runPipeline(q, [{ role: "user", content: q }], model)) {
          events.push(event);
        }
        for (const call of execSpy.mock.calls) {
          callLog.push({
            name: call[0],
            args: call[1],
            result: call[2] ? "n/a" : undefined,
          });
        }
        const toolResults: unknown[] = [];
        for (const call of execSpy.mock.results) {
          const val = call.value as { ok: boolean; data?: unknown; error?: { code?: string } };
          toolResults.push({
            ok: val?.ok,
            code: val?.ok ? undefined : val?.error?.code,
            data: val?.ok ? summarizeResult(val.data) : undefined,
          });
        }
        const plan = events.find((e) => e.kind === "plan");
        const toolEvents = events.filter((e) => e.kind === "tool");
        const tokens = events
          .filter((e) => e.kind === "token")
          .map((e) => e.text as string)
          .join("");
        const sourceEvent = events.find((e) => e.kind === "source");
        let normalized: string | null = null;
        let dateTokens: ReturnType<typeof extractDateTokens> = [];
        if (cls === "math") {
          try {
            normalized = normalizeExpression(q);
          } catch {
            normalized = "(normalize failed)";
          }
        }
        if (cls === "date-calc") dateTokens = extractDateTokens(q);
        console.log(
          "[TRACE12] " +
            JSON.stringify({
              user: q,
              language,
              normalized: normalized ?? q.trim().toLowerCase(),
              dateTokens,
              intent: cls,
              why: reasons,
              confidence: route.confidence,
              route: route.kind,
              toolsSelected: route.audit.toolsSelected,
              toolsConsidered: route.audit.toolsConsidered,
              toolReasons: route.audit.toolReasons,
              planEvent: plan,
              toolArgs: callLog,
              toolResults,
              toolEvents: toolEvents.map((t) => ({
                tool: t.tool,
                ok: t.ok,
                fallbackReason: t.fallbackReason ?? null,
              })),
              source: sourceEvent?.source ?? null,
              answer: tokens,
            })
        );
        expect(plan).toBeDefined();
      } catch (err) {
        console.log(
          "[TRACE12] " +
            JSON.stringify({ user: q, error: err instanceof Error ? err.message : String(err) })
        );
      }
    }
    expect(true).toBe(true);
  }, 300_000);
});
