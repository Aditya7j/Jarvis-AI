"use client";

import { useEffect } from "react";
import { soundFX, type SoundEvent } from "@/lib/audio/sound-service";
import type { AIState } from "@/types";
import { useConversationStore } from "@/stores/conversation-store";
import { useVoiceStore } from "@/stores/voice-store";

/**
 * Pure mapping from an AI/voice state transition to a sound effect. Returns
 * null when no effect should play (e.g. no-op transitions). Transition-based
 * so every effect fires at most once per lifecycle step and never loops.
 */
export function stateTransitionSound(
  prev: AIState,
  next: AIState
): SoundEvent | null {
  if (prev === next) return null;
  if (next === "speaking") return "response-start";
  // Leaving the speaking state closes the TTS turn (interrupts too).
  if (prev === "speaking") return "response-end";
  // Never play the thinking cue while TTS is speaking (handled above).
  if (next === "thinking") return "thinking";
  if (next === "listening") return "listening";
  return null;
}

/**
 * Binds Jarvis's AI/voice state transitions to the sound-effects layer.
 *
 *   conversation store:   thinking → THINKING_START
 *                         speaking → RESPONSE_START (right before TTS)
 *                         speaking → … → RESPONSE_END
 *   voice store:          listening → LISTENING_START
 *
 * The wake-word tone (JARVIS_WAKE) is triggered at the exact moment the wake
 * word is recognized inside the voice hook (see use-voice.ts).
 */
export function useSoundEffects(): void {
  useEffect(() => {
    soundFX.preload();
    return useConversationStore.subscribe((state, prev) => {
      const event = stateTransitionSound(prev.state, state.state);
      if (event) soundFX.play(event);
    });
  }, []);

  useEffect(() => {
    return useVoiceStore.subscribe((state, prev) => {
      const event = stateTransitionSound(prev.state, state.state);
      if (event) soundFX.play(event);
    });
  }, []);
}
