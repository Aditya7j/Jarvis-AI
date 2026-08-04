import type { Box } from "./postprocess";

export interface NamedColor {
  name: string;
  hex: string;
  hsv: { h: number; s: number; v: number };
  /** How representative the sampled patch is (0..1). */
  confidence: number;
}

export interface RgbImage {
  /** Raw RGB triplets, width*height*3 bytes. */
  data: Buffer;
  width: number;
  height: number;
}

const COLOR_BANDS: { name: string; hex: string; test: (h: number, s: number, v: number) => boolean }[] = [
  { name: "red", hex: "#E53935", test: (h, s, v) => (h < 10 || h >= 350) && s > 45 && v > 40 },
  { name: "orange", hex: "#FB8C00", test: (h, s, v) => h >= 10 && h < 45 && s > 50 && v > 50 },
  { name: "yellow", hex: "#FDD835", test: (h, s, v) => h >= 45 && h < 65 && s > 45 && v > 55 },
  { name: "green", hex: "#43A047", test: (h, s, v) => h >= 65 && h < 160 && s > 35 && v > 40 },
  { name: "cyan", hex: "#00ACC1", test: (h, s, v) => h >= 160 && h < 190 && s > 35 && v > 40 },
  { name: "blue", hex: "#1E88E5", test: (h, s, v) => h >= 190 && h < 250 && s > 35 && v > 40 },
  { name: "purple", hex: "#8E24AA", test: (h, s, v) => h >= 250 && h < 285 && s > 30 && v > 35 },
  { name: "pink", hex: "#EC407A", test: (h, s, v) => h >= 285 && h < 340 && s > 30 && v > 45 },
  { name: "brown", hex: "#6D4C41", test: (h, s, v) => h >= 10 && h < 45 && s > 40 && v < 55 },
  { name: "white", hex: "#FAFAFA", test: (h, s, v) => s < 25 && v > 75 },
  { name: "gray", hex: "#9E9E9E", test: (h, s, v) => s < 25 && v >= 25 && v <= 75 },
  { name: "black", hex: "#212121", test: (h, s, v) => s < 55 && v < 25 },
];

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  const v = max * 100;
  return { h, s, v };
}

function classifyHsv(h: number, s: number, v: number): NamedColor {
  for (const band of COLOR_BANDS) {
    if (band.test(h, s, v)) {
      return { name: band.name, hex: band.hex, hsv: { h, s, v }, confidence: 1 };
    }
  }
  return {
    name: "gray",
    hex: "#9E9E9E",
    hsv: { h, s, v },
    confidence: 0.4,
  };
}

/**
 * Sample the dominant colour of a box region (centre-weighted, excluding the
 * border) and classify it into a human-readable colour name.
 */
export function sampleBoxColor(img: RgbImage, box: Box): NamedColor | null {
  const { data, width, height } = img;
  if (box.width <= 0 || box.height <= 0 || width <= 0 || height <= 0) return null;

  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(width - 1, Math.round(box.x + box.width - 1));
  const y1 = Math.min(height - 1, Math.round(box.y + box.height - 1));
  if (x1 <= x0 || y1 <= y0) return null;

  // Centre-weighted patch: shrink each edge by 20% so borders/clutter don't
  // dominate the average.
  const inset = 0.2;
  const px0 = Math.round(x0 + (x1 - x0) * inset);
  const px1 = Math.round(x1 - (x1 - x0) * inset);
  const py0 = Math.round(y0 + (y1 - y0) * inset);
  const py1 = Math.round(y1 - (y1 - y0) * inset);
  if (px1 <= px0 || py1 <= py0) return null;

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let y = py0; y <= py1; y++) {
    let off = (y * width + px0) * 3;
    for (let x = px0; x <= px1; x++) {
      rSum += data[off];
      gSum += off + 1 < data.length ? data[off + 1] : 0;
      bSum += off + 2 < data.length ? data[off + 2] : 0;
      off += 3;
      count++;
    }
  }
  if (count === 0) return null;

  const r = rSum / count;
  const g = gSum / count;
  const b = bSum / count;
  const hsv = rgbToHsv(r, g, b);
  const color = classifyHsv(hsv.h, hsv.s, hsv.v);
  color.hsv = hsv;
  return color;
}

/**
 * Sample the average colour of a sub-region defined by fractional coordinates.
 * Used for the "what am I wearing" torso region (person box upper body,
 * below the head).
 */
export function sampleRegion(
  img: RgbImage,
  box: Box,
  fracX0: number,
  fracY0: number,
  fracX1: number,
  fracY1: number,
): NamedColor | null {
  return sampleBoxColor(img, {
    x: box.x + box.width * fracX0,
    y: box.y + box.height * fracY0,
    width: box.width * (fracX1 - fracX0),
    height: box.height * (fracY1 - fracY0),
  });
}

/**
 * Simple HSV colour scan for a region that looks like a national flag (three
 * roughly equal horizontal colour bands). Intentionally conservative: it only
 * reports a flag when the band pattern is strong, otherwise returns null so the
 * caller can fall back to the "not fully certain" response.
 *
 * The classic complaint was the model calling the Indian tricolour "red flag",
 * so we recognise saffron-white-green as Indian with high confidence.
 */
export interface FlagSighting {
  label: string;
  confidence: number;
  bands: string[];
}

export function detectTricolorFlag(
  img: RgbImage,
  box?: Box,
): FlagSighting | null {
  const { data, width, height } = img;
  if (width === 0 || height === 0) return null;

  const region: Box = box ?? { x: 0, y: 0, width, height };

  // Scan the centre of the region to avoid border interference.
  const x0 = Math.max(0, Math.round(region.x + region.width * 0.2));
  const x1 = Math.min(width - 1, Math.round(region.x + region.width * 0.8));
  const midX = Math.round((x0 + x1) / 2);

  const rows: { h: number; s: number; v: number }[] = [];
  const y0 = Math.max(0, Math.round(region.y));
  const y1 = Math.min(height - 1, Math.round(region.y + region.height - 1));
  if (y1 - y0 < 12) return null;

  for (let y = y0; y <= y1; y += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    const off = y * width * 3;
    for (let x = x0; x <= x1; x++) {
      const i = off + x * 3;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    const n = x1 - x0 + 1;
    rows.push(rgbToHsv(r / n, g / n, b / n));
  }

  const nRows = rows.length;
  const third = Math.floor(nRows / 3);

  function bandColor(start: number, end: number): { h: number; s: number; v: number } {
    let h = 0;
    let s = 0;
    let v = 0;
    const n = end - start;
    for (let i = start; i < end; i++) {
      h += rows[i].h;
      s += rows[i].s;
      v += rows[i].v;
    }
    return { h: h / n, s: s / n, v: v / n };
  }

  const band1 = bandColor(0, third);
  const band2 = bandColor(third, third * 2);
  const band3 = bandColor(third * 2, nRows);

  const saffron = (c: { h: number; s: number; v: number }) =>
    c.h >= 18 && c.h < 45 && c.s > 50 && c.v > 50;
  const white = (c: { h: number; s: number; v: number }) =>
    c.s < 20 && c.v > 70;
  const green = (c: { h: number; s: number; v: number }) =>
    c.h >= 90 && c.h < 150 && c.s > 40 && c.v > 40;

  if (saffron(band1) && white(band2) && green(band3)) {
    return {
      label: "flag",
      confidence: 0.85,
      bands: ["saffron", "white", "green"],
    };
  }

  return null;
}
