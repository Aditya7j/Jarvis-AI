import { cameraService } from "@/lib/camera";
import type { CameraSource } from "@/lib/camera";
import type { VisionImage } from "@/lib/ai/types";

export interface VisionFrame {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  capturedAt: number;
}

export const visionService = {
  startWebcam: (): Promise<boolean> => cameraService.startWebcam(),
  startScreenShare: (): Promise<boolean> => cameraService.startScreenShare(),
  stopWebcam: (): void => cameraService.stopWebcam(),
  stopScreenShare: (): void => cameraService.stopScreenShare(),
  stopAll: (): void => cameraService.stopAll(),
  captureFrame: (source?: CameraSource): Promise<VisionFrame | null> =>
    cameraService.captureFrame(source),
  isAnyActive: (): boolean => cameraService.isActive(),
  getVisionFrames: (): VisionImage[] => cameraService.getVisionFrames(),
};
