import type { RgbImage } from "./detect/colors";

/**
 * OCR is intentionally pluggable and OFF by default.
 *
 * Native EasyOCR requires Python, which is not available on this machine, so
 * the default engine is a no-op returning empty results. Set `VISION_OCR` to
 * `"python"` (to point at the optional FastAPI OCR service) or `"tesseract"`
 * (to use tesseract.js if it is installed) to activate it.
 *
 * The rest of the pipeline must never crash or change behaviour because OCR is
 * unavailable - it only means `latestText` stays empty and "what does the text
 * say?" questions route to Gemma.
 */

export interface OcrLine {
  text: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface OcrResult {
  lines: OcrLine[];
  engine: string;
  latencyMs: number;
}

export interface OcrEngine {
  readonly name: string;
  readonly available: boolean;
  recognize(img: RgbImage): Promise<OcrResult>;
}

export const NOOP_OCR_RESULT: OcrResult = { lines: [], engine: "none", latencyMs: 0 };

class NoopOcrEngine implements OcrEngine {
  readonly name = "none";
  readonly available = false;
  async recognize(): Promise<OcrResult> {
    return NOOP_OCR_RESULT;
  }
}

/**
 * Lazy Python EasyOCR service client. Only used when VISION_OCR=python and the
 * service is reachable at VISION_OCR_URL (default http://127.0.0.1:8765).
 */
class PythonOcrEngine implements OcrEngine {
  readonly name = "python";
  private _available: boolean | null = null;
  private readonly url: string;

  constructor() {
    this.url = process.env.VISION_OCR_URL ?? "http://127.0.0.1:8765";
  }

  get available(): boolean {
    return this._available === true;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1500) });
      this._available = res.ok;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  async recognize(img: RgbImage): Promise<OcrResult> {
    const t0 = performance.now();
    try {
      const jpeg = await import("sharp").then((m) =>
        m.default(img.data, {
          raw: { width: img.width, height: img.height, channels: 3 },
        })
          .jpeg({ quality: 85 })
          .toBuffer(),
      );
      const res = await fetch(`${this.url}/ocr`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: jpeg,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return NOOP_OCR_RESULT;
      const body = (await res.json()) as { lines: OcrLine[] };
      return { lines: body.lines ?? [], engine: "python", latencyMs: performance.now() - t0 };
    } catch {
      return NOOP_OCR_RESULT;
    }
  }
}

let ocrEngine: OcrEngine | null = null;

export function getOcrEngine(): OcrEngine {
  if (ocrEngine) return ocrEngine;
  const mode = (process.env.VISION_OCR ?? "none").toLowerCase();
  if (mode === "python") {
    ocrEngine = new PythonOcrEngine();
  } else if (mode === "tesseract") {
    // Tesseract.js is not installed by default; keep the no-op fallback so the
    // bundle never hard-requires it.
    ocrEngine = new NoopOcrEngine();
  } else {
    ocrEngine = new NoopOcrEngine();
  }
  return ocrEngine;
}

export function isOcrAvailable(): boolean {
  const engine = getOcrEngine();
  if (engine instanceof PythonOcrEngine) {
    // Force an availability probe at most once per process.
    void engine.ping();
  }
  return engine.available;
}
