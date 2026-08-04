import type { ProviderName } from "@/lib/ai/types";

export type MetricKind =
  | "text"
  | "stream"
  | "tools"
  | "vision"
  | "vision-chat"
  | "camera-frame"
  | "health";

export type MetricStatus = "running" | "ok" | "error" | "timeout" | "aborted";
export type MetricEndStatus = Exclude<MetricStatus, "running">;

/**
 * Optional per-stage latency breakdown (ms). Used by the live vision pipeline:
 * Capture → Encode → Vision → Detect → LLM → Response. Stages that happen
 * client-side (Capture/Encode/Detect) are logged on the client; stages that
 * happen server-side are attached here so the metric page can render them.
 */
export interface MetricStages {
  captureMs?: number;
  encodeMs?: number;
  detectMs?: number;
  visionMs?: number;
  llmMs?: number;
  responseMs?: number;
  [stage: string]: number | undefined;
}

export interface ModelRequestMetric {
  id: string;
  kind: MetricKind;
  provider: ProviderName;
  model: string;
  startedAt: number;
  durationMs: number;
  ttfbMs?: number | null;
  chars?: number | null;
  /** Approximate output tokens. Estimated from chars (≈ chars/4) unless a
   * provider exposes the real count via AttemptEnd.tokens. */
  tokens?: number | null;
  status: MetricStatus;
  errorCode?: string | null;
  message?: string | null;
  stages?: MetricStages | null;
}

export interface AttemptStart {
  id: string;
  kind: MetricKind;
  provider: ProviderName;
  model: string;
  startedAt: number;
}

export interface AttemptEnd {
  id: string;
  status: MetricEndStatus;
  durationMs: number;
  ttfbMs?: number | null;
  chars?: number | null;
  tokens?: number | null;
  errorCode?: string | null;
  message?: string | null;
  stages?: MetricStages | null;
}

export interface SystemMetricsSnapshot {
  /** Live RSS of the Node.js server process (bytes). */
  rssBytes: number | null;
  heapUsedBytes: number | null;
}

export interface ModelAggregate {
  count: number;
  ok: number;
  error: number;
  timeout: number;
  aborted: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  lastAt: number | null;
}

export interface MetricsInsight {
  level: "info" | "warn" | "error";
  text: string;
}

export interface MetricsSnapshot {
  total: number;
  windowMs: number;
  running: ModelRequestMetric[];
  byModel: Record<string, ModelAggregate>;
  byProvider: Record<string, ModelAggregate>;
  recent: ModelRequestMetric[];
  insights: MetricsInsight[];
  system: SystemMetricsSnapshot;
}

interface MetricsStore {
  recent: ModelRequestMetric[];
  active: Map<string, ModelRequestMetric>;
  listeners: Set<(metric: ModelRequestMetric) => void>;
}

const STORE_KEY = "__jarvis_metrics_store__";

/**
 * Next.js App Router compiles each route handler into its own bundle, which
 * means module-scoped singletons are NOT shared between `/api/chat`,
 * `/api/metrics/summary` and `/api/metrics/events`. Metrics recorded by one
 * route were invisible to the others. Attaching the store to `globalThis`
 * (shared per Node.js process) makes every route bundle read/write the same
 * in-memory store, in dev and production.
 */
