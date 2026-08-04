/**
 * Context Engine — JARVIS's live awareness core.
 *
 * Maintains a continuously-updated snapshot of the environment without waiting
 * for prompts: OS facts are re-collected on a background timer, browser
 * telemetry is applied as the client reports it, and the verified system clock
 * plus a brief visual-scene summary are folded in. New information replaces old
 * information — old frames/facts are never reprocessed.
 *
 * The singleton lives on `globalThis` because Next.js App Router compiles every
 * route handler into its own bundle, and all bundles must share one live state.
 */

import { aiLogger } from "@/lib/ai/logger";
import { getSystemClock, type SystemClockFact } from "@/lib/ai/system-tools";
import { getVisionStateStore } from "@/lib/vision/vision-state";
import { collectSystemSnapshot } from "./system-collector";
import type {
  AwarenessSnapshot,
  ClientTelemetry,
  SystemSnapshot,
  VisionSceneBrief,
} from "./types";

const DEFAULT_POLL_MS = 5_000;

interface ContextEngineState {
  server: SystemSnapshot | null;
  client: ClientTelemetry | null;
  lastCollectedAt: number;
}

interface EngineHandle {
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
  getAwareness: () => AwarenessSnapshot;
  applyClientTelemetry: (telemetry: ClientTelemetry | null | undefined) => void;
  setPollInterval: (ms: number) => void;
}

function visionSceneBrief(): VisionSceneBrief | null {
  const state = getVisionStateStore().getState();
  if (!state || state.timestamp === 0) return null;
  const seen = new Set<string>();
  for (const object of Object.values(state.latestObjects)) {
    if (seen.size >= 8) break;
    seen.add(object.label);
  }
  return {
    visibleObjects: [...seen],
    peopleCount: state.latestPeople.length,
    heldObject: state.heldObject?.label ?? null,
    capturedAt: state.timestamp,
  };
}

function buildAwareness(
  state: ContextEngineState,
  clock: SystemClockFact
): AwarenessSnapshot {
  return {
    collectedAt: Date.now(),
    server: state.server,
    client: state.client,
    time: {
      iso: clock.iso,
      unixMs: clock.unixMs,
      timezone: clock.timezone,
      formatted: clock.formatted,
    },
    vision: visionSceneBrief(),
  };
}

class ContextEngine implements EngineHandle {
  private state: ContextEngineState = { server: null, client: null, lastCollectedAt: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollMs = DEFAULT_POLL_MS;
  private running = false;
  private readonly log = aiLogger.child("context");

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.collect();
    this.timer = setInterval(() => void this.collect(), this.pollMs);
    this.log.info("Context Engine started", { pollMs: this.pollMs });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("Context Engine stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  setPollInterval(ms: number): void {
    this.pollMs = Math.max(1_000, ms);
  }

  private async collect(): Promise<void> {
    try {
      const snapshot = await collectSystemSnapshot();
      if (snapshot) {
        this.state.server = snapshot;
        this.state.lastCollectedAt = snapshot.collectedAt;
      }
    } catch (error) {
      this.log.warn("System collection failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  applyClientTelemetry(telemetry: ClientTelemetry | null | undefined): void {
    if (!telemetry) return;
    // Never let stale telemetry overwrite newer data.
    const existing = this.state.client;
    if (existing && telemetry.reportedAt < existing.reportedAt) return;
    this.state.client = telemetry;
  }

  getAwareness(): AwarenessSnapshot {
    return buildAwareness(this.state, getSystemClock());
  }
}

const globalContext = globalThis as unknown as {
  __jarvis_context_engine__?: ContextEngine;
};

export function getContextEngine(): EngineHandle {
  if (!globalContext.__jarvis_context_engine__) {
    globalContext.__jarvis_context_engine__ = new ContextEngine();
  }
  return globalContext.__jarvis_context_engine__;
}

export const contextEngine = getContextEngine();
