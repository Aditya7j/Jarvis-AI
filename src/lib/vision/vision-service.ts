import { cameraService } from "@/lib/camera";
import type { CameraSource } from "@/lib/camera";
import type { VisionImage } from "@/lib/ai/types";
import { useVisionStore } from "@/stores/vision-store";
import type { LiveVisionResult } from "./live-vision-engine";
import type { VisionStateSnapshot } from "./vision-state";
import { liveVisionSession } from "./live-vision-session";

export interface VisionFrame {
  source: CameraSource;
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  capturedAt: number;
}

/** Client-side mirror of the server engine's LIVE_VISION_STALE_MS. */
const LIVE_RESULT_STALE_MS = 1000;
const LIVE_RESULT_TTL_MS = 5000;

export const visionService = {
  startWebcam: (): Promise<boolean> => cameraService.startWebcam(),
  startScreenShare: (): Promise<boolean> => cameraService.startScreenShare(),
  stopWebcam: (): void => cameraService.stopWebcam(),
  stopScreenShare: (): void => cameraService.stopScreenShare(),
  stopAll: (): void => cameraService.stopAll(),
  captureFrame: (source?: CameraSource): Promise<VisionFrame | null> =>
    cameraService.captureFrame(source),
  captureAnalysisFrame: (source?: CameraSource): Promise<VisionFrame | null> =>
    cameraService.captureAnalysisFrame(source),
  getActiveSource: (): CameraSource | null => cameraService.getActiveSource(),
  getRecentFrames: (source: CameraSource, max: number): VisionFrame[] =>
    cameraService.getRecentFrames(source, max),
  isAnyActive: (): boolean => cameraService.isActive(),
  getVisionFrames: (): VisionImage[] => cameraService.getVisionFrames(),

  startLiveVision: (): void => liveVisionSession.start(),
  stopLiveVision: (): void => liveVisionSession.stop(),

  /** Latest analyzed frame from the persistent live session, if any. */
  getLiveResult: (source?: CameraSource): LiveVisionResult | null => {
    const result = useVisionStore.getState().latestLiveResult;
    if (!result) return null;
    if (source && result.source !== source) return null;
    return result;
  },

  /** True when the latest live analysis is fresh enough to answer immediately. */
  isLiveResultFresh: (source: CameraSource): boolean => {
    const result = useVisionStore.getState().latestLiveResult;
    if (!result) return false;
    if (result.source !== source) return false;
    if (result.state !== "live" || !result.summary || !result.systemContext) {
      return false;
    }
    const now = Date.now();
    if (now - result.analyzedAt > LIVE_RESULT_TTL_MS) return false;
    if (now - result.capturedAt > LIVE_RESULT_STALE_MS) return false;
    return true;
  },

  getLiveAnalyzing: (): boolean => useVisionStore.getState().liveAnalyzing,

  /** Latest continuous YOLO vision-state snapshot (objects, people, colours). */
  getLiveVisionState: (): VisionStateSnapshot | null =>
    useVisionStore.getState().latestVisionState,
};
