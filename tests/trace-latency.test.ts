/**
 * LATENCY TRACE & REGRESSION — run representative queries through the REAL
 * pipeline and record the exact route + per-stage latency (classify, planner,
 * tool, network, model, validation, total).
 *
 * Also a permanent regression guard for the latency fixes:
 *  - news story bodies are fetched CONCURRENTLY (not sequentially),
 *  - web_search's Wikipedia fallback runs concurrently with DuckDuckGo and is
 *    aborted when the instant answer wins,
 *  - Hinglish/Hindi compute commands ("ginti karo 15*4") parse correctly
 *    without breaking English expressions or numbers.
 *
 * The latency assertions are structural (call concurrency / overlap), not
 * wall-clock thresholds, so they hold across slow and fast networks. They are
 * skipped with a "[TRACE]" note when the network is unreachable, keeping the
 * suite green offline.
 */

import { describe, expect, it, vi } from "vitest";
import { evaluateExpression } from "@/lib/toolkit/math";

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
import { classifyPlanIntent, planRoute } from "@/services/planner";
import { initToolRouter } from "@/services/tools";

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
      for (const token of tokens) yield token;
    },
  };
}

type TestEvent = { kind: string; [key: string]: unknown };

interface NetCall {
  host: string;
  ms: number;
  ok: boolean;
  status: number | null;
}

const realFetch = globalThis.fetch;
let netCalls: NetCall[] = [];
let inFlight = 0;
let peakInFlight = 0;

function wrapFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight++;
    if (inFlight > peakInFlight) peakInFlight = inFlight;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const startedAt = Date.now();
    try {
      const res = await realFetch(input as RequestInfo, init);
      netCalls.push({ host: new URL(url).host, ms: Date.now() - startedAt, ok: res.ok, status: res.status });
      return res;
    } catch (err) {
      netCalls.push({ host: new URL(url).host, ms: Date.now() - startedAt, ok: false, status: null });
      throw err;
    } finally {
      inFlight--;
    }
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

async function traceOne(query: string): Promise<Record<string, unknown>> {
  const startedAt = Date.now();

  const tClassify = Date.now();
  const cls = classifyPlanIntent(query);
  const route = planRoute(query);
  const classifyMs = Date.now() - tClassify;

  const events: TestEvent[] = [];
  const model = fakeModel(["never"]);
  for await (const event of runPipeline(query, [{ role: "user", content: query }], model)) {
    events.push(event as TestEvent);
  }
  const totalMs = Date.now() - startedAt;

  const plan = events.find((e) => e.kind === "plan");
  const toolEvents = events.filter((e) => e.kind === "tool");
  const tokenEvents = events.filter((e) => e.kind === "token");
  const factEvents = events.filter((e) => e.kind === "fact");
  const sourceEvent = events.find((e) => e.kind === "source");
  const doneEvent = events.find((e) => e.kind === "done");

  return {
    q: query,
    intent: plan?.intent ?? null,
    tools: (plan?.tools as string[]) ?? [],
    toolsConsidered: route.audit.toolsConsidered,
    toolsSelected: route.audit.toolsSelected,
    confidence: plan?.confidence ?? null,
    classifyMs: Math.round(classifyMs),
    toolCalls: toolEvents.length,
    toolDetail: toolEvents.map((t) => ({
      tool: t.tool,
      ok: t.ok,
      latencyMs: t.latencyMs,
      fallbackReason: t.fallbackReason ?? null,
    })),
    replyText: tokenEvents
      .map((t) => t.text as string)
      .join(""),
    llmTokens: tokenEvents.length,
    factCount: factEvents.length,
    source: sourceEvent?.source ?? null,
    done: doneEvent !== undefined,
    totalMs,
    network: [...netCalls],
    peakInFlight,
    sumNetMs: netCalls.reduce((sum, call) => sum + call.ms, 0),
  };
}

const QUERIES: Array<{ tag: string; q: string }> = [
  { tag: "time", q: "what time is it" },
  { tag: "date", q: "what's the date today" },
  { tag: "weather", q: "what is the weather in new delhi" },
  { tag: "news", q: "give me the latest news" },
  { tag: "math", q: "what is 12*8+3" },
  { tag: "unit", q: "convert 5 miles to km" },
  { tag: "currency", q: "convert 100 usd to eur" },
  { tag: "datecalc", q: "what day is 45 days from now" },
  { tag: "timer", q: "set a timer for 10 minutes" },
  { tag: "reasoning-def", q: "what is React" },
  { tag: "reasoning-closure", q: "explain closures in javascript" },
  { tag: "conversational", q: "who are you" },
  { tag: "memory", q: "remember that i like coffee" },
  { tag: "greeting", q: "hello" },
  { tag: "knowledge-capital", q: "what is the capital of japan" },
  { tag: "knowledge-pm", q: "who is the current prime minister of india" },
  { tag: "knowledge-invent", q: "who invented the telephone" },
  { tag: "knowledge-hinglish", q: "india ka pehla sikh prime minister kaun tha" },
  { tag: "websearch", q: "search the web for python tutorials" },
  { tag: "system-status", q: "what's my battery status" },
  { tag: "location", q: "where am i" },
  { tag: "news-specific", q: "any news about microsoft" },
  { tag: "math-hindi", q: "ginti karo 15*4" },
];

