"use client";

/**
 * Client-side diagnostics bridge. The server-side metrics store only sees
 * requests that hit the Node process; camera capture runs in the browser, so
 * live YOLO FPS and the latest captured frame size are reported here and
 * rendered by the dev metrics panel alongside the server metrics.
 */
type ClientStatsListener = () => void;

interface ClientStats {
  fps: number;
  frameBytes: number;
}

let fps = 0;
let frameBytes = 0;
const listeners = new Set<ClientStatsListener>();

export function reportClientStats(next: Partial<ClientStats>): void {
  let changed = false;
  if (typeof next.fps === "number" && next.fps !== fps) {
    fps = next.fps;
    changed = true;
  }
  if (typeof next.frameBytes === "number" && next.frameBytes !== frameBytes) {
    frameBytes = next.frameBytes;
    changed = true;
  }
  if (!changed) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must never break the capture loop.
    }
  }
}

export function subscribeClientStats(listener: ClientStatsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getClientStats(): ClientStats {
  return { fps, frameBytes };
}
