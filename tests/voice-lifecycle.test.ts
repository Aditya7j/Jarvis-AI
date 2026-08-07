/**
 * Voice session lifecycle regression suite.
 *
 * The voice pipeline must never hear itself (TTS must pause STT), must never
 * freeze with a dead mic, must keep exactly one recognition session, and must
 * auto-reconnect after a session ends. These tests drive the pure
 * `VoiceSessionController` with faked recognition sessions and faked timers so
 * the whole suite is deterministic and offline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VoiceSessionController,
  type VoiceEvent,
  type RecognitionLike,
  type RecognitionResultEventLike,
} from "@/lib/voice/lifecycle";

class FakeRecognition implements RecognitionLike {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionResultEventLike) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  started = false;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  start(): void {
    this.startCalls += 1;
    this.started = true;
    this.onstart?.();
  }

  stop(): void {
    this.stopCalls += 1;
    this.started = false;
    this.onend?.();
  }

  abort(): void {
    this.abortCalls += 1;
    this.started = false;
    this.onend?.();
  }

  emitInterim(transcript: string): void {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript } }],
    });
  }

  emitFinal(transcript: string): void {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript } }],
    });
  }
}

function setup() {
  const recognitions: FakeRecognition[] = [];
  const events: VoiceEvent[] = [];
  const onFinal = vi.fn();
  const onInterim = vi.fn();
  const onError = vi.fn();
  const controller = new VoiceSessionController({
    createRecognition: () => {
      const rec = new FakeRecognition();
      recognitions.push(rec);
      return rec;
    },
    onFinal,
    onInterim,
    onError,
  });
  controller.subscribe((event) => events.push(event));
  return { controller, recognitions, events, onFinal, onInterim, onError };
}

function startedCount(recognitions: FakeRecognition[]): number {
  return recognitions.filter((r) => r.started).length;
}

describe("voice session lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps exactly one live recognition session at a time", () => {
    const { controller, recognitions } = setup();
    controller.start();
    controller.start();
    controller.start();
    expect(recognitions).toHaveLength(1);
    expect(startedCount(recognitions)).toBe(1);

    recognitions[0].stop();
    expect(recognitions).toHaveLength(1);
    vi.advanceTimersByTime(300);
    expect(recognitions).toHaveLength(2);
    expect(startedCount(recognitions)).toBe(1);
  });

  it("pauses STT while the assistant speaks and never turns it into a command", () => {
    const { controller, recognitions, events, onFinal } = setup();
    controller.start();

    controller.pause("assistant speaking");
    expect(controller.isPaused).toBe(true);
    expect(recognitions[0].stopCalls).toBeGreaterThanOrEqual(1);

    // While paused, no reconnect happens (mic stays off during TTS).
    vi.advanceTimersByTime(60_000);
    expect(recognitions).toHaveLength(1);

    // Even a late transcript (simulating heard TTS audio) must be dropped.
    recognitions[0].emitFinal("hey jarvis what is the weather");
    recognitions[0].emitFinal("the weather today is warm and sunny");
    expect(onFinal).not.toHaveBeenCalled();
    expect(events.filter((e) => e.name === "VOICE_PAUSED").length).toBe(1);
  });

  it("resumes STT with a fresh session after the assistant finishes speaking", () => {
    const { controller, recognitions, onFinal, events } = setup();
    controller.start();

    controller.pause("assistant speaking");
    controller.resume();

    expect(controller.isPaused).toBe(false);
    expect(recognitions).toHaveLength(2);
    expect(recognitions[1].started).toBe(true);
    expect(events.some((e) => e.name === "VOICE_RESUMED")).toBe(true);

    recognitions[1].emitFinal("hello jarvis");
    expect(onFinal).toHaveBeenCalledWith("hello jarvis");
  });

  it("auto-reconnects when a session ends on its own (RECONNECTING)", () => {
    const { controller, recognitions, events } = setup();
    controller.start();

    recognitions[0].onend?.();
    expect(events.some((e) => e.name === "RECONNECTING")).toBe(true);

    vi.advanceTimersByTime(300);
    expect(recognitions).toHaveLength(2);
    expect(recognitions[1].started).toBe(true);
  });

  it("recovers a wedged session that stops emitting events (no mic freeze)", () => {
    const { controller, recognitions, events } = setup();
    controller.start();

    // Simulate a session that silently dies: no onend, no onresult, no error.
    vi.advanceTimersByTime(20_000);
    expect(events.some((e) => e.name === "RECORDING_RESTARTED")).toBe(true);
    expect(recognitions.length).toBeGreaterThanOrEqual(2);
    expect(recognitions[recognitions.length - 1].started).toBe(true);

    // The watchdog keeps recovering across repeated stalls, never freezing.
    vi.advanceTimersByTime(20_000);
    expect(recognitions.length).toBeGreaterThanOrEqual(3);
    expect(recognitions[recognitions.length - 1].started).toBe(true);
  });

  it("recovers when a session starts but never fires onstart", () => {
    const { controller, recognitions, events } = setup();
    controller.start();
    const active = recognitions[0];
    active.onstart = null; // the browser never signals mic start

    expect(events.some((e) => e.name === "RECORDING_RESTARTED")).toBe(false);
    vi.advanceTimersByTime(3_500);
    expect(events.some((e) => e.name === "RECORDING_RESTARTED")).toBe(true);
    expect(recognitions.length).toBeGreaterThanOrEqual(2);
    expect(recognitions[recognitions.length - 1].started).toBe(true);
  });

  it("runs 20 consecutive turns without self-trigger or mic freeze", () => {
    const { controller, recognitions, onFinal } = setup();
    controller.start();

    for (let turn = 0; turn < 20; turn++) {
      const session = recognitions[recognitions.length - 1];
      session.emitFinal(`turn ${turn} user command`);

      // JARVIS replies: STT pauses, so its own voice cannot be captured.
      controller.pause("assistant speaking");
      vi.advanceTimersByTime(5_000);

      // Heard TTS audio arrives as transcripts — must not become commands.
      session.emitFinal("turn 20 summary here is your answer");
      session.emitFinal("the weather today is warm and sunny");

      // TTS finishes: STT resumes with a fresh session for the next turn.
      controller.resume();
      vi.advanceTimersByTime(1_000);

      expect(controller.isPaused).toBe(false);
      const next = recognitions[recognitions.length - 1];
      expect(next.started).toBe(true);
      expect(startedCount(recognitions)).toBe(1);
    }

    expect(recognitions.length).toBeGreaterThanOrEqual(20);
    // Every captured command was real user input — none came from echo.
    expect(
      onFinal.mock.calls.some(([text]) => String(text).includes("summary"))
    ).toBe(false);
  });

  it("emits timestamped lifecycle logs for every transition", () => {
    const { controller, recognitions, events } = setup();
    controller.start();
    controller.pause("assistant speaking");
    controller.resume();
    recognitions[recognitions.length - 1].onend?.();
    vi.advanceTimersByTime(300);

    const names = events.map((e) => e.name);
    expect(names).toContain("VOICE_SESSION_START");
    expect(names).toContain("STT_STARTED");
    expect(names).toContain("MIC_STARTED");
    expect(names).toContain("VOICE_PAUSED");
    expect(names).toContain("VOICE_RESUMED");
    expect(names).toContain("MIC_STOPPED");
    expect(names).toContain("RECONNECTING");

    for (const event of events) {
      expect(Number.isFinite(new Date(event.timestamp).getTime())).toBe(true);
    }
  });
});
