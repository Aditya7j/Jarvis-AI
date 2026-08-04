import type { VisionImage } from "@/lib/ai/types";
import { useVisionStore } from "@/stores/vision-store";
import { reportClientStats } from "@/lib/metrics/client-stats";
import type { CameraFrame, CameraSource, CameraStats, FrameListener } from "./types";
import { applyEnhancements } from "./enhance";

const STATS_REPORT_INTERVAL_MS = 500;

const MAX_CAPTURE_DIMENSION = 640;
const MAX_ANALYSIS_DIMENSION = 1920;
const MAX_LIVE_DIMENSION = 960;
const WEBCAM_CAPTURE_INTERVAL_MS = 1000;
const SCREEN_CAPTURE_INTERVAL_MS = 700;
const JPEG_QUALITY = 0.6;
const ANALYSIS_JPEG_QUALITY = 0.85;
const LIVE_JPEG_QUALITY = 0.75;
const ENCODE_TIMEOUT_MS = 3000;
const CAPTURE_READY_TIMEOUT_MS = 3000;
const FRAME_HISTORY_LIMIT = 5;
/** Center-weighted crop keeps the middle of the frame and biases toward the
 * user's hands (lower-center) for live object detection. */
const CENTER_FOCUS_FRACTION = 0.72;
const CENTER_FOCUS_DOWN_SHIFT = 0.04;
const WEBCAM_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: "user",
};
const SCREEN_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
};

type EncodingMode = "worker" | "main" | "pending";

interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EncodeRequest {
  type: "encode";
  source: CameraSource;
  frame: VideoFrame;
  width: number;
  height: number;
  quality: number;
  crop?: CropRegion | null;
  encodeId: number;
}

