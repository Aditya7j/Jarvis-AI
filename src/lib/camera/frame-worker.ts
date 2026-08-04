import type { CameraSource } from "./types";
import { applyEnhancements } from "./enhance";

interface CropRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EncodeRequest {
  type: "encode";
  source: CameraSource;
  frame: VideoFrame;
  width: number;
  height: number;
  quality: number;
  crop?: CropRegion | null;
  encodeId: number;
}

interface WorkerOutMessage {
  type: "frame";
  source: CameraSource;
  bytes: ArrayBuffer;
  width: number;
  height: number;
  encodeId: number;
  encodeMs: number;
}

interface WorkerSelf {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: WorkerOutMessage, transfer?: Transferable[]): void;
}

const wself = self as unknown as WorkerSelf;

let canvas: OffscreenCanvas | null = null;
let context: OffscreenCanvasRenderingContext2D | null = null;
let queue: EncodeRequest[] = [];
let processing = false;

function ensureContext(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext("2d");
  }
  return context;
}

function enqueue(request: EncodeRequest): void {
  queue.push(request);
  void drain();
}

async function drain(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const request = queue.shift();
      if (request) await process(request);
    }
  } finally {
    processing = false;
  }
}

async function process(request: EncodeRequest): Promise<void> {
  const frame = request.frame;
  try {
    const ctx = ensureContext(request.width, request.height);
    if (!ctx) {
      frame.close();
      return;
    }
    const encodeStart = performance.now();
    const crop = request.crop;
    if (crop) {
      ctx.drawImage(
        frame as unknown as CanvasImageSource,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        request.width,
        request.height
      );
    } else {
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, request.width, request.height);
    }
    applyEnhancements(ctx, request.width, request.height);
    const blob = await canvas!.convertToBlob({
      type: "image/jpeg",
      quality: request.quality,
    });
    const bytes = await blob.arrayBuffer();
    const encodeMs = performance.now() - encodeStart;
    wself.postMessage(
      {
        type: "frame",
        source: request.source,
        bytes,
        width: request.width,
        height: request.height,
        encodeId: request.encodeId,
        encodeMs,
      },
      [bytes]
    );
  } catch (error) {
    console.warn("[CAM:worker] Frame encode failed:", error);
  } finally {
    frame.close();
  }
}

wself.onmessage = (event) => {
  enqueue(event.data);
};
