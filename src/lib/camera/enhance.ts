const EXPOSURE_LOW_PERCENTILE = 0.01;
const EXPOSURE_HIGH_PERCENTILE = 0.99;
const SHARPEN_AMOUNT = 0.45;
const SHARPEN_THRESHOLD = 12;

export function applyEnhancements(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number
): void {
  if (width <= 0 || height <= 0) return;
  const imageData = ctx.getImageData(0, 0, width, height);
  enhancePixels(imageData.data, width, height);
  ctx.putImageData(imageData, 0, 0);
}

function enhancePixels(data: Uint8ClampedArray, width: number, height: number): void {
  const count = width * height;
  const luma = new Float32Array(count);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const y = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) | 0;
    luma[i] = y;
    histogram[y] += 1;
  }

  let gain = 1;
  let offset = 0;
  const low = percentile(histogram, count, EXPOSURE_LOW_PERCENTILE);
  const high = percentile(histogram, count, EXPOSURE_HIGH_PERCENTILE);
  if (high - low >= 8) {
    gain = 255 / (high - low);
    offset = -low * gain;
  }

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    data[o] = clamp255(data[o] * gain + offset);
    data[o + 1] = clamp255(data[o + 1] * gain + offset);
    data[o + 2] = clamp255(data[o + 2] * gain + offset);
    luma[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }

  const blurred = boxBlur(luma, width, height, 2);
  for (let i = 0; i < count; i++) {
    const diff = luma[i] - blurred[i];
    if (diff > SHARPEN_THRESHOLD || diff < -SHARPEN_THRESHOLD) {
      const o = i * 4;
      const amount = SHARPEN_AMOUNT * diff;
      data[o] = clamp255(data[o] + amount);
      data[o + 1] = clamp255(data[o + 1] + amount);
      data[o + 2] = clamp255(data[o + 2] + amount);
    }
  }
}

function percentile(histogram: Uint32Array, count: number, p: number): number {
  const target = Math.max(1, count * p);
  let cumulative = 0;
  for (let i = 0; i < 256; i++) {
    cumulative += histogram[i];
    if (cumulative >= target) return i;
  }
  return 255;
}

function boxBlur(
  src: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const horizontal = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const windowSize = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += src[row + clamp(x, 0, width - 1)];
    }
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / windowSize;
      sum +=
        src[row + clamp(x + radius + 1, 0, width - 1)] -
        src[row + clamp(x - radius, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += horizontal[clamp(y, 0, height - 1) * width + x];
    }
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / windowSize;
      sum +=
        horizontal[clamp(y + radius + 1, 0, height - 1) * width + x] -
        horizontal[clamp(y - radius, 0, height - 1) * width + x];
    }
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
