import { create } from "zustand";
import type { VisionAnalysisSummary } from "@/lib/ai/prompts";
import type { LiveVisionResult } from "@/lib/vision/live-vision-engine";
import type { VisionStateSnapshot } from "@/lib/vision/vision-state";

interface VisionStore {
  webcamActive: boolean;
  screenShareActive: boolean;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  visionError: string | null;
  lastAnalysis: VisionAnalysisSummary | null;
  latestLiveResult: LiveVisionResult | null;
  latestVisionState: VisionStateSnapshot | null;
  liveAnalyzing: boolean;
  debugOverlayOpen: boolean;
  setWebcamActive: (active: boolean) => void;
  setScreenShareActive: (active: boolean) => void;
  setWebcamStream: (stream: MediaStream | null) => void;
  setScreenStream: (stream: MediaStream | null) => void;
  setVisionError: (error: string | null) => void;
  setLastAnalysis: (analysis: VisionAnalysisSummary | null) => void;
  setLatestLiveResult: (result: LiveVisionResult | null) => void;
  setLatestVisionState: (state: VisionStateSnapshot | null) => void;
  setLiveAnalyzing: (analyzing: boolean) => void;
  setDebugOverlayOpen: (open: boolean) => void;
}

export const useVisionStore = create<VisionStore>((set) => ({
  webcamActive: false,
  screenShareActive: false,
  webcamStream: null,
  screenStream: null,
  visionError: null,
  lastAnalysis: null,
  latestLiveResult: null,
  latestVisionState: null,
  liveAnalyzing: false,
  debugOverlayOpen: false,
  setWebcamActive: (webcamActive) => set({ webcamActive }),
  setScreenShareActive: (screenShareActive) => set({ screenShareActive }),
  setWebcamStream: (webcamStream) => set({ webcamStream }),
  setScreenStream: (screenStream) => set({ screenStream }),
  setVisionError: (visionError) => set({ visionError }),
  setLastAnalysis: (lastAnalysis) => set({ lastAnalysis }),
  setLatestLiveResult: (latestLiveResult) => set({ latestLiveResult }),
  setLatestVisionState: (latestVisionState) => set({ latestVisionState }),
  setLiveAnalyzing: (liveAnalyzing) => set({ liveAnalyzing }),
  setDebugOverlayOpen: (debugOverlayOpen) => set({ debugOverlayOpen }),
}));
