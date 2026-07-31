import { create } from "zustand";

interface VisionStore {
  webcamActive: boolean;
  screenShareActive: boolean;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  lastCapturedFrame: string | null;
  detections: Array<{ label: string; confidence: number; bbox: number[] }>;
  visionError: string | null;
  setWebcamActive: (active: boolean) => void;
  setScreenShareActive: (active: boolean) => void;
  setWebcamStream: (stream: MediaStream | null) => void;
  setScreenStream: (stream: MediaStream | null) => void;
  setLastCapturedFrame: (frame: string | null) => void;
  setDetections: (
    detections: Array<{ label: string; confidence: number; bbox: number[] }>
  ) => void;
  setVisionError: (error: string | null) => void;
}

export const useVisionStore = create<VisionStore>((set) => ({
  webcamActive: false,
  screenShareActive: false,
  webcamStream: null,
  screenStream: null,
  lastCapturedFrame: null,
  detections: [],
  visionError: null,
  setWebcamActive: (active) => set({ webcamActive: active }),
  setScreenShareActive: (active) => set({ screenShareActive: active }),
  setWebcamStream: (stream) => set({ webcamStream: stream }),
  setScreenStream: (stream) => set({ screenStream: stream }),
  setLastCapturedFrame: (frame) => set({ lastCapturedFrame: frame }),
  setDetections: (detections) => set({ detections }),
  setVisionError: (visionError) => set({ visionError }),
}));
