/**
 * Chat-pipeline latency benchmark harness.
 *
 * Gated on BENCH=1 so it never runs in the default suite:
 *   BENCH=1 npx vitest run tests/perf/bench-latency.test.ts
 *
 * Measures, per prompt: total latency, time-to-first-token, per-stage waterfall
 * breakdown and LLM/tool call counts. With the fast fake model every prompt is
 * deterministic and network-free (greeting, time, date, math and weather all
 * short-circuit before the LLM; the two reasoning prompts stream the fake).
 *
 * Set BENCH_REAL=1 to benchmark the live Ollama models instead (requires
 * localhost:11434). Set BENCH_ITERS to change the sample count (default 10).
 */

import { describe, expect, it, beforeAll } from "vitest";
import { runPipeline, type PipelineModel } from "@/services/chat";
import {
  getCurrentWaterfall,
  type WaterfallTrace,
} from "@/lib/metrics/waterfall";

const BENCH = process.env.BENCH === "1";
const REAL = process.env.BENCH_REAL === "1";
const ITERATIONS = Number(process.env.BENCH_ITERS ?? (REAL ? "3" : "10"));
const BENCH_MODEL = process.env.BENCH_MODEL ?? "qwen3:4b";
const IT_TIMEOUT = 1_200_000;
const HOOK_TIMEOUT = 120_000;

interface PromptCase {
  label: string;
  prompt: string;
  /** 0 => no LLM call expected (fast path), 1 => reasoning call expected. */
  expectLlm: 0 | 1;
}

const PROMPTS: PromptCase[] = [
  { label: "greeting", prompt: "hey jarvis", expectLlm: 0 },
  { label: "time", prompt: "what time is it", expectLlm: 0 },
  { label: "date", prompt: "what is today's date", expectLlm: 0 },
  { label: "math", prompt: "2+2", expectLlm: 0 },
  { label: "weather", prompt: "what's the weather like", expectLlm: 0 },
  { label: "memory-recall", prompt: "what do you remember about my projects", expectLlm: 0 },
  { label: "tasks-list", prompt: "what tasks do I have", expectLlm: 0 },
  { label: "tasks-create", prompt: "create a task to buy milk", expectLlm: 0 },
  { label: "calendar", prompt: "what's on my calendar today", expectLlm: 0 },
  { label: "profile", prompt: "what is my name", expectLlm: 0 },
  { label: "system-status", prompt: "what's the cpu usage", expectLlm: 0 },
  { label: "reasoning-capabilities", prompt: "what can you do", expectLlm: 1 },
  {
    label: "reasoning-complex",
    prompt: "explain the difference between TCP and UDP",
    expectLlm: 1,
  },
];

function fastModel(): PipelineModel {
  return {
    streamText: async function* () {
      const tokens = [
        "Here",
        " is",
        " the",
        " answer",
        " from",
        " the",
        " fast",
        " model",
        ".",
      ];
      for (const token of tokens) yield token;
    },
  };
}

async function buildRealModel(): Promise<PipelineModel | null> {
  try {
    const { aiService } = await import("@/lib/ai/provider");
    let ok = false;
    for await (const _token of aiService.streamText({
      messages: [{ role: "user", content: "ping" }],
      model: BENCH_MODEL,
    })) {
      ok = true;
    }
    if (!ok) return null;
    return {
      streamText: async function* (opts) {
        yield* aiService.streamText({
          messages: opts.messages,
          signal: opts.signal,
          model: opts.model ?? BENCH_MODEL,
        });
      },
      analyzeCameraFrame: async (opts) =>
        aiService.analyzeCameraFrame({
          imageBase64: opts.imageBase64,
          prompt: opts.prompt,
          mimeType: opts.mimeType,
          signal: opts.signal,
          model: BENCH_MODEL,
        }),
    };
  } catch {
    return null;
  }
}

interface RunResult {
  totalMs: number;
  ttftMs: number | null;
  llmCalls: number;
  toolCalls: number;
  responseChars: number;
  stageMs: Record<string, number>;
  llmMs: number;
  toolMs: number;
  visionMs: number;
}

