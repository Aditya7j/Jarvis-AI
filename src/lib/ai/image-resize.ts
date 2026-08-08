import sharp from "sharp";

/**
 * Downscale a base64-encoded image (optionally a data: URL) to at most
 * `maxDim` pixels on its longest edge and return it re-encoded as a JPEG
 * base64 string.
 *
 * This is the single biggest latency lever for a local Gemma 3 vision call:
 * image tokens scale with (w/14)x(h/14) patches, so a full-res webcam frame
 * (e.g. 1280x720 -> ~4600 tokens) is 4-9x more expensive to prefill than a
 * 512px version (~1000 tokens). On a CPU-only Ollama box that is the
 * difference between a 50s analysis and a <15s one.
 *
 * Returns the original input unchanged (data: prefix preserved) when the image
 * cannot be decoded or sharp is unavailable, so a resize failure never breaks
 * a vision request.
 */
export const VISION_VLM_MAX_DIM = 512;

export function stripDataUrlPrefix(image: string): string {
  if (image.startsWith("data:")) {
    const comma = image.indexOf(",");
    if (comma >= 0) return image.slice(comma + 1);
  }
  return image;
}

export async function resizeImageForVlm(
  input: string,
  maxDim = VISION_VLM_MAX_DIM
): Promise<string> {
  try {
    const resized = await sharp(Buffer.from(stripDataUrlPrefix(input), "base64"))
      .rotate()
      .resize({
        width: maxDim,
        height: maxDim,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82 })
      .toBuffer();
    return resized.toString("base64");
  } catch {
    return input;
  }
}
