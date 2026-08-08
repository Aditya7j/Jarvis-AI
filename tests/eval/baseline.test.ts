/**
 * Baseline eval harness — drives the REAL pipeline end-to-end.
 *
 * NOT a unit suite. Runs every question through `runPipelineText` with the real
 * production model (`aiService`) and the real Tool Router, recording per-test:
 * intent, source, tools used, llm_used, verification status and PASS/FAIL.
 *
 * The report is written to `data/eval/baseline.json` (+ a markdown summary) so
 * future work packages can diff behavior against this captured baseline.
 *
 * Enable with: `RUN_EVAL=1 npx vitest run tests/eval/baseline.test.ts`
 * Network/LLM-dependent questions need API keys in `.env`; those questions are
 * recorded with their failure reason and do NOT fail the run — the report is
 * the deliverable.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPipelineText } from "@/services/chat";
import type { PipelineModel } from "@/services/chat";
import { aiService } from "@/lib/ai";

const ENABLED = process.env.RUN_EVAL === "1";

/** Wrap the production model so LLM invocations are counted per question. */
function trackingModel(base: typeof aiService): { model: PipelineModel; llmCalls: () => number } {
  let calls = 0;
  const model: PipelineModel = {
    streamText(opts) {
      calls++;
      return base.streamText(opts);
    },
  };
  return { model, llmCalls: () => calls };
}

interface EvalCase {
  id: string;
  category: string;
  question: string;
  intent: string;
  source: string;
  contains?: string[];
  requiresLocation?: boolean;
  offlineSafe?: boolean;
  /** Prior user turns used to exercise conversation-context behaviour. */
  history?: Array<{ role: "user"; content: string }>;
}

const CASES: EvalCase[] = [
  {
    id: "math-01",
    category: "math",
    question: "What is 23 * 7?",
    intent: "math",
    source: "tool",
    contains: ["161"],
    offlineSafe: true,
  },
  {
    id: "math-02",
    category: "math",
    question: "What is 25 percent of 80?",
    intent: "math",
    source: "tool",
    contains: ["20"],
    offlineSafe: true,
  },
  {
    id: "date-calc-01",
    category: "date-calc",
    question: "What day is 15 August 2026?",
    intent: "date-calc",
    source: "tool",
    contains: ["Saturday"],
    offlineSafe: true,
  },
  {
    id: "date-calc-02",
    category: "date-calc",
    question: "What day is 1 January 2025?",
    intent: "date-calc",
    source: "tool",
    contains: ["Wednesday"],
    offlineSafe: true,
  },
  {
    id: "date-calc-03",
    category: "date-calc",
    question: "How many days are there between 1 January 2026 and 10 January 2026?",
    intent: "date-calc",
    source: "tool",
    contains: ["9"],
    offlineSafe: true,
  },
  {
    id: "time-01",
    category: "time",
    question: "What time is it?",
    intent: "time",
    source: "tool",
    offlineSafe: true,
  },
  {
    id: "date-01",
    category: "date",
    question: "What is today's date?",
    intent: "date",
    source: "tool",
    offlineSafe: true,
  },
  {
    id: "conversion-01",
    category: "conversion",
    question: "Convert 10 miles to kilometers",
    intent: "conversion",
    source: "tool",
    contains: ["16.0934"],
    offlineSafe: true,
  },
  {
    id: "conversion-02",
    category: "conversion",
    question: "Convert 100 USD to EUR",
    intent: "conversion",
    source: "tool",
    contains: ["EUR"],
    offlineSafe: false,
  },
  {
    id: "weather-01",
    category: "weather",
    question: "What is the weather in Delhi?",
    intent: "weather",
    source: "tool",
    requiresLocation: true,
    offlineSafe: false,
  },
  {
    id: "weather-02",
    category: "weather",
    question: "दिल्ली में मौसम कैसा है?",
    intent: "weather",
    source: "tool",
    requiresLocation: true,
    offlineSafe: false,
  },
  {
    id: "system-01",
    category: "system",
    question: "What is your CPU usage right now?",
    intent: "system",
    source: "tool",
    offlineSafe: true,
  },
  {
    id: "memory-01",
    category: "memory",
    question: "Search your memory for anything about a project",
    intent: "memory",
    source: "memory",
    offlineSafe: true,
  },
  {
    id: "search-01",
    category: "search",
    question: "What is the capital of France?",
    intent: "search",
    source: "tool",
    contains: ["Paris"],
    offlineSafe: false,
  },
  {
    id: "search-02",
    category: "search",
    question: "Who is the current prime minister of India?",
    intent: "search",
    source: "tool",
    contains: ["Narendra Modi"],
    offlineSafe: false,
  },
  {
    id: "search-03",
    category: "search",
    question: "Who is the current prime minister?",
    intent: "search",
    source: "tool",
    contains: ["Narendra Modi"],
    history: [{ role: "user", content: "Who is the current prime minister of India?" }],
    offlineSafe: false,
  },
  {
    id: "search-04",
    category: "search",
    question: "Who is the current prime misnister of India?",
    intent: "search",
    source: "tool",
    contains: ["Narendra Modi"],
    offlineSafe: false,
  },
  {
    id: "reasoning-01",
    category: "reasoning",
    question: "Write a short haiku about the moon.",
    intent: "reasoning",
    source: "reasoning",
    offlineSafe: false,
  },
];

