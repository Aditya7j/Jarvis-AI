/**
 * Per-request waterfall tracer.
 *
 * Records the start/end of every stage in one chat request so the dominant
 * latency bottleneck is visible per request. Stages are named in the audit
 * contract (request_received, language_detection, planner, memory_lookup,
 * context_build, tool_execution, vision_cache_lookup, yolo, gemma,
 * llm_first_token, llm_complete, postprocess, sse_first_byte, sse_complete).
 *
 * The tracer is cheap (timestamp writes only) and lives on a module-level
 * "current request" slot, mirroring the existing per-process singletons
 * (vision state, live-vision engine, active vision controller). The pipeline
 * sets the slot on entry and clears it in `finish`, so every exit path resets
 * it.
 */

export type WaterfallStageName =
  | "request_received"
  | "language_detection"
  | "planner"
  | "memory_lookup"
  | "context_build"
  | "tool_execution"
  | "vision_cache_lookup"
  | "yolo"
  | "gemma"
  | "llm_first_token"
  | "llm_complete"
  | "postprocess"
  | "sse_first_byte"
  | "sse_complete";

export interface WaterfallCounts {
  /** Number of reasoning-model (LLM) calls. */
  llmCalls: number;
  /** Number of tool executions. */
  toolCalls: number;
  /** Number of vision resolutions attempted. */
  visionCalls: number;
  /** Number of long-term memory lookups. */
  memoryCalls: number;
  /** Number of Gemma 3 frame analyses. */
  gemmaCalls: number;
  /** Number of on-demand YOLO pipeline runs. */
  yoloRuns: number;
}

export interface WaterfallStage {
  name: WaterfallStageName | string;
  startedAt: number;
  endedAt: number | null;
  /** Wall-clock duration once the stage has ended. */
  durationMs: number | null;
}

export interface WaterfallTrace {
  requestId: string;
  startedAt: number;
  endedAt: number | null;
  stages: WaterfallStage[];
  counts: WaterfallCounts;
  promptChars: number;
  responseChars: number;
  firstTokenAt: number | null;
  /** Cumulative time spent inside LLM streaming. */
  llmMs: number;
  /** Cumulative time spent inside tool execution. */
  toolMs: number;
  /** Cumulative time spent inside vision (Gemma + YOLO). */
  visionMs: number;
}

export interface Waterfall {
  mark: (name: WaterfallStageName | string) => void;
  end: (name: WaterfallStageName | string) => void;
  addResponse: (chars: number) => void;
  setFirstToken: () => void;
  count: (key: keyof WaterfallCounts) => void;
  addLlm: (ms: number) => void;
  addTool: (ms: number) => void;
  addVision: (ms: number) => void;
  snapshot: () => WaterfallTrace;
}

export function createWaterfall(
  requestId: string,
  startedAt: number,
  promptChars: number
): Waterfall {
  const counts: WaterfallCounts = {
    llmCalls: 0,
    toolCalls: 0,
    visionCalls: 0,
    memoryCalls: 0,
    gemmaCalls: 0,
    yoloRuns: 0,
  };
  const stages: WaterfallStage[] = [];
  let responseChars = 0;
  let firstTokenAt: number | null = null;
  let endedAt: number | null = null;
  let llmMs = 0;
  let toolMs = 0;
  let visionMs = 0;

  function findStage(name: string): WaterfallStage | undefined {
    for (let i = stages.length - 1; i >= 0; i--) {
      if (stages[i].name === name) return stages[i];
    }
    return undefined;
  }

  return {
    mark(name) {
      stages.push({ name, startedAt: Date.now(), endedAt: null, durationMs: null });
    },
    end(name) {
      const stage = findStage(name);
      if (!stage) return;
      stage.endedAt = Date.now();
      stage.durationMs = stage.endedAt - stage.startedAt;
    },
    addResponse(chars) {
      responseChars += chars;
    },
    setFirstToken() {
      if (firstTokenAt === null) firstTokenAt = Date.now();
    },
    count(key) {
      counts[key] += 1;
    },
    addLlm(ms) {
      llmMs += ms;
    },
    addTool(ms) {
      toolMs += ms;
    },
    addVision(ms) {
      visionMs += ms;
    },
    snapshot() {
      endedAt = Date.now();
      return {
        requestId,
        startedAt,
        endedAt,
        stages: stages.map((stage) => ({ ...stage })),
        counts: { ...counts },
        promptChars,
        responseChars,
        firstTokenAt,
        llmMs,
        toolMs,
        visionMs,
      };
    },
  };
}

let current: Waterfall | null = null;

/** The waterfall of the in-flight pipeline request, if any. */
export function getCurrentWaterfall(): Waterfall | null {
  return current;
}

export function setCurrentWaterfall(waterfall: Waterfall | null): void {
  current = waterfall;
}

function pct(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/**
 * Compact one-line render of the trace for structured logging: total latency,
 * TTFT, per-stage durations and call counts.
 */
export function formatWaterfall(trace: WaterfallTrace): Record<string, unknown> {
  const total = trace.endedAt !== null ? trace.endedAt - trace.startedAt : null;
  const stageDurations: Record<string, number> = {};
  for (const stage of trace.stages) {
    if (stage.durationMs !== null) {
      stageDurations[stage.name] = Math.round(stage.durationMs);
    }
  }
  const sorted = trace.stages
    .filter((stage) => stage.durationMs !== null)
    .map((stage) => stage.durationMs as number)
    .sort((a, b) => a - b);
  return {
    requestId: trace.requestId,
    totalMs: total,
    ttftMs: trace.firstTokenAt !== null ? trace.firstTokenAt - trace.startedAt : null,
    llmMs: Math.round(trace.llmMs),
    toolMs: Math.round(trace.toolMs),
    visionMs: Math.round(trace.visionMs),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
    stages: stageDurations,
    counts: trace.counts,
    promptChars: trace.promptChars,
    responseChars: trace.responseChars,
  };
}