const results: Record<string, Record<string, unknown>> = {};

describe("latency trace & regression", () => {
  it("traces 23 representative queries through the real pipeline", async () => {
    initToolRouter();

    const consoleLog = console.log;

    for (const { tag, q } of QUERIES) {
      netCalls = [];
      inFlight = 0;
      peakInFlight = 0;
      wrapFetch();
      const captured: string[] = [];
      const origLog = console.log;
      console.log = (line: unknown, ...rest: unknown[]) => {
        captured.push(String(line));
        origLog.apply(console, [line, ...rest]);
      };
      try {
        const trace = await traceOne(q);
        const waterfallLine = captured
          .filter((l) => l.includes("[waterfall]"))
          .slice(-1)[0];
        let waterfall: Record<string, unknown> | null = null;
        if (waterfallLine) {
          try {
            const json = waterfallLine.match(/\{.*\}$/)?.[0];
            waterfall = json ? JSON.parse(json) : null;
          } catch {
            waterfall = null;
          }
        }
        const record = { tag, ...trace, waterfall };
        results[tag] = record;
        consoleLog(`[TRACE] ${JSON.stringify(record)}`);
      } catch (err) {
        const record = {
          tag,
          q,
          error: err instanceof Error ? err.message : String(err),
          totalMs: 0,
        };
        results[tag] = record;
        consoleLog(`[TRACE] ${JSON.stringify(record)}`);
      } finally {
        console.log = origLog;
        restoreFetch();
      }
    }

    expect(Object.keys(results).length).toBe(QUERIES.length);

    for (const { tag, q } of QUERIES) {
      const record = results[tag];
      expect(record, `${tag} (${q}) must produce a trace`).toBeDefined();
      expect(record?.done, `${tag} (${q}) must reach the done event`).toBe(true);
    }
  }, 300_000);

  it("answers Hinglish/Hindi math through the real pipeline, tool-backed", () => {
    const record = results["math-hindi"];
    expect(record?.intent).toBe("math");
    expect((record?.tools as string[])?.[0]).toBe("calculate");
    const tool = (record?.toolDetail as Array<{ tool: string; ok: boolean }>)?.[0];
    expect(tool?.ok).toBe(true);
    expect(String(record?.replyText)).toMatch(/= 60/);
    expect(record?.llmTokens).toBe(1);
  });

  it("parses Hinglish/Hindi compute commands without breaking English or numbers", () => {
    expect(evaluateExpression("ginti karo 15*4").value).toBe(60);
    expect(evaluateExpression("hisab karo 12/3").value).toBe(4);
    expect(evaluateExpression("15*4 batao").value).toBe(60);
    expect(evaluateExpression("calculate karo 2+2").value).toBe(4);
    expect(evaluateExpression("गिनती करो 15*4").value).toBe(60);
    expect(evaluateExpression("हिसाब करो 12/3").value).toBe(4);
    expect(evaluateExpression("5 गुना करो 3").value).toBe(15);
    expect(evaluateExpression("calculate 2 + 2").value).toBe(4);
    expect(evaluateExpression("10 percent of 50").value).toBe(5);
    expect(evaluateExpression("3 times 2").value).toBe(6);
    expect(evaluateExpression("what is the value of 12 / 4").value).toBe(3);
  });

  it("fetches news stories concurrently (latency fix)", () => {
    const record = results["news"];
    const network = (record?.network as NetCall[]) ?? [];
    const online = network.some((call) => call.ok);
    if (!online) {
      console.log("[TRACE] news concurrency assertion skipped: network unreachable");
      return;
    }
    expect(network.length).toBeGreaterThan(1);
    // Story bodies run in parallel: at least 3 fetches overlap in flight.
    expect(record?.peakInFlight).toBeGreaterThanOrEqual(3);
    // Overlap means total elapsed tool time < the sum of all network calls.
    const toolLatency = ((record?.toolDetail as Array<{ latencyMs: number }>)?.[0])?.latencyMs ?? 0;
    expect(Number(record?.sumNetMs)).toBeGreaterThan(toolLatency);
  });

  it("runs the web_search Wikipedia fallback concurrently with DuckDuckGo (latency fix)", () => {
    const record = results["knowledge-invent"];
    const network = (record?.network as NetCall[]) ?? [];
    if (network.length < 2) {
      // DuckDuckGo answered directly (single call) or the network was
      // unreachable — nothing to overlap, nothing to assert.
      console.log("[TRACE] search concurrency assertion skipped: fallback not used / offline");
      return;
    }
    expect(record?.peakInFlight).toBeGreaterThanOrEqual(2);
    const toolLatency = ((record?.toolDetail as Array<{ latencyMs: number }>)?.[0])?.latencyMs ?? 0;
    expect(Number(record?.sumNetMs)).toBeGreaterThan(toolLatency);
  });
});
