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

  /**
   * True when the latest live analysis is fresh enough to answer immediately.
   * The live loop feeds the Scene Cache (vision state), not an LLM result, so
   * freshness is judged on the cached scene rather than a `systemContext`.
   */
  isLiveResultFresh: (_source: CameraSource): boolean => {
    const state = useVisionStore.getState().latestVisionState;
    if (!state) return false;
    if (state.frameId === 0) return false;
    return Date.now() - state.timestamp <= LIVE_RESULT_STALE_MS;
  },

  getLiveAnalyzing: (): boolean => useVisionStore.getState().liveAnalyzing,

  /** Latest continuous YOLO vision-state snapshot (objects, people, colours). */
  getLiveVisionState: (): VisionStateSnapshot | null =>
    useVisionStore.getState().latestVisionState,

  /**
   * Non-blocking grab of the newest camera frame for on-demand analysis. Prefers
   * the newest frame the server already analyzed (from the Scene Cache) so the
   * chat round-trip never waits on capture or encode; falls back to the last
   * frame from the live loop only if it is recent.
   */
  getNewestAnalysisFrame: (source?: CameraSource): VisionFrame | null => {
    const active = source ?? cameraService.getActiveSource();
    if (!active) return null;
    const state = useVisionStore.getState().latestVisionState;
    const sceneFrame = state?.latestFrame;
    if (sceneFrame?.buffer && state) {
      const age = Date.now() - (state.timestamp || 0);
      if (age <= LIVE_RESULT_STALE_MS) {
        return {
          source: active,
          dataUrl: sceneFrame.buffer,
          mimeType: "image/jpeg",
          width: sceneFrame.width,
          height: sceneFrame.height,
          capturedAt: sceneFrame.capturedAt,
        };
      }
    }
    const history = cameraService.getRecentFrames(active, 1);
    const latest = history[0];
    if (!latest) return null;
    if (Date.now() - latest.capturedAt > LIVE_RESULT_STALE_MS) return null;
    return latest;
  },
};