interface WorkerFrameMessage {
  type: "frame";
  source: CameraSource;
  bytes: ArrayBuffer;
  width: number;
  height: number;
  encodeId: number;
  encodeMs?: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function toVisionImage(source: CameraSource, frame: CameraFrame): VisionImage {
  const comma = frame.dataUrl.indexOf(",");
  return {
    data: comma >= 0 ? frame.dataUrl.slice(comma + 1) : frame.dataUrl,
    mimeType: frame.mimeType,
    source,
  };
}

class CameraService {
  private webcamStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private videos: Partial<Record<CameraSource, HTMLVideoElement>> = {};
  private rvfcHandles: Partial<Record<CameraSource, number>> = {};
  private fallbackTimers: Partial<Record<CameraSource, number>> = {};
  private latest: Partial<Record<CameraSource, CameraFrame>> = {};
  private history: Partial<Record<CameraSource, CameraFrame[]>> = {};
  private frameListeners = new Set<FrameListener>();
  private stats: Record<CameraSource, CameraStats> = {
    webcam: { mode: "main", fps: 0, frames: 0, active: false, lastCaptureAt: 0, latestBytes: 0 },
    screen: { mode: "main", fps: 0, frames: 0, active: false, lastCaptureAt: 0, latestBytes: 0 },
  };
  private lastStatsReportAt = 0;
  private lastCaptureAt: Record<CameraSource, number> = { webcam: 0, screen: 0 };
  private frameTimes: Partial<Record<CameraSource, number>> = {};
  private encodingInFlight: Record<CameraSource, boolean> = { webcam: false, screen: false };
  private encodeIds: Partial<Record<CameraSource, number>> = {};
  private encodeSeq = 0;
  private pendingEncodes = new Map<
    number,
    { resolve: (frame: CameraFrame) => void; reject: (error: Error) => void; source: CameraSource }
  >();
  private worker: Worker | null = null;
  private workerMode: EncodingMode = "pending";
  private captureCanvas: HTMLCanvasElement | null = null;
  private analysisCanvas: HTMLCanvasElement | null = null;
  private visibilityPaused = false;
  private visibilityHandler: (() => void) | null = null;
  private pageHideHandler: (() => void) | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.installPageHideHandler();
    }
  }

  private supportsWorkerEncoding(): boolean {
    if (typeof window === "undefined") return false;
    return (
      typeof Worker !== "undefined" &&
      typeof OffscreenCanvas !== "undefined" &&
      typeof VideoFrame !== "undefined" &&
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype
    );
  }

  private tryCreateWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL("./frame-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = this.handleWorkerMessage;
      worker.onerror = (event) => {
        console.warn("[CAM] Worker error:", event.message || event.type);
        this.terminateWorker();
        this.workerMode = "main";
        for (const source of this.getActiveSources()) {
          this.cancelRvf(source);
          this.stats[source].mode = "main";
          this.startFallbackCapture(source);
        }
      };
      this.worker = worker;
      return worker;
    } catch (error) {
      console.warn("[CAM] Worker unavailable; using main-thread capture:", error);
      return null;
    }
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, pending] of this.pendingEncodes) {
      pending.reject(new Error("Encode worker terminated"));
    }
    this.pendingEncodes.clear();
  }

  private useWorkerEncoding(): boolean {
    if (this.workerMode === "main") return false;
    if (this.workerMode === "worker") return true;
    if (!this.supportsWorkerEncoding()) {
      this.workerMode = "main";
      return false;
    }
    const worker = this.tryCreateWorker();
    if (worker) {
      this.workerMode = "worker";
      return true;
    }
    this.workerMode = "main";
    return false;
  }

  private getVideo(source: CameraSource): HTMLVideoElement {
    let video = this.videos[source];
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("aria-hidden", "true");
      this.videos[source] = video;
    }
    return video;
  }

  private scaledDimensions(videoWidth: number, videoHeight: number): { width: number; height: number } {
    const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(videoWidth, videoHeight));
    return {
      width: Math.max(1, Math.round(videoWidth * scale)),
      height: Math.max(1, Math.round(videoHeight * scale)),
    };
  }

  private analysisScaledDimensions(videoWidth: number, videoHeight: number): { width: number; height: number } {
    const scale = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(videoWidth, videoHeight));
    return {
      width: Math.max(1, Math.round(videoWidth * scale)),
      height: Math.max(1, Math.round(videoHeight * scale)),
    };
  }

  private liveScaledDimensions(videoWidth: number, videoHeight: number): { width: number; height: number } {
    const scale = Math.min(1, MAX_LIVE_DIMENSION / Math.max(videoWidth, videoHeight));
    return {
      width: Math.max(1, Math.round(videoWidth * scale)),
      height: Math.max(1, Math.round(videoHeight * scale)),
    };
  }

  /** Center-weighted crop region in source pixel coordinates. */
  private centerFocusCrop(videoWidth: number, videoHeight: number): CropRegion {
    const cropW = Math.max(1, Math.round(videoWidth * CENTER_FOCUS_FRACTION));
    const cropH = Math.max(1, Math.round(videoHeight * CENTER_FOCUS_FRACTION));
    const x = Math.max(0, Math.round((videoWidth - cropW) / 2));
    const y = Math.max(
      0,
      Math.min(videoHeight - cropH, Math.round((videoHeight - cropH) / 2 + videoHeight * CENTER_FOCUS_DOWN_SHIFT))
    );
    return { x, y, width: cropW, height: cropH };
  }

  private intervalFor(source: CameraSource): number {
    return source === "screen" ? SCREEN_CAPTURE_INTERVAL_MS : WEBCAM_CAPTURE_INTERVAL_MS;
  }

  private attachStream(source: CameraSource, stream: MediaStream): void {
    const video = this.getVideo(source);
    video.muted = true;
    video.playsInline = true;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    void video.play().catch(() => {
      // autoplay may be blocked until user gesture; capture waits for readiness
    });
    this.beginCapture(source);
  }

  private beginCapture(source: CameraSource): void {
    this.installVisibilityHandler();
    const workerEncoding = this.useWorkerEncoding();
    this.stats[source].mode = workerEncoding ? "worker" : "main";
    if (workerEncoding) {
      this.startRvfCapture(source);
    } else {
      this.startFallbackCapture(source);
    }
  }

  private startRvfCapture(source: CameraSource): void {
    if (this.rvfcHandles[source] !== undefined) return;
    const video = this.getVideo(source);
    const loop = () => {
      if (!this.isSourceActive(source) || this.workerMode === "main") {
        this.rvfcHandles[source] = undefined;
        return;
      }
      this.attemptWorkerCapture(source);
      const handle = video.requestVideoFrameCallback(loop);
      this.rvfcHandles[source] = handle;
    };
    const handle = video.requestVideoFrameCallback(loop);
    this.rvfcHandles[source] = handle;
  }

  private cancelRvf(source: CameraSource): void {
    const handle = this.rvfcHandles[source];
    if (handle !== undefined) {
      try {
        this.videos[source]?.cancelVideoFrameCallback(handle);
      } catch {
        // ignore: browser may not expose cancellation for detached videos
      }
      this.rvfcHandles[source] = undefined;
    }
  }

  private attemptWorkerCapture(source: CameraSource): void {
    if (!this.isSourceActive(source) || this.visibilityPaused) return;
    const video = this.getVideo(source);
    if (this.encodingInFlight[source]) return;
    const now = performance.now();
    if (now - this.lastCaptureAt[source] < this.intervalFor(source)) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
    const { width, height } = this.scaledDimensions(video.videoWidth, video.videoHeight);
    let worker = this.worker;
    if (!worker) {
      worker = this.tryCreateWorker();
      if (!worker) {
        this.fallbackToMain(source);
        return;
      }
    }
    try {
      const frame = new VideoFrame(video, { timestamp: video.currentTime * 1e6 });
      this.lastCaptureAt[source] = now;
      this.encodingInFlight[source] = true;
      const encodeId = ++this.encodeSeq;
      this.encodeIds[source] = encodeId;
      const request: EncodeRequest = {
        type: "encode",
        source,
        frame,
        width,
        height,
        quality: JPEG_QUALITY,
        encodeId,
      };
      worker.postMessage(request, [frame]);
      window.setTimeout(() => {
        if (this.encodeIds[source] === encodeId) {
          this.encodingInFlight[source] = false;
        }
      }, ENCODE_TIMEOUT_MS);
    } catch (error) {
      console.warn("[CAM] VideoFrame capture failed; falling back to main-thread encoding:", error);
      this.encodingInFlight[source] = false;
      this.fallbackToMain(source);
    }
  }

  private fallbackToMain(source: CameraSource): void {
    this.workerMode = "main";
    this.cancelRvf(source);
    this.terminateWorker();
    this.stats[source].mode = "main";
    this.startFallbackCapture(source);
  }

  private startFallbackCapture(source: CameraSource): void {
    if (this.fallbackTimers[source] !== undefined) return;
    this.fallbackTimers[source] = window.setInterval(() => {
      this.attemptMainCapture(source);
    }, this.intervalFor(source));
  }

  private attemptMainCapture(source: CameraSource): void {
    if (!this.isSourceActive(source) || this.visibilityPaused) return;
    const video = this.getVideo(source);
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
    const frame = this.captureFromVideo(source, video);
    if (frame) this.cacheAndNotify(source, frame);
  }

  private captureFromVideo(
    source: CameraSource,
    video: HTMLVideoElement,
    options?: {
      width?: number;
      height?: number;
      crop?: CropRegion | null;
      quality?: number;
      canvas?: HTMLCanvasElement | null;
    }
  ): CameraFrame | null {
    const { width, height } = this.scaledDimensions(video.videoWidth, video.videoHeight);
    const targetWidth = options?.width ?? width;
    const targetHeight = options?.height ?? height;
    const quality = options?.quality ?? JPEG_QUALITY;
    const crop = options?.crop ?? null;
    const canvas = options?.canvas ?? this.captureCanvas ?? (this.captureCanvas = document.createElement("canvas"));
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const captureStart = performance.now();
    if (crop) {
      ctx.drawImage(
        video,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        targetWidth,
        targetHeight
      );
    } else {
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
    }
    applyEnhancements(ctx, targetWidth, targetHeight);
    const captureMs = performance.now() - captureStart;
    const encodeStart = performance.now();
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const encodeMs = performance.now() - encodeStart;
    console.info(
      `[CAM] frame ${targetWidth}x${targetHeight} · capture ${captureMs.toFixed(1)}ms · encode ${encodeMs.toFixed(1)}ms`
    );
    return {
      source,
      dataUrl,
      mimeType: "image/jpeg",
      width: targetWidth,
      height: targetHeight,
      capturedAt: Date.now(),
    };
  }

  private handleWorkerMessage = (event: MessageEvent<WorkerFrameMessage>): void => {
    const message = event.data;
    if (message.type !== "frame") return;
    const bytes = new Uint8Array(message.bytes);
    const frame: CameraFrame = {
      source: message.source,
      dataUrl: `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
      mimeType: "image/jpeg",
      width: message.width,
      height: message.height,
      capturedAt: Date.now(),
    };
    if (message.encodeMs !== undefined) {
      console.info(
        `[CAM] worker encode ${message.width}x${message.height} · ${message.encodeMs.toFixed(1)}ms`
      );
    }
    const pending = this.pendingEncodes.get(message.encodeId);
    if (pending) {
      this.pendingEncodes.delete(message.encodeId);
      if (message.source !== pending.source) {
        pending.reject(new Error("Live frame source mismatch"));
        return;
      }
      pending.resolve(frame);
      return;
    }
    this.encodingInFlight[message.source] = false;
    this.cacheAndNotify(message.source, frame);
  };

  private cacheAndNotify(source: CameraSource, frame: CameraFrame): void {
    this.latest[source] = frame;
    const history = this.history[source] ?? [];
    if (!history.some((f) => f.capturedAt === frame.capturedAt)) {
      history.push(frame);
      if (history.length > FRAME_HISTORY_LIMIT) history.shift();
      this.history[source] = history;
    }
    const stat = this.stats[source];
    stat.active = true;
    stat.frames += 1;
    stat.lastCaptureAt = Date.now();
    stat.latestBytes = Math.round(frame.dataUrl.length * 0.75);
    const now = performance.now();
    const previous = this.frameTimes[source];
    if (previous !== undefined) {
      const elapsed = (now - previous) / 1000;
      if (elapsed > 0) {
        const instant = 1 / elapsed;
        stat.fps = stat.fps === 0 ? instant : stat.fps * 0.7 + instant * 0.3;
      }
    }
    this.frameTimes[source] = now;
    if (now - this.lastStatsReportAt >= STATS_REPORT_INTERVAL_MS) {
      this.lastStatsReportAt = now;
      reportClientStats({ fps: stat.fps, frameBytes: stat.latestBytes });
    }
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch (error) {
        console.warn("[CAM] Frame listener error:", error);
      }
    }
  }

  private installVisibilityHandler(): void {
    if (this.visibilityHandler) return;
    this.visibilityHandler = () => {
      this.visibilityPaused =
        typeof document !== "undefined" && document.visibilityState !== "visible";
      if (!this.visibilityPaused) {
        this.lastCaptureAt.webcam = 0;
        this.lastCaptureAt.screen = 0;
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.visibilityHandler();
  }

  private removeVisibilityHandler(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private installPageHideHandler(): void {
    if (this.pageHideHandler) return;
    this.pageHideHandler = () => {
      this.worker?.terminate();
      this.worker = null;
      this.workerMode = "pending";
    };
    window.addEventListener("pagehide", this.pageHideHandler);
  }

  private isSourceActive(source: CameraSource): boolean {
    return source === "webcam" ? this.webcamStream !== null : this.screenStream !== null;
  }

  private getActiveSources(): CameraSource[] {
    const sources: CameraSource[] = [];
    if (this.webcamStream) sources.push("webcam");
    if (this.screenStream) sources.push("screen");
    return sources;
  }

  getActiveSource(): CameraSource | null {
    if (this.webcamStream) return "webcam";
    if (this.screenStream) return "screen";
    return null;
  }

  private resetStats(source: CameraSource): void {
    const stat = this.stats[source];
    stat.fps = 0;
    stat.frames = 0;
    stat.lastCaptureAt = 0;
    stat.active = false;
    this.frameTimes[source] = undefined;
    this.encodeIds[source] = undefined;
  }

  private stopCapture(source: CameraSource): void {
    this.cancelRvf(source);
    const timer = this.fallbackTimers[source];
    if (timer !== undefined) {
      window.clearInterval(timer);
      this.fallbackTimers[source] = undefined;
    }
    this.encodingInFlight[source] = false;
    this.lastCaptureAt[source] = 0;
    const video = this.videos[source];
    if (video) {
      video.srcObject = null;
      try {
        video.pause();
      } catch {
        // ignore: element may already be inactive
      }
      this.videos[source] = undefined;
    }
  }

  private maybeTeardown(): void {
    if (this.isActive()) return;
    this.removeVisibilityHandler();
    this.terminateWorker();
    this.captureCanvas = null;
    this.analysisCanvas = null;
  }

  startWebcam = async (): Promise<boolean> => {
    if (this.webcamStream) return true;
    const store = useVisionStore.getState();
    try {
      console.info("[CAM] Requesting webcam stream...");
      const stream = await navigator.mediaDevices.getUserMedia({ video: WEBCAM_CONSTRAINTS });
      this.webcamStream = stream;
      this.attachStream("webcam", stream);
      store.setWebcamStream(stream);
      store.setWebcamActive(true);
      store.setVisionError(null);
      console.info(`[CAM] Webcam stream acquired (${stream.getTracks().length} tracks)`);
      return true;
    } catch (error) {
      console.error("[CAM] Webcam error:", error);
      this.webcamStream = null;
      store.setWebcamStream(null);
      store.setWebcamActive(false);
      store.setVisionError("Could not access the camera. Check permissions and try again.");
      return false;
    }
  };

  startScreenShare = async (): Promise<boolean> => {
    if (this.screenStream) return true;
    const store = useVisionStore.getState();
    try {
      console.info("[CAM] Requesting screen share stream...");
      const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_CONSTRAINTS);
      this.screenStream = stream;
      this.attachStream("screen", stream);
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        console.info("[CAM] Screen share ended by user");
        this.stopScreenShare();
      });
      store.setScreenStream(stream);
      store.setScreenShareActive(true);
      store.setVisionError(null);
      console.info(`[CAM] Screen stream acquired (${stream.getTracks().length} tracks)`);
      return true;
    } catch (error) {
      console.error("[CAM] Screen share error:", error);
      store.setVisionError("Screen share was cancelled or failed.");
      return false;
    }
  };

  stopWebcam = (): void => {
    this.stopCapture("webcam");
    const stream = this.webcamStream;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      console.info("[CAM] Webcam stopped, tracks released");
    }
    this.webcamStream = null;
    this.latest.webcam = undefined;
    this.history.webcam = undefined;
    this.resetStats("webcam");
    const store = useVisionStore.getState();
    store.setWebcamStream(null);
    store.setWebcamActive(false);
    this.maybeTeardown();
  };

  stopScreenShare = (): void => {
    this.stopCapture("screen");
    const stream = this.screenStream;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      console.info("[CAM] Screen share stopped, tracks released");
    }
    this.screenStream = null;
    this.latest.screen = undefined;
    this.history.screen = undefined;
    this.resetStats("screen");
    const store = useVisionStore.getState();
    store.setScreenStream(null);
    store.setScreenShareActive(false);
    this.maybeTeardown();
  };

  stopAll = (): void => {
    this.stopWebcam();
    this.stopScreenShare();
  };

  captureFrame = async (sourceArg?: CameraSource | null): Promise<CameraFrame | null> => {
    const source = sourceArg ?? this.getActiveSource();
    if (!source || !this.isSourceActive(source)) return null;
    const video = this.getVideo(source);
    await this.waitReady(video);
    if (video.videoWidth === 0 || video.videoHeight === 0) return null;
    const frame = this.captureFromVideo(source, video);
    if (frame) this.cacheAndNotify(source, frame);
    return frame;
  };

  /**
   * Capture a full-resolution, high-quality frame for on-demand vision analysis
   * (Gemma 3). Unlike the live loop (max 960px center crop), this waits for the
   * video to be fully loaded and encodes at up to 1920px @ 85% JPEG so small
   * objects and details survive. Does not touch the preview history/latest
   * buffers.
   */
  captureAnalysisFrame = async (
    sourceArg?: CameraSource | null
  ): Promise<CameraFrame | null> => {
    const source = sourceArg ?? this.getActiveSource();
    if (!source || !this.isSourceActive(source)) return null;
    const video = this.getVideo(source);
    const ready = await this.waitAnalysisReady(video);
    if (!ready) return null;
    const { width, height } = this.analysisScaledDimensions(
      video.videoWidth,
      video.videoHeight
    );
    const captureStart = performance.now();
    const frame = this.captureFromVideo(source, video, {
      width,
      height,
      quality: ANALYSIS_JPEG_QUALITY,
      canvas: this.analysisCanvas ?? (this.analysisCanvas = document.createElement("canvas")),
    });
    if (frame) {
      console.info(
        `[CAM] analysis frame ${width}x${height} · total ${(performance.now() - captureStart).toFixed(1)}ms`
      );
    }
    return frame;
  };

  /**
   * Fast, non-blocking live capture for the continuous vision pipeline.
   * Encodes a center-weighted crop (prioritizes the middle of the frame and the
   * user's hands) at up to 960px @ 75% JPEG, off the main thread when a worker
   * is available. Returns immediately when the video is not ready so the caller
   * can skip this tick.
   */
  captureLiveFrame = async (
    sourceArg?: CameraSource | null
  ): Promise<CameraFrame | null> => {
    const source = sourceArg ?? this.getActiveSource();
    if (!source || !this.isSourceActive(source)) return null;
    const video = this.getVideo(source);
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
      return null;
    }
    const { width, height } = this.liveScaledDimensions(video.videoWidth, video.videoHeight);
    const crop = this.centerFocusCrop(video.videoWidth, video.videoHeight);

    if (this.useWorkerEncoding()) {
      const worker = this.worker;
      if (worker) {
        return await new Promise<CameraFrame>((resolve, reject) => {
          try {
            const frame = new VideoFrame(video, { timestamp: video.currentTime * 1e6 });
            const encodeId = ++this.encodeSeq;
            this.pendingEncodes.set(encodeId, { resolve, reject, source });
            const request: EncodeRequest = {
              type: "encode",
              source,
              frame,
              width,
              height,
              quality: LIVE_JPEG_QUALITY,
              crop,
              encodeId,
            };
            worker.postMessage(request, [frame]);
            window.setTimeout(() => {
              if (this.pendingEncodes.has(encodeId)) {
                this.pendingEncodes.delete(encodeId);
                reject(new Error("Live frame encode timed out"));
              }
            }, ENCODE_TIMEOUT_MS);
          } catch (error) {
            reject(error);
          }
        });
      }
    }

    return this.captureFromVideo(source, video, {
      width,
      height,
      crop,
      quality: LIVE_JPEG_QUALITY,
    });
  };

  private async waitAnalysisReady(video: HTMLVideoElement): Promise<boolean> {
    const ready = (): boolean =>
      video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;
    if (ready()) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < CAPTURE_READY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (ready()) return true;
    }
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      console.warn(
        "[CAM] Analysis capture timed out waiting for HAVE_ENOUGH_DATA; using available frame"
      );
      return true;
    }
    return false;
  }

  private async waitReady(video: HTMLVideoElement): Promise<void> {
    if (video.videoWidth > 0 && video.videoHeight > 0) return;
    const startedAt = Date.now();
    while (video.videoWidth === 0 && Date.now() - startedAt < CAPTURE_READY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  getLatestFrame = (source: CameraSource): CameraFrame | null => this.latest[source] ?? null;

  /**
   * Return the most recent captured frames for a source, newest first. Used to
   * attach up to the last few live frames to a vision request.
   */
  getRecentFrames = (source: CameraSource, max: number): CameraFrame[] => {
    const history = this.history[source] ?? [];
    return history.slice(-max).reverse();
  };

  getStream = (source: CameraSource): MediaStream | null =>
    source === "webcam" ? this.webcamStream : this.screenStream;

  getVisionFrames = (): VisionImage[] => {
    const frames: VisionImage[] = [];
    const webcam = this.latest.webcam;
    if (webcam) frames.push(toVisionImage("webcam", webcam));
    const screen = this.latest.screen;
    if (screen) frames.push(toVisionImage("screen", screen));
    return frames;
  };

  isActive = (): boolean => this.webcamStream !== null || this.screenStream !== null;

  subscribeFrames = (listener: FrameListener): (() => void) => {
    this.frameListeners.add(listener);
    return () => {
      this.frameListeners.delete(listener);
    };
  };

  getStats = (source: CameraSource): CameraStats => ({ ...this.stats[source] });

  getCapabilities = (): { workerEncoding: boolean; mode: "worker" | "main" } => ({
    workerEncoding: this.supportsWorkerEncoding(),
    mode: this.workerMode === "worker" ? "worker" : "main",
  });

  formatStats = (source: CameraSource): string => {
    const stat = this.stats[source];
    const frame = this.latest[source];
    const size = frame ? `${frame.width}×${frame.height}` : "—";
    const mode = this.workerMode === "worker" ? "worker" : "main";
    return `${stat.fps.toFixed(1)} FPS · ${size} · ${mode} encode`;
  };
}

export const cameraService = new CameraService();
