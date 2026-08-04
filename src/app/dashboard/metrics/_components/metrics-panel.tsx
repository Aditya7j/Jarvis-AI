"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Radio, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  MetricsInsight,
  MetricsSnapshot,
  MetricKind,
  ModelRequestMetric,
} from "@/lib/metrics/metrics";

const STATUS_STYLES: Record<ModelRequestMetric["status"], string> = {
  running: "text-blue-400 bg-blue-500/10 border-blue-500/30",
  ok: "text-green-400 bg-green-500/10 border-green-500/30",
  error: "text-red-400 bg-red-500/10 border-red-500/30",
  timeout: "text-yellow-400 bg-yellow-500/10 border-yellow-500/30",
  aborted: "text-white/40 bg-white/[0.06] border-white/10",
};

const KIND_LABELS: Record<MetricKind, string> = {
  text: "text",
  stream: "stream",
  tools: "tools",
  vision: "vision",
  "vision-chat": "vision-chat",
  "camera-frame": "camera",
  health: "health",
};

const INSIGHT_STYLES: Record<MetricsInsight["level"], string> = {
  info: "text-blue-400 bg-blue-500/[0.06] border-blue-500/20",
  warn: "text-yellow-400 bg-yellow-500/[0.06] border-yellow-500/20",
  error: "text-red-400 bg-red-500/[0.06] border-red-500/20",
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function formatCount(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function Card({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-4">
      <p className="text-[10px] uppercase tracking-widest text-white/30">
        {label}
      </p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", accent)}>
        {value}
      </p>
    </div>
  );
}

export function MetricsPanel() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [events, setEvents] = useState<ModelRequestMetric[]>([]);
  const [hideHealth, setHideHealth] = useState(false);
  const eventsRef = useRef(new Map<string, ModelRequestMetric>());

  useEffect(() => {
    let mounted = true;
    fetch("/api/metrics/summary")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: MetricsSnapshot | null) => {
        if (!mounted || !data) return;
        setSnapshot(data);
        const map = new Map<string, ModelRequestMetric>();
        for (const metric of data.recent) map.set(metric.id, metric);
        eventsRef.current = map;
        setEvents(
          Array.from(map.values()).sort(
            (a, b) => b.startedAt - a.startedAt
          )
        );
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/metrics/events");
    const onMetric = (event: MessageEvent) => {
      try {
        const metric = JSON.parse(event.data) as ModelRequestMetric;
        const map = eventsRef.current;
        map.set(metric.id, metric);
        if (map.size > 120) {
          const evict = [...map.entries()]
            .filter(([, m]) => m.status !== "running")
            .sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
          if (evict) map.delete(evict[0]);
        }
        setEvents(
          Array.from(map.values()).sort((a, b) => b.startedAt - a.startedAt)
        );
      } catch {
        // Ignore malformed SSE frames.
      }
    };
    source.addEventListener("metric", onMetric);
    return () => {
      source.removeEventListener("metric", onMetric);
      source.close();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/metrics/summary")
        .then((res) => (res.ok ? res.json() : null))
        .then((data: MetricsSnapshot | null) => {
          if (data) setSnapshot(data);
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const visible = useMemo(
    () => (hideHealth ? events.filter((e) => e.kind !== "health") : events),
    [events, hideHealth]
  );

  const ended = useMemo(
    () => visible.filter((e) => e.status !== "running"),
    [visible]
  );

  const avgLatency = ended.length
    ? Math.round(ended.reduce((sum, e) => sum + e.durationMs, 0) / ended.length)
    : 0;
  const failed = ended.filter(
    (e) => e.status === "error" || e.status === "timeout"
  ).length;
  const runningCount = visible.filter((e) => e.status === "running").length;

  const byModelRows = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(snapshot.byModel)
      .map(([model, agg]) => ({ model, ...agg }))
      .sort((a, b) => b.count - a.count);
  }, [snapshot]);

  const byProviderRows = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(snapshot.byProvider)
      .map(([provider, agg]) => ({ provider, ...agg }))
      .sort((a, b) => b.count - a.count);
  }, [snapshot]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card label="Requests (30m)" value={String(snapshot?.total ?? 0)} accent="text-white" />
        <Card
          label="In flight"
          value={String(snapshot?.running.length ?? runningCount)}
          accent="text-blue-400"
        />
        <Card label="Avg latency" value={formatCount(avgLatency)} accent="text-green-400" />
        <Card label="Errors + timeouts" value={String(failed)} accent={failed ? "text-red-400" : "text-white"} />
      </div>

      <section className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-4">
        <h2 className="mb-3 text-[10px] uppercase tracking-widest text-white/30 flex items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5" />
          Insights — what to improve
        </h2>
        {(snapshot?.insights ?? []).length === 0 ? (
          <p className="text-xs text-white/30">Collecting data…</p>
        ) : (
          <ul className="space-y-2">
            {(snapshot?.insights ?? []).map((insight, index) => (
              <li
                key={index}
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs",
                  INSIGHT_STYLES[insight.level]
                )}
              >
                {insight.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-4">
          <h2 className="mb-3 text-[10px] uppercase tracking-widest text-white/30">
            By model
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-white/30">
                  <th className="pb-2 pr-3 font-medium">Model</th>
                  <th className="pb-2 pr-3 font-medium text-right">Req</th>
                  <th className="pb-2 pr-3 font-medium text-right">Ok</th>
                  <th className="pb-2 pr-3 font-medium text-right">Err</th>
                  <th className="pb-2 pr-3 font-medium text-right">Avg</th>
                  <th className="pb-2 pr-3 font-medium text-right">P95</th>
                  <th className="pb-2 font-medium text-right">Max</th>
                </tr>
              </thead>
              <tbody className="text-white/60">
                {byModelRows.map((row) => (
                  <tr key={row.model} className="border-t border-white/[0.03]">
                    <td className="py-2 pr-3 font-mono">{row.model}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.count}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-green-400">{row.ok}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-red-400">{row.error + row.timeout}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCount(row.avgMs)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatCount(row.p95Ms)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCount(row.maxMs)}</td>
                  </tr>
                ))}
                {byModelRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-3 text-white/30">
                      No requests recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-4">
          <h2 className="mb-3 text-[10px] uppercase tracking-widest text-white/30">
            By provider
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-white/30">
                  <th className="pb-2 pr-3 font-medium">Provider</th>
                  <th className="pb-2 pr-3 font-medium text-right">Req</th>
                  <th className="pb-2 pr-3 font-medium text-right">Ok</th>
                  <th className="pb-2 pr-3 font-medium text-right">Err</th>
                  <th className="pb-2 pr-3 font-medium text-right">Timeout</th>
                  <th className="pb-2 font-medium text-right">Aborted</th>
                </tr>
              </thead>
              <tbody className="text-white/60">
                {byProviderRows.map((row) => (
                  <tr key={row.provider} className="border-t border-white/[0.03]">
                    <td className="py-2 pr-3 capitalize">{row.provider}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{row.count}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-green-400">{row.ok}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-red-400">{row.error}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-yellow-400">{row.timeout}</td>
                    <td className="py-2 text-right tabular-nums text-white/40">{row.aborted}</td>
                  </tr>
                ))}
                {byProviderRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-3 text-white/30">
                      No requests recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-white/[0.05] bg-white/[0.02] p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[10px] uppercase tracking-widest text-white/30 flex items-center gap-2">
            <Radio className="w-3.5 h-3.5" />
            Live request log
          </h2>
          <label className="flex items-center gap-2 text-xs text-white/40 cursor-pointer">
            <input
              type="checkbox"
              checked={hideHealth}
              onChange={(event) => setHideHealth(event.target.checked)}
              className="accent-blue-500"
            />
            Hide health checks
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-white/30">
                <th className="pb-2 pr-3 font-medium">Time</th>
                <th className="pb-2 pr-3 font-medium">Kind</th>
                <th className="pb-2 pr-3 font-medium">Provider</th>
                <th className="pb-2 pr-3 font-medium">Model</th>
                <th className="pb-2 pr-3 font-medium text-right">Duration</th>
                <th className="pb-2 pr-3 font-medium text-right">TTFB</th>
                <th className="pb-2 pr-3 font-medium">Status</th>
                <th className="pb-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="text-white/60">
              {visible.slice(0, 60).map((metric) => (
                <tr key={metric.id} className="border-t border-white/[0.03]">
                  <td className="py-2 pr-3 tabular-nums whitespace-nowrap">
                    {formatTime(metric.startedAt)}
                  </td>
                  <td className="py-2 pr-3">
                    <span className="px-1.5 py-0.5 rounded bg-white/[0.05] text-white/50">
                      {KIND_LABELS[metric.kind]}
                    </span>
                  </td>
                  <td className="py-2 pr-3 capitalize">{metric.provider}</td>
                  <td className="py-2 pr-3 font-mono">{metric.model}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {metric.status === "running" ? "…" : formatMs(metric.durationMs)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {metric.status === "running" ? "…" : formatMs(metric.ttfbMs)}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                        STATUS_STYLES[metric.status]
                      )}
                    >
                      {metric.status === "running" && (
                        <Activity className="w-2.5 h-2.5 animate-pulse" />
                      )}
                      {metric.status}
                    </span>
                  </td>
                  <td className="py-2 text-white/40 max-w-[220px] truncate">
                    {metric.status === "ok"
                      ? metric.chars !== null && metric.chars !== undefined
                        ? `${metric.chars} chars`
                        : "—"
                      : metric.errorCode
                        ? `${metric.errorCode}${metric.message ? ` — ${metric.message}` : ""}`
                        : "—"}
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-white/30">
                    Waiting for AI requests… send a message or analyze a camera
                    frame to see live activity.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
