import type { VisionImage } from "@/lib/ai/types";
import { useVisionStore } from "@/stores/vision-store";

const PREVIEW_REFRESH_MS = 3000;
const CAPTURE_INTERVAL_MS = 1000;
const MAX_CAPTURE_DIMENSION = 640;
const CAPTURE_READY_TIMEOUT_MS = 2000;

export interface VisionFrame {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
}

let webcamStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let captureTimer: number | null = null;
let captureVideo: HTMLVideoElement | null = null;
let captureCanvas: HTMLCanvasElement | null = null;
let webcamFrame: VisionFrame | null = null;
let screenFrame: VisionFrame | null = null;
let lastPreviewAt = 0;

function getStore() {
  return useVisionStore.getState();
}

function getStreamForSource(source: "webcam" | "screen"): MediaStream | null {
  return source === "webcam" ? webcamStream : screenStream;
}

function getActiveSources(): Array<"webcam" | "screen"> {
  const sources: Array<"webcam" | "screen"> = [];
  if (webcamStream) sources.push("webcam");
  if (screenStream) sources.push("screen");
  return sources;
}

function getActiveSource(): "webcam" | "screen" | null {
  if (webcamStream) return "webcam";
  if (screenStream) return "screen";
  return null;
}

function isAnyActive(): boolean {
  return webcamStream !== null || screenStream !== null;
}

function setCaptureTimer() {
  if (captureTimer !== null) return;
  captureTimer = window.setInterval(() => {
    if (!isAnyActive()) {
      window.clearInterval(captureTimer!);
      captureTimer = null;
      return;
    }
    if (
      typeof document === "undefined" ||
      document.visibilityState !== "visible"
    ) {
      return;
    }
    void tickCapture();
  }, CAPTURE_INTERVAL_MS);
}

function stopCaptureTimer() {
  if (captureTimer !== null) {
    window.clearInterval(captureTimer);
    captureTimer = null;
  }
}

async function tickCapture() {
  try {
    const sources = getActiveSources();
    for (const source of sources) {
      const frame = await captureFrame(source);
      if (frame) cacheFrame(source, frame);
    }
    const primary = sources[0];
    const primaryFrame = primary === "webcam" ? webcamFrame : screenFrame;
    if (primaryFrame && Date.now() - lastPreviewAt >= PREVIEW_REFRESH_MS) {
      lastPreviewAt = Date.now();
      getStore().setLastCapturedFrame(primaryFrame.dataUrl);
    }
  } catch (error) {
    console.warn("[CAM] Capture tick failed:", error);
  }
}

function cacheFrame(source: "webcam" | "screen", frame: VisionFrame) {
  if (source === "webcam") {
    webcamFrame = frame;
  } else {
    screenFrame = frame;
  }
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= CAPTURE_READY_TIMEOUT_MS) {
        resolve();
        return;
      }
      window.setTimeout(check, 100);
    };
    check();
  });
}

async function captureFrame(
  source?: "webcam" | "screen"
): Promise<VisionFrame | null> {
  const target = source ?? getActiveSource();
  if (!target) return null;
  const stream = getStreamForSource(target);
  if (!stream || typeof document === "undefined") return null;
  const video = captureVideo ?? (captureVideo = document.createElement("video"));
  video.muted = true;
  video.playsInline = true;
  if (video.srcObject !== stream) {
    video.srcObject = stream;
    try {
      await video.play();
    } catch {
      // autoplay may be blocked until user gesture; frame stays unready
    }
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    await waitForFrame(video);
  }
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  const scale = Math.min(
    1,
    MAX_CAPTURE_DIMENSION / Math.max(video.videoWidth, video.videoHeight)
  );
  const width = Math.max(1, Math.round(video.videoWidth * scale));
  const height = Math.max(1, Math.round(video.videoHeight * scale));
  const canvas = captureCanvas ?? (captureCanvas = document.createElement("canvas"));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
  return {
    dataUrl,
    mimeType: "image/jpeg",
    width,
    height,
  };
}

function toVisionImage(
  source: "webcam" | "screen",
  frame: VisionFrame
): VisionImage {
  const comma = frame.dataUrl.indexOf(",");
  return {
    data: comma >= 0 ? frame.dataUrl.slice(comma + 1) : frame.dataUrl,
    mimeType: frame.mimeType,
    source,
  };
}

function getVisionFrames(): VisionImage[] {
  const frames: VisionImage[] = [];
  if (webcamFrame) frames.push(toVisionImage("webcam", webcamFrame));
  if (screenFrame) frames.push(toVisionImage("screen", screenFrame));
  return frames;
}

async function startWebcam(): Promise<boolean> {
  const store = getStore();
  try {
    console.info("[CAM] Requesting webcam stream...");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: "user" },
    });
    webcamStream = stream;
    store.setWebcamStream(stream);
    store.setWebcamActive(true);
    store.setVisionError(null);
    console.info(`[CAM] Webcam stream acquired (${stream.getTracks().length} tracks)`);
    setCaptureTimer();
    void tickCapture();
    return true;
  } catch (error) {
    console.error("[CAM] Webcam error:", error);
    webcamStream = null;
    store.setWebcamStream(null);
    store.setWebcamActive(false);
    store.setVisionError("Could not access the camera. Check permissions and try again.");
    return false;
  }
}

async function startScreenShare(): Promise<boolean> {
  const store = getStore();
  try {
    console.info("[CAM] Requesting screen share stream...");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1920, height: 1080 },
    });
    screenStream = stream;
    store.setScreenStream(stream);
    store.setScreenShareActive(true);
    store.setVisionError(null);
    console.info(`[CAM] Screen stream acquired (${stream.getTracks().length} tracks)`);
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      console.info("[CAM] Screen share ended by user");
      stopScreenShare();
    });
    setCaptureTimer();
    void tickCapture();
    return true;
  } catch (error) {
    console.error("[CAM] Screen share error:", error);
    store.setVisionError("Screen share was cancelled or failed.");
    return false;
  }
}

function stopWebcam() {
  const store = getStore();
  if (webcamStream) {
    webcamStream.getTracks().forEach((track) => track.stop());
    webcamStream = null;
    webcamFrame = null;
    store.setWebcamStream(null);
    store.setWebcamActive(false);
    console.info("[CAM] Webcam stopped, tracks released");
  }
  if (!isAnyActive()) {
    stopCaptureTimer();
    screenFrame = null;
    store.setLastCapturedFrame(null);
  }
}

function stopScreenShare() {
  const store = getStore();
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
    screenFrame = null;
    store.setScreenStream(null);
    store.setScreenShareActive(false);
    console.info("[CAM] Screen share stopped, tracks released");
  }
  if (!isAnyActive()) {
    stopCaptureTimer();
    webcamFrame = null;
    store.setLastCapturedFrame(null);
  }
}

function stopAll() {
  stopWebcam();
  stopScreenShare();
}

export const visionService = {
  startWebcam,
  startScreenShare,
  stopWebcam,
  stopScreenShare,
  stopAll,
  captureFrame,
  isAnyActive,
  getVisionFrames,
};
