/**
 * Lightweight client-side change detection. Consecutive frames of the same
 * scene encode to byte-identical JPEGs, so a hash of the base64 payload is a
 * reliable "did the scene change?" signal that costs ~1ms and avoids decoding
 * the frame. The live session skips POSTing unchanged frames to keep the
 * server analyzing only meaningful change.
 */
export function frameFingerprint(dataUrl: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < dataUrl.length; i += 4) {
    hash ^= dataUrl.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
