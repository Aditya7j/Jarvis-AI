/**
 * GOLDEN LIVE EVAL — drives the REAL production pipeline end-to-end.
 *
 * NOT a unit suite. Runs every question through `runPipelineText` with the real
 * production model (`aiService`) and the real Tool Router, using the PRODUCTION
 * option defaults (awareness + memory ON — unlike `baseline.test.ts`, which
 * disables both and therefore cannot detect awareness/memory contamination).
 *
 * Per question it records intent, source, text, tools, llm_used and PASS/FAIL
 * into `data/eval/golden.json` + `data/eval/golden.md`, covering the user-
 * mandated categories A (date/time), B (current facts), C (general knowledge),
 * D (math), E (coding), F (casual), G (live info), H (vision).
 *
 * It also runs the EXACT 10-question sequence forward, reversed, and repeated
 * three times, asserting that routing is stable and that deterministic answers
 * (date / date-calc / math) do NOT drift across runs or order — the regression
 * gate against shared-state, memory, awareness or cache contamination.
 *
 * Enable with: `RUN_GOLDEN=1 npx vitest run tests/eval/golden.test.ts`
 * Network/LLM questions need API keys in `.env`; they are recorded and do NOT
 * hard-fail the run. Offline-safe (deterministic) mismatches DO fail the run.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runPipelineText } from "@/services/chat";
import type { PipelineModel } from "@/services/chat";
import { aiService } from "@/lib/ai";
import type { PlanClass } from "@/services/planner";

const ENABLED = process.env.RUN_GOLDEN === "1";
/** GOLDEN_QUICK=1 runs only offline-safe cases + key network probes (fast). */
const QUICK = process.env.GOLDEN_QUICK === "1";
const QUICK_KEEP = new Set(["B1", "C1", "S2", "S5"]);

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

interface GoldenCase {
  id: string;
  category: string;
  question: string;
  intent: PlanClass;
  source: string;
  contains?: string[];
  offlineSafe?: boolean;
}

const A_DATE_TIME: GoldenCase[] = [
  { id: "A1", category: "date", question: "What is today's date?", intent: "date", source: "tool", offlineSafe: true },
  { id: "A2", category: "date", question: "What day is today?", intent: "date", source: "tool", offlineSafe: true },
  { id: "A3", category: "date-calc", question: "What day will 15 August 2026 be?", intent: "date-calc", source: "tool", contains: ["Saturday"], offlineSafe: true },
  { id: "A4", category: "date-calc", question: "What day was 15 August 2025?", intent: "date-calc", source: "tool", contains: ["Friday"], offlineSafe: true },
  { id: "A5", category: "time", question: "What time is it?", intent: "time", source: "tool", offlineSafe: true },
  { id: "A6", category: "time", question: "What time is it in London?", intent: "time", source: "tool", offlineSafe: true },
  { id: "A7", category: "date", question: "What is tomorrow's date?", intent: "date", source: "tool", offlineSafe: true },
  { id: "A8", category: "time", question: "Can you tell me the time right now?", intent: "time", source: "tool", offlineSafe: true },
];

const B_CURRENT_FACTS: GoldenCase[] = [
  { id: "B1", category: "search", question: "Who is the current Prime Minister of India?", intent: "search", source: "tool", contains: ["Modi"] },
  { id: "B2", category: "search", question: "Who is the current President of India?", intent: "search", source: "tool" },
  { id: "B3", category: "search", question: "Who is the current Prime Minister of Canada?", intent: "search", source: "tool" },
  { id: "B4", category: "search", question: "Who is the current President of the USA?", intent: "search", source: "tool" },
];

const C_GENERAL_KNOWLEDGE: GoldenCase[] = [
  { id: "C1", category: "search", question: "What is the capital of India?", intent: "search", source: "tool", contains: ["New Delhi"] },
  { id: "C2", category: "search", question: "Who invented the telephone?", intent: "search", source: "tool", contains: ["Bell"] },
  { id: "C3", category: "search", question: "What is photosynthesis?", intent: "search", source: "tool" },
  { id: "C4", category: "search", question: "What is the largest planet?", intent: "search", source: "tool" },
];

