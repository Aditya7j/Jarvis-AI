import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aiLogger } from "@/lib/ai/logger";

const log = aiLogger.child("vision");

export function isDev(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * In development mode, writes the exact base64 frame that was sent to Gemma 3
 * to debug/debug-frame.jpg so the pipeline input can be verified. Returns the
 * absolute file path, or null when not in development / on write failure.
 */
export function saveDebugFrame(
  imageBase64: string,
  mimeType = "image/jpeg"
): string | null {
  if (!isDev()) return null;
  try {
    const dir = join(process.cwd(), "debug");
    mkdirSync(dir, { recursive: true });
    const ext = mimeType.includes("png") ? "png" : "jpg";
    const file = join(dir, `debug-frame.${ext}`);
    writeFileSync(file, Buffer.from(imageBase64, "base64"));
    return file;
  } catch (error) {
    log.warn("Failed to save debug frame", { error });
    return null;
  }
}
