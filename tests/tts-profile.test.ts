import { describe, it, expect, beforeEach } from "vitest";
import { JARVIS_VOICE_PROFILE } from "@/lib/tts-profile";
import { loadEnvConfig } from "@/lib/ai/config";

const PIPER_VOICE = "PIPER_VOICE";

beforeEach(() => {
  delete process.env[PIPER_VOICE];
});

describe("JARVIS voice profile", () => {
  it("defines the male deep-confident JARVIS profile", () => {
    expect(JARVIS_VOICE_PROFILE.gender).toBe("male");
    expect(JARVIS_VOICE_PROFILE.character).toBe("deep-confident");
    expect(JARVIS_VOICE_PROFILE.speakingRate).toBe(1.0);
    // Slightly lowered pitch for a deeper, confident delivery.
    expect(JARVIS_VOICE_PROFILE.pitch).toBeGreaterThan(0.5);
    expect(JARVIS_VOICE_PROFILE.pitch).toBeLessThan(1);
  });

  it("selects a known male Piper model and deepens it after synthesis", () => {
    expect(JARVIS_VOICE_PROFILE.piperVoice).toMatch(
      /en_US-ryan-high|hfc_male|northern_english_male/
    );
    expect(JARVIS_VOICE_PROFILE.piperPitchCents).toBeLessThan(0);
  });

  it("prefers a male browser voice list for the SpeechSynthesis fallback", () => {
    expect(JARVIS_VOICE_PROFILE.preferredBrowserVoiceNames).toContain("male");
    expect(JARVIS_VOICE_PROFILE.preferredBrowserVoiceNames.length).toBeGreaterThan(0);
  });

  it("applies the male Piper voice as the server default when PIPER_VOICE is unset", () => {
    expect(loadEnvConfig().piperVoice).toBe(JARVIS_VOICE_PROFILE.piperVoice);
  });

  it("keeps the profile overridable via PIPER_VOICE", () => {
    process.env[PIPER_VOICE] = "en_US-lessac-medium";
    expect(loadEnvConfig().piperVoice).toBe("en_US-lessac-medium");
  });
});
