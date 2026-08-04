import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import { decodeYoloOutput, type Box, type DetectionRun, type RawDetection } from "./postprocess";

/**
 * YOLOv8n real-time detector running on the CPU via ONNX Runtime.
 *
 * Server-only module. The engine singleton lives on `globalThis` so every
 * serverless/App-Router bundle that imports it shares one session + one
 * inference threadpool (no per-request model reload).
 *
 * Model file: `public/models/yolov8n.onnx` (12.8MB, COCO-80, 640x640).
 * Swappable with any YOLO11-family ONNX export that shares the COCO label
 * space and the [1,84,N] output layout.
 */

const DEFAULT_MODEL_PATH = path.join(
  process.cwd(),
  "public",
  "models",
  "yolov8n.onnx",
);

export interface DetectorOptions {
  modelPath?: string;
  inputSize?: number;
  confThreshold?: number;
  nmsThreshold?: number;
  threads?: number;
}

export interface DetectRgbInput {
  rgb: Buffer;
  width: number;
  height: number;
}

export interface YoloResult extends DetectionRun {
  /** Letterboxed model input buffer, decoded back to source coords already. */
}

class YoloDetector {
  private session: ort.InferenceSession | null = null;
  private readonly modelPath: string;
  private readonly inputSize: number;
  private readonly confThreshold: number;
  private readonly nmsThreshold: number;
  readonly name = "yolo-onnx";
  private initError: Error | null = null;

  constructor(opts: DetectorOptions = {}) {
    this.modelPath = opts.modelPath ?? process.env.YOLO_MODEL_PATH ?? DEFAULT_MODEL_PATH;
    this.inputSize = opts.inputSize ?? 640;
    this.confThreshold = opts.confThreshold ?? 0.35;
    this.nmsThreshold = opts.nmsThreshold ?? 0.45;
  }

  isReady(): boolean {
    return this.session !== null;
  }

  getInitError(): Error | null {
    return this.initError;
  }

  async init(): Promise<void> {
    if (this.session) return;
    if (!fs.existsSync(this.modelPath)) {
      this.initError = new Error(`YOLO model not found at ${this.modelPath}`);
      throw this.initError;
    }
    const threads = Math.max(1, Math.min(4, os.cpus().length));
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: threads,
    });
  }

  /**
   * Run detection on an already-decoded RGB image at its native resolution.
   * Performs letterboxing to the model input size, so boxes come back mapped to
   * the source (x, y, width, height) pixel space.
   */
  async detectRgb(
    input: DetectRgbInput,
    opts?: { confThreshold?: number; inputSize?: number }
  ): Promise<YoloResult> {
    if (!this.session) await this.init();
    if (!this.session) {
      throw this.initError ?? new Error("YOLO session unavailable");
    }

    const { rgb, width, height } = input;
    const confThreshold = opts?.confThreshold ?? this.confThreshold;
    const inputSize = opts?.inputSize ?? this.inputSize;

    const tensor = await this.letterboxToTensor(rgb, width, height, inputSize);
    const feeds: Record<string, ort.Tensor> = {};
    feeds[this.session.inputNames[0]] = tensor;

    const t1 = performance.now();
    const results = await this.session.run(feeds);
    const inferenceMs = performance.now() - t1;

    const outputName = this.session.outputNames[0];
    const outputTensor = results[outputName];
    const outputData = outputTensor.data as Float32Array;
    const outputShape = Array.from(outputTensor.dims);

    const detections = decodeYoloOutput(
      outputData,
      outputShape,
      confThreshold,
      width,
      height,
      inputSize,
    );

    return {
      detections,
      inferenceMs,
      width,
      height,
      source: this.name,
    };
  }

  /** Same as detectRgb but consumes a JPEG/PNG/etc. buffer directly. */
  async detectBuffer(buffer: Buffer): Promise<YoloResult & { rgb: Buffer }> {
    const { data, info } = await sharp(buffer)
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) {
      const rgb = await sharp(buffer)
        .rotate()
        .removeAlpha()
        .flatten({ background: { r: 114, g: 114, b: 114 } })
        .raw()
        .toBuffer();
      return { ...(await this.detectRgb({ rgb, width: info.width, height: info.height })), rgb };
    }
    return {
      ...(await this.detectRgb({ rgb: data, width: info.width, height: info.height })),
      rgb: data,
    };
  }

  /**
   * Letterbox the RGB image to (inputSize x inputSize) and build the
   * normalized float32 [1,3,H,W] tensor in RGB channel order.
   */
  private async letterboxToTensor(
    rgb: Buffer,
    width: number,
    height: number,
    inputSize = this.inputSize,
  ): Promise<ort.Tensor> {
    const size = inputSize;
    const scale = Math.min(size / width, size / height);
    const scaledW = Math.max(1, Math.round(width * scale));
    const scaledH = Math.max(1, Math.round(height * scale));
    const padX = Math.round((size - scaledW) / 2);
    const padY = Math.round((size - scaledH) / 2);

    const raw = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .resize(scaledW, scaledH, { kernel: sharp.kernel.cubic })
      .extend({
        top: padY,
        bottom: size - scaledH - padY,
        left: padX,
        right: size - scaledW - padX,
        background: { r: 114, g: 114, b: 114 },
      })
      .raw()
      .toBuffer();

    const float = new Float32Array(size * size * 3);
    const plane = size * size;
    for (let i = 0; i < plane; i++) {
      // NCHW layout: each channel is one contiguous H*W plane.
      float[i] = raw[i * 3] / 255;
      float[plane + i] = raw[i * 3 + 1] / 255;
      float[plane * 2 + i] = raw[i * 3 + 2] / 255;
    }

    return new ort.Tensor("float32", float, [1, 3, size, size]);
  }

  /** Crop a region from an RGB image (used for ROI high-res re-detection). */
  cropRgb(input: DetectRgbInput, box: Box): { rgb: Buffer; width: number; height: number } {
    const x0 = Math.max(0, Math.round(box.x));
    const y0 = Math.max(0, Math.round(box.y));
    const x1 = Math.min(input.width, Math.round(box.x + box.width));
    const y1 = Math.min(input.height, Math.round(box.y + box.height));
    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);

    const cropped = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      const srcOff = ((y0 + y) * input.width + x0) * 3;
      input.rgb.copy(cropped, y * w * 3, srcOff, srcOff + w * 3);
    }
    return { rgb: cropped, width: w, height: h };
  }
}

export { YoloDetector };

const globalYolo = globalThis as unknown as {
  __jarvis_yolo_detector__?: YoloDetector;
};

/** Process-wide shared detector instance. */
export function getSharedDetector(): YoloDetector {
  if (!globalYolo.__jarvis_yolo_detector__) {
    globalYolo.__jarvis_yolo_detector__ = new YoloDetector();
  }
  return globalYolo.__jarvis_yolo_detector__;
}

export function resetSharedDetector(): void {
  globalYolo.__jarvis_yolo_detector__ = undefined;
}

export type { Box, DetectionRun, RawDetection };
