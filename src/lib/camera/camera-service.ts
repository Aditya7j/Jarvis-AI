import type { VisionImage } from "@/lib/ai/types";
import { useVisionStore } from "@/stores/vision-store";
import type { CameraFrame, CameraSource, CameraStats, FrameListener } from "./types";

const MAX_CAPTURE_DIMENSION = 640;
const WEBCAM_CAPTURE_INTERVAL_MS = 1000;
const SCREEN_CAPTURE_INTERVAL_MS = 700;
const JPEG_QUALITY = 0.6;
const ENCODE_TIMEOUT_MS = 3000;
const CAPTURE_READY_TIMEOUT_MS = 3000;
const WEBCAM_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: "user",
};
const SCREEN_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
};

type EncodingMode = "worker" | "main" | "pending";

interface EncodeRequest {
  type: "encode";
  source: CameraSource;
  frame: VideoFrame;
  width: number;
  height: number;
  quality: number;
}

interface WorkerFrameMessage {
  type: "frame";
  source: CameraSource;
  bytes: ArrayBuffer;
  width: number;
  height: number;
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
  private frameListeners = new Set<FrameListener>();
  private stats: Record<CameraSource, CameraStats> = {
    webcam: { mode: "main", fps: 0, frames: 0, active: false, lastCaptureAt: 0 },
    screen: { mode: "main", fps: 0, frames: 0, active: false, lastCaptureAt: 0 },
  };
  private lastCaptureAt: Record<CameraSource, number> = { webcam: 0, screen: 0 };
  private frameTimes: Partial<Record<CameraSource, number>> = {};
  private encodingInFlight: Record<CameraSource, boolean> = { webcam: false, screen: false };
  private encodeIds: Partial<Record<CameraSource, number>> = {};
  private worker: Worker | null = null;
  private workerMode: EncodingMode = "pending";
  private captureCanvas: HTMLCanvasElement | null = null;
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
      const encodeId = (this.encodeIds[source] = (this.encodeIds[source] ?? 0) + 1);
      const request: EncodeRequest = {
        type: "encode",
        source,
        frame,
        width,
        height,
        quality: JPEG_QUALITY,
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

  private captureFromVideo(source: CameraSource, video: HTMLVideoElement): CameraFrame | null {
    const { width, height } = this.scaledDimensions(video.videoWidth, video.videoHeight);
    const canvas = this.captureCanvas ?? (this.captureCanvas = document.createElement("canvas"));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return { source, dataUrl, mimeType: "image/jpeg", width, height, capturedAt: Date.now() };
  }

  private handleWorkerMessage = (event: MessageEvent<WorkerFrameMessage>): void => {
    const message = event.data;
    if (message.type !== "frame") return;
    this.encodingInFlight[message.source] = false;
    const bytes = new Uint8Array(message.bytes);
    const frame: CameraFrame = {
      source: message.source,
      dataUrl: `data:image/jpeg;base64,${bytesToBase64(bytes)}`,
      mimeType: "image/jpeg",
      width: message.width,
      height: message.height,
      capturedAt: Date.now(),
    };
    this.cacheAndNotify(message.source, frame);
  };

  private cacheAndNotify(source: CameraSource, frame: CameraFrame): void {
    this.latest[source] = frame;
    const stat = this.stats[source];
    stat.active = true;
    stat.frames += 1;
    stat.lastCaptureAt = Date.now();
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

  private getActiveSource(): CameraSource | null {
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

  private async waitReady(video: HTMLVideoElement): Promise<void> {
    if (video.videoWidth > 0 && video.videoHeight > 0) return;
    const startedAt = Date.now();
    while (video.videoWidth === 0 && Date.now() - startedAt < CAPTURE_READY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  getLatestFrame = (source: CameraSource): CameraFrame | null => this.latest[source] ?? null;

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
