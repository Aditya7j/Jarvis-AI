import type {
  LiveVisionResult,
  LiveVisionStats,
} from "./live-vision-engine";
import type { VisionStateSnapshot } from "./vision-state";
import { withAuthHeaders } from "@/lib/api/auth";

export interface LiveSubmitBody {
  image: string;
  mimeType?: string;
  source?: "webcam" | "screen";
  width?: number;
  height?: number;
  capturedAt?: number;
  captureMs?: number;
}

export interface LivePostResponse {
  ok: boolean;
  result: LiveVisionResult | null;
  analyzing: boolean;
  stats: LiveVisionStats;
  vision?: VisionStateSnapshot | null;
}

export interface LiveGetResponse {
  result: LiveVisionResult | null;
  analyzing: boolean;
  stats: LiveVisionStats;
  vision?: VisionStateSnapshot | null;
}

async function postLive(
  body: object
): Promise<LivePostResponse | null> {
  try {
    const res = await fetch("/api/vision/live", withAuthHeaders({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    if (!res.ok) return null;
    return (await res.json()) as LivePostResponse;
  } catch (error) {
    console.warn("[LIVE-VISION] Request failed:", error);
    return null;
  }
}

export async function startLiveSession(
  source: "webcam" | "screen"
): Promise<void> {
  await postLive({ action: "start", source });
}

export async function stopLiveSession(): Promise<void> {
  await postLive({ action: "stop" });
}

export async function submitLiveFrame(
  frame: LiveSubmitBody
): Promise<LivePostResponse | null> {
  return postLive(frame);
}

export async function getLiveState(
  source: "webcam" | "screen"
): Promise<LiveGetResponse | null> {
  try {
    const res = await fetch(`/api/vision/live?source=${source}`, withAuthHeaders({
      headers: { Accept: "application/json" },
    }));
    if (!res.ok) return null;
    return (await res.json()) as LiveGetResponse;
  } catch (error) {
    console.warn("[LIVE-VISION] Poll failed:", error);
    return null;
  }
}