interface EvalRecord {
  id: string;
  category: string;
  question: string;
  expected: { intent: string; source: string };
  actual: {
    intent: string;
    source: string;
    text: string;
    tools: string[];
    llmUsed: boolean;
    verificationStatus: string;
    fallbackReason?: string;
    error?: string;
    latencyMs: number;
  };
  pass: boolean;
  failureReason: string | null;
}

const DELHI = { granted: true, latitude: 28.6, longitude: 77.2, accuracyM: 100 };

async function runCase(c: EvalCase): Promise<EvalRecord> {
  const startedAt = Date.now();
  const record: EvalRecord = {
    id: c.id,
    category: c.category,
    question: c.question,
    expected: { intent: c.intent, source: c.source },
    actual: {
      intent: "",
      source: "",
      text: "",
      tools: [],
      llmUsed: false,
      verificationStatus: "not-run",
      latencyMs: 0,
    },
    pass: false,
    failureReason: null,
  };
  try {
    const tracker = trackingModel(aiService);
    const result = await runPipelineText(
      c.question,
      [...(c.history ?? []), { role: "user", content: c.question }],
      tracker.model,
      {
        clientTools: c.requiresLocation ? { geolocation: DELHI } : undefined,
        includeAwareness: false,
        includeMemory: false,
      }
    );
    const a = record.actual;
    a.intent = result.intent;
    a.source = result.source;
    a.text = result.text;
    a.latencyMs = Date.now() - startedAt;
    a.llmUsed = tracker.llmCalls() > 0;

    for (const event of result.events) {
      if (event.kind === "tool") {
        a.tools.push(event.tool);
        if (event.fallbackReason) a.fallbackReason = event.fallbackReason;
      }
    }
    a.verificationStatus =
      a.intent === c.intent && a.source === c.source ? "verified" : "mismatch";

    record.pass = a.intent === c.intent && a.source === c.source && a.text.length > 0;
    if (c.contains && !c.contains.every((needle) => a.text.includes(needle))) {
      record.pass = false;
    }
    if (!record.pass) {
      record.failureReason = [
        a.intent !== c.intent ? `intent ${a.intent} !== expected ${c.intent}` : null,
        a.source !== c.source ? `source ${a.source} !== expected ${c.source}` : null,
        a.text.length === 0 ? "empty text" : null,
        c.contains && !c.contains.every((needle) => a.text.includes(needle))
          ? `missing substring(s): ${c.contains.filter((n) => !a.text.includes(n)).join(", ")}`
          : null,
        a.fallbackReason ? `fallback: ${a.fallbackReason}` : null,
      ]
        .filter(Boolean)
        .join("; ");
    }
    return record;
  } catch (error) {
    record.actual.error = error instanceof Error ? error.message : String(error);
    record.actual.verificationStatus = "error";
    record.actual.latencyMs = Date.now() - startedAt;
    record.failureReason = `threw: ${record.actual.error}`;
    return record;
  }
}

describe.skipIf(!ENABLED)("baseline eval", () => {
  it(
    "records per-test behavior for the real pipeline",
    async () => {
      const records: EvalRecord[] = [];
      for (const c of CASES) {
        records.push(await runCase(c));
      }

      const outDir = join(process.cwd(), "data", "eval");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "baseline.json"), JSON.stringify({ ranAt: new Date().toISOString(), cases: records }, null, 2));
      writeFileSync(
        join(outDir, "baseline.md"),
        renderMarkdown(records)
      );

      const failures = records.filter((r) => !r.pass);
      const hardFailures = failures.filter((r) => CASES.find((c) => c.id === r.id)?.offlineSafe);
      expect(hardFailures, `offline-safe eval failures:\n${renderFailures(failures)}`).toEqual([]);
    },
    300_000
  );
});

function renderMarkdown(records: EvalRecord[]): string {
  const lines = [
    "# Baseline Eval Report",
    "",
    `Ran at: ${new Date().toISOString()}`,
    "",
    `| id | category | intent (exp/act) | source (exp/act) | tools | llm | status | PASS |`,
    `|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of records) {
    lines.push(
      `| ${r.id} | ${r.category} | ${r.expected.intent}/${r.actual.intent} | ${r.expected.source}/${r.actual.source} | ${r.actual.tools.join(",") || "-"} | ${r.actual.llmUsed} | ${r.actual.verificationStatus} | ${r.pass ? "PASS" : "FAIL"} |`
    );
  }
  lines.push("");
  const failures = records.filter((r) => !r.pass);
  if (failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const f of failures) {
      lines.push(`### ${f.id} — ${f.question}`);
      lines.push(`- Expected: intent=${f.expected.intent} source=${f.expected.source}`);
      lines.push(`- Actual: intent=${f.actual.intent} source=${f.actual.source} status=${f.actual.verificationStatus}`);
      lines.push(`- Text: ${f.actual.text || "(empty)"}`);
      lines.push(`- Reason: ${f.failureReason ?? "n/a"}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function renderFailures(records: EvalRecord[]): string {
  return records
    .filter((r) => !r.pass)
    .map((r) => `  - ${r.id}: ${r.failureReason ?? "no reason"}`)
    .join("\n");
}
