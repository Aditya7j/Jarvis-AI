import { cameraService } from "@/lib/camera";
import type { CameraSource } from "@/lib/camera";
import { useVisionStore } from "@/stores/vision-store";
import type { LiveVisionResult } from "./live-vision-engine";
import type { VisionStateSnapshot } from "./vision-state";
import {
  getLiveState,
  startLiveSession,
  stopLiveSession,
  submitLiveFrame,
} from "./live-vision-client";
import { frameFingerprint } from "./frame-diff";

/**
 * Persistent live-vision capture loop, active while the camera is ON.
 *
 * Every CAPTURE_INTERVAL_MS it grabs a fast live frame (960px center crop) and
 * POSTs it to the server engine only when the scene actually changed, so the
 * server always analyzes the newest frame and never builds a job queue. The
 * server keeps the latest analyzed frame + object detections; this loop polls
 * it so the UI and the chat fast-path can read partial/current results without
 * waiting on Gemma 3.
 */
const CAPTURE_INTERVAL_MS = 350;
const MIN_SUBMIT_GAP_MS = 250;
const FORCE_RESYNC_MS = 2000;

class LiveVisionSession {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFingerprint = "";
  private lastSubmitAt = 0;
  private lastPollAt = 0;

  start(): void {
    if (this.running) return;
    const source = cameraService.getActiveSource();
    if (!source) return;
    this.running = true;
    void startLiveSession(source).catch(() => {});
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void stopLiveSession().catch(() => {});
    const store = useVisionStore.getState();
    store.setLatestLiveResult(null);
    store.setLiveAnalyzing(false);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), CAPTURE_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const source = cameraService.getActiveSource();
    if (!source) {
      this.stop();
      return;
    }
    try {
      const captureStart = performance.now();
      const frame = await cameraService.captureLiveFrame(source);
      if (frame) {
        const captureMs = performance.now() - captureStart;
        const now = Date.now();
        const fingerprint = frameFingerprint(frame.dataUrl);
        if (
          fingerprint !== this.lastFingerprint &&
          now - this.lastSubmitAt >= MIN_SUBMIT_GAP_MS
        ) {
          this.lastFingerprint = fingerprint;
          this.lastSubmitAt = now;
          const response = await submitLiveFrame({
            image: frame.dataUrl,
            mimeType: frame.mimeType,
            source: frame.source,
            width: frame.width,
            height: frame.height,
            capturedAt: frame.capturedAt,
            captureMs,
          });
          if (response) {
            this.apply(response.result, response.analyzing, response.vision);
          }
        }
      }
    } catch (error) {
      console.warn("[LIVE-VISION] tick failed:", error);
    }
    if (Date.now() - this.lastPollAt >= FORCE_RESYNC_MS) {
      this.lastPollAt = Date.now();
      try {
        const state = await getLiveState(source);
        if (state) this.apply(state.result, state.analyzing, state.vision);
      } catch {
        // ignore transient poll errors
      }
    }
    this.schedule();
  }

  private apply(
    result: LiveVisionResult | null,
    analyzing: boolean,
    vision?: VisionStateSnapshot | null
  ): void {
    const store = useVisionStore.getState();
    if (result?.summary) store.setLastAnalysis(result.summary);
    store.setLatestLiveResult(result);
    store.setLatestVisionState(vision ?? null);
    store.setLiveAnalyzing(analyzing);
  }
}

export const liveVisionSession = new LiveVisionSession();