const D_MATH: GoldenCase[] = [
  { id: "D1", category: "math", question: "What is 27 * 43?", intent: "math", source: "tool", contains: ["1161"], offlineSafe: true },
  { id: "D2", category: "math", question: "What is 9999 / 37?", intent: "math", source: "tool", offlineSafe: true },
  { id: "D3", category: "math", question: "What is 25 percent of 80?", intent: "math", source: "tool", contains: ["20"], offlineSafe: true },
  { id: "D4", category: "math", question: "What is the square root of 144?", intent: "math", source: "tool", contains: ["12"], offlineSafe: true },
  { id: "D5", category: "math", question: "If x + 5 = 12, what is x?", intent: "math", source: "tool", offlineSafe: true },
];

const E_CODING: GoldenCase[] = [
  { id: "E1", category: "search", question: "What is a closure in JavaScript?", intent: "search", source: "tool" },
  { id: "E2", category: "search", question: "What is the event loop?", intent: "search", source: "tool" },
  { id: "E3", category: "reasoning", question: "Difference between Promise and async/await", intent: "reasoning", source: "reasoning" },
  { id: "E4", category: "reasoning", question: "Write a JavaScript debounce function", intent: "reasoning", source: "reasoning" },
  { id: "E5", category: "reasoning", question: "Explain Redis", intent: "reasoning", source: "reasoning" },
];

const F_CASUAL: GoldenCase[] = [
  { id: "F1", category: "reasoning", question: "Hey Jarvis", intent: "reasoning", source: "reasoning" },
  { id: "F2", category: "reasoning", question: "Hello", intent: "reasoning", source: "reasoning" },
  { id: "F3", category: "reasoning", question: "How are you?", intent: "reasoning", source: "reasoning" },
  { id: "F4", category: "reasoning", question: "Good morning Jarvis", intent: "reasoning", source: "reasoning" },
];

const G_LIVE: GoldenCase[] = [
  { id: "G1", category: "weather", question: "What is the weather in Delhi?", intent: "weather", source: "tool" },
  { id: "G2", category: "search", question: "Tell me the latest news", intent: "search", source: "tool" },
];

const H_VISION: GoldenCase[] = [
  { id: "H1", category: "vision", question: "Can you see me?", intent: "vision", source: "vision", offlineSafe: true },
  { id: "H2", category: "vision", question: "What am I holding?", intent: "vision", source: "vision", offlineSafe: true },
  { id: "H3", category: "vision", question: "What am I wearing?", intent: "vision", source: "vision", offlineSafe: true },
  { id: "H4", category: "vision", question: "What is on my screen?", intent: "vision", source: "vision", offlineSafe: true },
];

const CASES: GoldenCase[] = [
  ...A_DATE_TIME,
  ...B_CURRENT_FACTS,
  ...C_GENERAL_KNOWLEDGE,
  ...D_MATH,
  ...E_CODING,
  ...F_CASUAL,
  ...G_LIVE,
  ...H_VISION,
].filter((c) => !QUICK || c.offlineSafe || QUICK_KEEP.has(c.id));

/** The exact 10-question sequence the user mandated, in forward order. */
const SEQUENCE_10: GoldenCase[] = [
  { id: "S1", category: "date", question: "What is today's date?", intent: "date", source: "tool", offlineSafe: true },
  { id: "S2", category: "search", question: "Who is the current prime minister of India?", intent: "search", source: "tool", contains: ["Modi"] },
  { id: "S3", category: "math", question: "What is 27 * 43?", intent: "math", source: "tool", contains: ["1161"], offlineSafe: true },
  { id: "S4", category: "reasoning", question: "What is React?", intent: "reasoning", source: "reasoning" },
  { id: "S5", category: "search", question: "What is the capital of Japan?", intent: "search", source: "tool", contains: ["Tokyo"] },
  { id: "S6", category: "date", question: "What is today's date?", intent: "date", source: "tool", offlineSafe: true },
  { id: "S7", category: "search", question: "Who is the current prime minister of India?", intent: "search", source: "tool", contains: ["Modi"] },
  { id: "S8", category: "date-calc", question: "What day will 15 August 2026 be?", intent: "date-calc", source: "tool", contains: ["Saturday"], offlineSafe: true },
  { id: "S9", category: "math", question: "What is 999 * 999?", intent: "math", source: "tool", contains: ["998001"], offlineSafe: true },
  { id: "S10", category: "search", question: "Who invented the telephone?", intent: "search", source: "tool", contains: ["Bell"] },
];

const SEQUENCE = QUICK ? SEQUENCE_10.filter((c) => c.offlineSafe) : SEQUENCE_10;

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

