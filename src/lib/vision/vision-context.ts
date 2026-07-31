import type { VisionImage } from "@/lib/ai/types";
import { visionService } from "./vision-service";

export interface VisionContext {
  frames: VisionImage[];
  capturedAt: number;
}

let lastContext: VisionContext | null = null;

export function getLastVisionContext(): VisionContext | null {
  return lastContext;
}

export function getVisionContext(): VisionContext | null {
  if (typeof window === "undefined") return null;
  if (!visionService.isAnyActive()) {
    lastContext = null;
    return null;
  }
  const frames = visionService.getVisionFrames();
  if (frames.length === 0) return null;
  lastContext = { frames, capturedAt: Date.now() };
  return lastContext;
}
