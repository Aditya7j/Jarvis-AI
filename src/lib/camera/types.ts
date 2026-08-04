export type CameraSource = "webcam" | "screen";

export interface CameraFrame {
  source: CameraSource;
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  capturedAt: number;
}

export interface CameraStats {
  mode: "worker" | "main";
  fps: number;
  frames: number;
  active: boolean;
  lastCaptureAt: number;
  /** Encoded size of the most recent captured frame (bytes). */
  latestBytes: number;
}

export type FrameListener = (frame: CameraFrame) => void;