async function runCase(c: GoldenCase): Promise<EvalRecord> {
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
      [{ role: "user", content: c.question }],
      tracker.model,
      {
        clientTools: c.category === "weather" ? { geolocation: DELHI } : undefined,
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

interface SequenceResult {
  order: string;
  run: number;
  records: EvalRecord[];
  stable: boolean;
  drift: Array<{ id: string; question: string; run: number; answer: string }>;
}

/**
 * Runs the exact 10-question sequence. `orders` is e.g. ["forward", "forward",
 * "forward", "reversed"]. Deterministic answers (date/date-calc/math) must be
 * byte-identical across every run; routing (intent+source) must be stable for
 * every question in every run.
 */
async function runSequence(
  cases: GoldenCase[],
  orders: string[],
  firstPass: Map<string, string>
): Promise<SequenceResult[]> {
  const results: SequenceResult[] = [];
  for (let runIdx = 0; runIdx < orders.length; runIdx++) {
    const order = orders[runIdx];
    const seq = order === "reversed" ? [...cases].reverse() : cases;
    const records: EvalRecord[] = [];
    for (const c of seq) {
      records.push(await runCase(c));
    }
    const deterministic = records.filter((r) => ["date", "date-calc", "math"].includes(r.expected.intent));
    const drift: SequenceResult["drift"] = [];
    for (const r of deterministic) {
      const baseline = firstPass.get(r.id);
      if (baseline === undefined) {
        firstPass.set(r.id, r.actual.text);
        continue;
      }
      if (baseline !== r.actual.text) {
        drift.push({ id: r.id, question: r.question, run: runIdx, answer: r.actual.text });
      }
    }
    const routingStable = records.every(
      (r) => r.actual.intent === r.expected.intent && r.actual.source === r.expected.source
    );
    results.push({
      order,
      run: runIdx,
      records,
      stable: routingStable && drift.length === 0,
      drift,
    });
  }
  return results;
}

describe.skipIf(!ENABLED)("golden live eval (production path, awareness+memory ON)", () => {
  it(
    "records per-question behavior across categories A-H",
    async () => {
      const records: EvalRecord[] = [];
      const outDir = join(process.cwd(), "data", "eval");
      mkdirSync(outDir, { recursive: true });
      const writeCheckpoint = (sequence: SequenceResult[] | null): void => {
        writeFileSync(
          join(outDir, "golden.json"),
          JSON.stringify(
            { ranAt: new Date().toISOString(), quick: QUICK, cases: records, sequence },
            null,
            2
          )
        );
        writeFileSync(join(outDir, "golden.md"), renderMarkdown(records, sequence ?? []));
      };
      for (const c of CASES) {
        records.push(await runCase(c));
        writeCheckpoint(null);
      }

      const firstPass = new Map<string, string>();
      const sequence = await runSequence(SEQUENCE, ["forward", "forward", "forward", "reversed"], firstPass);
      writeCheckpoint(sequence);

      const failures = records.filter((r) => !r.pass);
      const hardFailures = failures.filter((r) => CASES.find((c) => c.id === r.id)?.offlineSafe);
      const seqFailures = sequence.filter((s) => !s.stable);
      expect(
        hardFailures,
        `offline-safe golden failures:\n${renderFailures(failures)}\nsequence stability:\n${renderSequenceFailures(seqFailures)}`
      ).toEqual([]);
      expect(seqFailures, "sequence routing/drift failures").toEqual([]);
    },
    1_800_000
  );
});

function renderMarkdown(records: EvalRecord[], sequence: SequenceResult[]): string {
  const lines = [
    "# Golden Live Eval Report",
    "",
    `Ran at: ${new Date().toISOString()}`,
    "",
    "| id | category | intent (exp/act) | source (exp/act) | tools | llm | status | PASS |",
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
  lines.push("## Exact 10-question sequence (forward x3 + reversed)");
  lines.push("");
  for (const s of sequence) {
    lines.push(`### order=${s.order} run=${s.run} — stable: ${s.stable ? "YES" : "NO"}`);
    if (s.drift.length > 0) {
      for (const d of s.drift) {
        lines.push(`- DRIFT ${d.id} (${d.question}) run ${d.run}: "${d.answer}"`);
      }
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

function renderSequenceFailures(results: SequenceResult[]): string {
  return results
    .filter((r) => !r.stable)
    .map(
      (r) =>
        `  - order=${r.order} run=${r.run}: routing/stability broken` +
        (r.drift.length > 0 ? ` — drift on ${r.drift.map((d) => d.id).join(", ")}` : "")
    )
    .join("\n");
}
