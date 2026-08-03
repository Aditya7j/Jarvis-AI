import type { CameraSource } from "./types";

interface EncodeRequest {
  type: "encode";
  source: CameraSource;
  frame: VideoFrame;
  width: number;
  height: number;
  quality: number;
}

interface WorkerOutMessage {
  type: "frame";
  source: CameraSource;
  bytes: ArrayBuffer;
  width: number;
  height: number;
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
    ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, request.width, request.height);
    const blob = await canvas!.convertToBlob({
      type: "image/jpeg",
      quality: request.quality,
    });
    const bytes = await blob.arrayBuffer();
    wself.postMessage(
      {
        type: "frame",
        source: request.source,
        bytes,
        width: request.width,
        height: request.height,
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
