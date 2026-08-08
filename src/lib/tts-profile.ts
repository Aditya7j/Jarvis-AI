/**
 * Centralized JARVIS voice configuration.
 *
 * Change the voice here (or override PIPER_VOICE in .env for the Piper path).
 * - Piper model: en_US-ryan-high (male, deep) is the default. Other suitable
 *   male models: en_US-hfc_male-medium, en_GB-northern_english_male-medium.
 *   Piper voices are chosen at install/download time — if the model file is not
 *   installed, the client automatically falls back to the browser voice with
 *   the male preferences below.
 * - Browser (SpeechSynthesis) fallback: prefers a male voice from
 *   `preferredBrowserVoiceNames` and applies `pitch`/`speakingRate`.
 * - Piper WAV is post-processed with a subtle pitch drop (`piperPitchCents`).
 */
export const JARVIS_VOICE_PROFILE = {
  gender: "male" as const,
  character: "deep-confident" as const,
  /** Browser SpeechSynthesis rate multiplier (1.0 = natural pace). */
  speakingRate: 1.0,
  /** Browser SpeechSynthesis pitch (0 = lowest, 1 = default, 2 = highest). */
  pitch: 0.85,
  /** Piper ONNX model name used as the primary male voice. */
  piperVoice: "en_US-ryan-high",
  /** Piper WAV pitch shift in cents after synthesis (negative = deeper). */
  piperPitchCents: -60,
  /** Browser voice names to prefer (male), in priority order. */
  preferredBrowserVoiceNames: [
    "ryan",
    "david",
    "daniel",
    "george",
    "guy",
    "aaron",
    "james",
    "male",
  ],
} as const;

export type JarvisVoiceProfile = typeof JARVIS_VOICE_PROFILE;
