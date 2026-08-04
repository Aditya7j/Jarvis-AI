import { className } from "./coco-classes";

/**
 * Axis-aligned bounding box in source (original frame) pixel coordinates.
 */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawDetection {
  label: string;
  classId: number;
  confidence: number; // 0..1
  box: Box;
}

export interface DetectionRun {
  detections: RawDetection[];
  /** Wall-clock inference time for the ONNX session.run call. */
  inferenceMs: number;
  width: number;
  height: number;
  source: "yolo-onnx" | "python" | "none";
}

/**
 * Map an xywh box produced in the letterboxed (model input) coordinate space
 * back into source image coordinates.
 */
export function mapLetterboxBox(
  cx: number,
  cy: number,
  w: number,
  h: number,
  inputSize: number,
  srcWidth: number,
  srcHeight: number,
): Box {
  const scale = Math.min(inputSize / srcWidth, inputSize / srcHeight);
  const scaledW = srcWidth * scale;
  const scaledH = srcHeight * scale;
  const padX = (inputSize - scaledW) / 2;
  const padY = (inputSize - scaledH) / 2;

  const x = (cx - padX) / scale;
  const y = (cy - padY) / scale;
  const width = w / scale;
  const height = h / scale;

  return {
    x: Math.max(0, x - width / 2),
    y: Math.max(0, y - height / 2),
    width,
    height,
  };
}

/**
 * Decode a YOLOv8 raw output tensor.
 *
 * The standard ultralytics ONNX export emits shape [1, 84, 8400] (channel-major,
 * memory order is a[0][c][p]): each of the 84 channels is a 8400-length row
 * where the anchor index varies fastest. Anchor `p`'s box params are at
 * channels 0..3 (`cx, cy, w, h`) and its class scores at channels 4..84, each
 * read at offset `channel * N + p` where N = numPredictions.
 *
 * Some export flags produce [1, 8400, 84] (anchor-major, a[0][p][c]); both are
 * handled here. Coordinates are in the letterboxed input space;
 * `mapLetterboxBox` converts them back to source pixels.
 */
export function decodeYoloOutput(
  output: Float32Array,
  shape: number[],
  confThreshold: number,
  srcWidth: number,
  srcHeight: number,
  inputSize = 640,
): RawDetection[] {
  if (shape.length !== 3 || shape[0] !== 1) {
    throw new Error(`Unexpected YOLO output shape: [${shape.join(", ")}]`);
  }
  const dimA = shape[1];
  const dimB = shape[2];

  // Channel-major [1, 84, 8400]: dimA = 4 + numClasses, dimB = numPredictions.
  const channelMajor = dimA >= 5 && dimA <= 300 && dimB > dimA;
  const numPredictions = channelMajor ? dimB : dimA;
  const channels = channelMajor ? dimA : dimB;
  const scoresPerAnchor = channels - 4;

  const detections: RawDetection[] = [];

  for (let i = 0; i < numPredictions; i++) {
    let cx = 0;
    let cy = 0;
    let w = 0;
    let h = 0;
    let classScoresOffset = 0;

    if (channelMajor) {
      cx = output[i];
      cy = output[numPredictions + i];
      w = output[numPredictions * 2 + i];
      h = output[numPredictions * 3 + i];
      classScoresOffset = numPredictions * 4 + i;
    } else {
      const base = i * channels;
      cx = output[base];
      cy = output[base + 1];
      w = output[base + 2];
      h = output[base + 3];
      classScoresOffset = base + 4;
    }

    if (w <= 0 || h <= 0 || cx < 0 || cy < 0 || cx > inputSize || cy > inputSize) {
      continue;
    }

    let bestScore = -Infinity;
    let bestClass = -1;
    for (let c = 0; c < scoresPerAnchor; c++) {
      // Channel-major: class c is its own row at offset (4 + c) * N + i.
      // Anchor-major: the class scores are contiguous after the box params.
      const score = channelMajor
        ? output[(4 + c) * numPredictions + i]
        : output[classScoresOffset + c];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    // The official ultralytics export emits class LOGITS (unbounded). Convert to
    // a 0..1 probability; exports that already apply sigmoid (scores in 0..1)
    // pass through unchanged.
    const confidence =
      bestScore > 1 ? 1 / (1 + Math.exp(-bestScore)) : bestScore;
    if (confidence < confThreshold) continue;

    detections.push({
      label: className(bestClass),
      classId: bestClass,
      confidence,
      box: mapLetterboxBox(cx, cy, w, h, inputSize, srcWidth, srcHeight),
    });
  }

  return nmsClassAware(detections);
}

function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Class-aware NMS with an IoU threshold. */
export function nmsClassAware(
  detections: RawDetection[],
  iouThreshold = 0.45,
): RawDetection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: RawDetection[] = [];

  for (const candidate of sorted) {
    let suppressed = false;
    for (const k of kept) {
      if (k.classId !== candidate.classId) continue;
      if (iou(k.box, candidate.box) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(candidate);
  }

  return kept;
}
