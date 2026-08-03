import { create } from "zustand";

interface VisionStore {
  webcamActive: boolean;
  screenShareActive: boolean;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  visionError: string | null;
  setWebcamActive: (active: boolean) => void;
  setScreenShareActive: (active: boolean) => void;
  setWebcamStream: (stream: MediaStream | null) => void;
  setScreenStream: (stream: MediaStream | null) => void;
  setVisionError: (error: string | null) => void;
}

export const useVisionStore = create<VisionStore>((set) => ({
  webcamActive: false,
  screenShareActive: false,
  webcamStream: null,
  screenStream: null,
  visionError: null,
  setWebcamActive: (webcamActive) => set({ webcamActive }),
  setScreenShareActive: (screenShareActive) => set({ screenShareActive }),
  setWebcamStream: (webcamStream) => set({ webcamStream }),
  setScreenStream: (screenStream) => set({ screenStream }),
  setVisionError: (visionError) => set({ visionError }),
}));