function getStore(): MetricsStore {
  const g = globalThis as unknown as Record<string, unknown>;
  const existing = g[STORE_KEY] as MetricsStore | undefined;
  if (existing && Array.isArray(existing.recent)) {
    return existing;
  }
  const store: MetricsStore = {
    recent: [],
    active: new Map(),
    listeners: new Set(),
  };
  Object.defineProperty(g, STORE_KEY, {
    value: store,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return store;
}

const MAX_RECENT = 500;
const SUMMARY_WINDOW_MS = 30 * 60_000;

export function attemptStarted(input: AttemptStart): void {
  const store = getStore();
  const metric: ModelRequestMetric = {
    id: input.id,
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    startedAt: input.startedAt,
    durationMs: 0,
    ttfbMs: null,
    chars: null,
    status: "running",
    errorCode: null,
    message: null,
    stages: null,
  };
  store.active.set(input.id, metric);
  broadcast(metric);
}

export function attemptEnded(input: AttemptEnd): void {
  const store = getStore();
  const running = store.active.get(input.id);
  if (!running) return;
  store.active.delete(input.id);
  const metric: ModelRequestMetric = {
    ...running,
    ...input,
    tokens:
      input.tokens ??
      (typeof input.chars === "number" ? Math.round(input.chars / 4) : null),
    stages: input.stages ?? running.stages ?? null,
  };
  store.recent.push(metric);
  if (store.recent.length > MAX_RECENT) store.recent.shift();
  broadcast(metric);
}

export function recentMetrics(): ModelRequestMetric[] {
  return getStore().recent.slice();
}

export function subscribe(
  listener: (metric: ModelRequestMetric) => void
): () => void {
  const store = getStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

function broadcast(metric: ModelRequestMetric): void {
  const store = getStore();
  for (const listener of store.listeners) {
    try {
      listener(metric);
    } catch {
      // A slow or broken SSE listener must never break request instrumentation.
    }
  }
}

function emptyAggregate(): ModelAggregate {
  return {
    count: 0,
    ok: 0,
    error: 0,
    timeout: 0,
    aborted: 0,
    avgMs: 0,
    p95Ms: 0,
    maxMs: 0,
    lastAt: null,
  };
}

function buildAggregate(
  entries: ModelRequestMetric[],
  key: (metric: ModelRequestMetric) => string
): Record<string, ModelAggregate> {
  const result: Record<string, ModelAggregate> = {};
  const durations: Record<string, number[]> = {};
  for (const metric of entries) {
    const groupKey = key(metric);
    const agg = result[groupKey] ?? (result[groupKey] = emptyAggregate());
    (durations[groupKey] ??= []).push(metric.durationMs);
    agg.count += 1;
    if (metric.status === "ok") agg.ok += 1;
    else if (metric.status === "error") agg.error += 1;
    else if (metric.status === "timeout") agg.timeout += 1;
    else if (metric.status === "aborted") agg.aborted += 1;
    agg.maxMs = Math.max(agg.maxMs, metric.durationMs);
    agg.lastAt = Math.max(agg.lastAt ?? 0, metric.startedAt);
  }
  for (const groupKey of Object.keys(result)) {
    const agg = result[groupKey];
    const sorted = (durations[groupKey] ?? []).sort((a, b) => a - b);
    agg.avgMs = sorted.length
      ? Math.round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length)
      : 0;
    agg.p95Ms = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
      : 0;
  }
  return result;
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function buildInsights(
  entries: ModelRequestMetric[],
  byModel: Record<string, ModelAggregate>
): MetricsInsight[] {
  const insights: MetricsInsight[] = [];
  if (entries.length === 0) {
    insights.push({
      level: "info",
      text: "No AI requests recorded yet. Send a message or analyze a camera frame and it will appear here in realtime.",
    });
    return insights;
  }
  for (const [model, agg] of Object.entries(byModel)) {
    if (agg.error > 0) {
      insights.push({
        level: "error",
        text: `${model}: ${agg.error} failed request(s). Check the server logs for the error codes.`,
      });
    }
    if (agg.timeout > 0) {
      insights.push({
        level: "warn",
        text: `${model}: ${agg.timeout} timed-out request(s). Raise AI_VISION_TIMEOUT_MS (vision) or AI_REQUEST_TIMEOUT_MS (text) in .env.`,
      });
    }
    if (agg.aborted > 0) {
      insights.push({
        level: "warn",
        text: `${model}: ${agg.aborted} aborted request(s) — stale vision analysis was cancelled by newer input. Normal under rapid camera use.`,
      });
    }
    if (agg.count > 0 && agg.avgMs > 20_000) {
      insights.push({
        level: "warn",
        text: `${model}: slow (avg ${formatMs(agg.avgMs)}, p95 ${formatMs(agg.p95Ms)}). CPU-bound Ollama inference is the bottleneck — the live vision cache skips unchanged frames.`,
      });
    } else if (agg.count > 0 && agg.avgMs < 2_000) {
      insights.push({
        level: "info",
        text: `${model}: fast (avg ${formatMs(agg.avgMs)}).`,
      });
    }
  }
  return insights;
}

function getSystemMetrics(): SystemMetricsSnapshot {
  if (typeof process === "undefined" || !process.memoryUsage) {
    return { rssBytes: null, heapUsedBytes: null };
  }
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const store = getStore();
  const cutoff = Date.now() - SUMMARY_WINDOW_MS;
  const windowed = store.recent.filter((metric) => metric.startedAt >= cutoff);
  const running = Array.from(store.active.values())
    .filter((metric) => metric.startedAt >= cutoff)
    .sort((a, b) => a.startedAt - b.startedAt);
  const byModel = buildAggregate(windowed, (metric) => metric.model);
  const byProvider = buildAggregate(windowed, (metric) => metric.provider);
  const recentEvents = windowed
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)
    .slice(-100)
    .reverse();
  return {
    total: windowed.length,
    windowMs: SUMMARY_WINDOW_MS,
    running,
    byModel,
    byProvider,
    recent: recentEvents,
    insights: buildInsights(windowed, byModel),
    system: getSystemMetrics(),
  };
}