async function runOnce(
  prompt: string,
  model: PipelineModel
): Promise<RunResult> {
  const startedAt = Date.now();
  let ttftMs: number | null = null;
  let trace: WaterfallTrace | null = null;
  let responseChars = 0;
  for await (const event of runPipeline(
    prompt,
    [{ role: "user", content: prompt }],
    model
  )) {
    if (event.kind === "token") {
      if (ttftMs === null) ttftMs = Date.now() - startedAt;
      responseChars += event.text.length;
    } else if (event.kind === "done") {
      trace = getCurrentWaterfall()?.snapshot() ?? null;
    }
  }
  const stageMs: Record<string, number> = {};
  for (const stage of trace?.stages ?? []) {
    if (stage.durationMs !== null) {
      stageMs[stage.name] = stage.durationMs;
    }
  }
  return {
    totalMs: Date.now() - startedAt,
    ttftMs,
    llmCalls: trace?.counts.llmCalls ?? 0,
    toolCalls: trace?.counts.toolCalls ?? 0,
    responseChars,
    stageMs,
    llmMs: trace?.llmMs ?? 0,
    toolMs: trace?.toolMs ?? 0,
    visionMs: trace?.visionMs ?? 0,
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[idx];
}

function summarize(samples: number[]): { min: number; p50: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function fmt(n: number): string {
  return Math.round(n).toString();
}

function printTable(
  rows: Array<{ label: string; total: string; ttft: string; llm: string; tool: string; stages: string }>
): void {
  const widths = {
    label: Math.max(6, ...rows.map((r) => r.label.length)),
    total: Math.max(5, ...rows.map((r) => r.total.length)),
    ttft: Math.max(4, ...rows.map((r) => r.ttft.length)),
    llm: Math.max(3, ...rows.map((r) => r.llm.length)),
    tool: Math.max(4, ...rows.map((r) => r.tool.length)),
  };
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(
    `${pad("prompt", widths.label)}  ${pad("total(p50/p95/max)", widths.total)}  ${pad("ttft", widths.ttft)}  ${pad("llm", widths.llm)}  ${pad("tool", widths.tool)}  dominant stages (avg ms)`
  );
  for (const row of rows) {
    console.log(
      `${pad(row.label, widths.label)}  ${pad(row.total, widths.total)}  ${pad(row.ttft, widths.ttft)}  ${pad(row.llm, widths.llm)}  ${pad(row.tool, widths.tool)}  ${row.stages}`
    );
  }
}

async function benchPrompts(
  model: PipelineModel,
  label: string
): Promise<void> {
  const summaries: Array<{
    label: string;
    total: string;
    ttft: string;
    llm: string;
    tool: string;
    stages: string;
  }> = [];
  const stageAgg: Record<string, number[]> = {};

  for (const p of PROMPTS) {
    console.log(`  [bench] running "${p.label}" (${p.prompt})...`);
    const totals: number[] = [];
    const ttfts: number[] = [];
    let llmCalls = 0;
    let toolCalls = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await runOnce(p.prompt, model);
      totals.push(r.totalMs);
      if (r.ttftMs !== null) ttfts.push(r.ttftMs);
      llmCalls += r.llmCalls;
      toolCalls += r.toolCalls;
      for (const [name, ms] of Object.entries(r.stageMs)) {
        (stageAgg[name] ??= []).push(ms);
      }
    }
    const t = summarize(totals);
    const f = ttfts.length > 0 ? summarize(ttfts) : null;
    summaries.push({
      label: p.label,
      total: `${fmt(t.p50)}/${fmt(t.p95)}/${fmt(t.max)}`,
      ttft: f ? `${fmt(f.p50)}` : "-",
      llm: String(llmCalls / ITERATIONS),
      tool: String(toolCalls / ITERATIONS),
      stages: "",
    });
  }

  const stageOrder: Array<[string, string]> = [
    ["language_detection", "lang"],
    ["planner", "plan"],
    ["memory_lookup", "mem"],
    ["tool_execution", "tool"],
    ["llm_first_token", "ttft(open)"],
    ["llm_complete", "llm"],
    ["postprocess", "post"],
  ];
  for (const row of summaries) {
    const parts: string[] = [];
    for (const [name, short] of stageOrder) {
      const samples = stageAgg[name] ?? [];
      if (samples.length > 0) {
        parts.push(`${short}=${fmt(samples.reduce((a, b) => a + b, 0) / samples.length)}`);
      }
    }
    row.stages = parts.join(" ");
  }

  console.log(`\n=== latency bench [${label}], ${ITERATIONS} iterations/prompt ===`);
  printTable(summaries);
}

describe.skipIf(!BENCH)("latency bench (fast fake model)", () => {
  it("runs all prompts with the fast deterministic model", async () => {
    await benchPrompts(fastModel(), "fake-model");

    const greeting = await runOnce("hey jarvis", fastModel());
    expect(greeting.llmCalls).toBe(0);
    expect(greeting.totalMs).toBeLessThan(100);

    const time = await runOnce("what time is it", fastModel());
    expect(time.llmCalls).toBe(0);
    expect(time.toolCalls).toBeGreaterThanOrEqual(1);
    expect(time.totalMs).toBeLessThan(200);

    const math = await runOnce("2+2", fastModel());
    expect(math.llmCalls).toBe(0);
    expect(math.totalMs).toBeLessThan(200);

    const weather = await runOnce("what's the weather like", fastModel());
    expect(weather.llmCalls).toBe(0);

    const calendar = await runOnce("what's on my calendar today", fastModel());
    expect(calendar.llmCalls).toBe(0);
    expect(calendar.totalMs).toBeLessThan(200);

    const profile = await runOnce("what is my name", fastModel());
    expect(profile.llmCalls).toBe(0);
    expect(profile.totalMs).toBeLessThan(200);

    const reasoning = await runOnce("what can you do", fastModel());
    expect(reasoning.llmCalls).toBe(1);
  });
});

describe.skipIf(!REAL)("latency bench (live Ollama model)", () => {
  let model: PipelineModel | null = null;

  beforeAll(async () => {
    model = await buildRealModel();
  }, HOOK_TIMEOUT);

  it("runs all prompts against the live Ollama model", async () => {
    if (!model) {
      console.log("Skipping: Ollama model unreachable at localhost:11434");
      return;
    }
    await benchPrompts(model, `ollama-real (${BENCH_MODEL})`);
  }, IT_TIMEOUT);
});
