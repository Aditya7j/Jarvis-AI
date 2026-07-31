"use client";

import { useEffect, useRef, useCallback } from "react";
import { useVoiceStore } from "@/stores/voice-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  isSpeechRecognitionSupported,
  transcribeViaDeepgram,
} from "@/lib/stt";
import { tts, isTtsSupported } from "@/lib/tts";
import { triggerInterrupt } from "@/lib/interrupt";

const WAKE_WORD = "hey jarvis";
const DEEPGRAM_MAX_RECORDING_MS = 20_000;
const RESTART_DELAY_MS = 300;
const RESTART_AFTER_CLOSE_MS = 150;
const RECORDER_FLUSH_TIMEOUT_MS = 2_000;

const INTERRUPT_PHRASES = [
  "stop",
  "stop talking",
  "stop speaking",
  "stop talking now",
  "shut up",
  "never mind",
  "nevermind",
  "that's enough",
  "cancel",
];

type SpeechRecognitionLike = Pick<
  SpeechRecognition,
  "continuous" | "interimResults" | "lang" | "start" | "stop" | "abort"
> & {
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

function getSpeechRecognitionAPI():
  | (new () => SpeechRecognitionLike)
  | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function stripWakeWord(text: string): string {
  return text.replace(new RegExp(`^${WAKE_WORD}`, "i"), "").trim();
}

function isInterruptPhrase(text: string): boolean {
  const cleaned = stripWakeWord(text);
  return INTERRUPT_PHRASES.includes(text) || INTERRUPT_PHRASES.includes(cleaned);
}

function micErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission was denied. Allow mic access in your browser settings to talk to JARVIS.";
    case "audio-capture":
      return "No microphone was detected. Plug in a mic and try again.";
    case "network":
      return "Speech recognition needs a network connection. Check your internet and try again.";
    case "no-speech":
      return "";
    default:
      return `Speech recognition error: ${code}`;
  }
}

export function useVoice() {
  const state = useVoiceStore((s) => s.state);
  const setState = useVoiceStore((s) => s.setState);
  const setTranscript = useVoiceStore((s) => s.setTranscript);
  const setInterimTranscript = useVoiceStore((s) => s.setInterimTranscript);
  const setMicActive = useVoiceStore((s) => s.setMicActive);
  const setRecordingMs = useVoiceStore((s) => s.setRecordingMs);
  const setMicError = useVoiceStore((s) => s.setMicError);
  const setTranscription = useConversationStore((s) => s.setTranscription);

  const isRunning = useRef(false);
  const listeningModeRef = useRef(true);
  const recognitionActiveRef = useRef(false);
  const pausedRef = useRef(false);
  const activeSessionRef = useRef<SpeechRecognitionLike | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const startSession = useCallback(() => {
    if (!isRunning.current) return;
    const SpeechRecognitionAPI = getSpeechRecognitionAPI();
    if (!SpeechRecognitionAPI) {
      setMicError({
        code: "unsupported",
        message:
          "Live voice input is not supported in this browser. Use Chrome or Edge for wake-word listening, or type your message.",
      });
      return;
    }

    if (activeSessionRef.current) {
      if (!recognitionActiveRef.current) {
        scheduleRestartRef.current(
          "awaiting previous session close",
          RESTART_AFTER_CLOSE_MS
        );
      }
      return;
    }

    const recognition = new SpeechRecognitionAPI();
    activeSessionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      console.info("[STT] Recognition session started");
      recognitionActiveRef.current = true;
      if (!listeningModeRef.current) {
        setState("listening");
      }
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i][0].transcript;
        const lower = result.toLowerCase();
        if (event.results[i].isFinal) {
          if (isInterruptPhrase(lower)) {
            console.info(
              `[STT] Interrupt command detected: "${result.trim()}"`
            );
            listeningModeRef.current = true;
            setState("idle");
            setInterimTranscript("");
            triggerInterrupt();
            continue;
          }
          if (listeningModeRef.current) {
            const wakeIndex = lower.indexOf(WAKE_WORD);
            if (wakeIndex !== -1) {
              listeningModeRef.current = false;
              setState("listening");
              const command = result
                .slice(wakeIndex + WAKE_WORD.length)
                .trim();
              if (command) {
                console.info(`[STT] Command captured: "${command}"`);
                setInterimTranscript("");
                setTranscript(command);
                setTranscription(command);
              }
            }
          } else {
            const command = result.trim();
            if (command) {
              console.info(`[STT] Final transcript: "${command}"`);
              setTranscript(command);
              setTranscription(command);
            }
            setInterimTranscript("");
            if (useVoiceStore.getState().continuousMode) {
              pausedRef.current = true;
              setState("idle");
              console.info(
                "[STT] Continuous mode — ending utterance, pausing for this turn"
              );
              try {
                recognition.stop();
              } catch {
                // session may already be closing
              }
            }
          }
        } else {
          if (!listeningModeRef.current) {
            const cleaned = stripWakeWord(result);
            setInterimTranscript(cleaned || result);
          }
        }
      }
    };

    recognition.onend = () => {
      recognitionActiveRef.current = false;
      if (activeSessionRef.current === recognition) {
        activeSessionRef.current = null;
      }
      if (!isRunning.current) return;
      if (pausedRef.current) {
        console.info("[STT] Recognition paused — waiting for turn to finish");
        return;
      }
      scheduleRestartRef.current("session ended", RESTART_DELAY_MS);
    };

    recognition.onerror = (e) => {
      if (e.error === "aborted") return;
      console.warn(`[STT] Recognition error: ${e.error}`);
      const message = micErrorMessage(e.error);
      if (message) {
        setMicError({ code: "recognition-error", message });
      }
    };

    try {
      recognition.start();
      recognitionActiveRef.current = true;
      console.info("[STT] Recognition start requested");
    } catch (error) {
      console.error("[STT] Failed to start recognition:", error);
      activeSessionRef.current = null;
      if (isRunning.current) {
        setMicError({
          code: "recognition-error",
          message:
            "Voice recognition failed to start. Check your internet connection and try again.",
        });
        scheduleRestartRef.current("start failed", RESTART_DELAY_MS);
      }
    }
  }, [setState, setTranscript, setInterimTranscript, setTranscription, setMicError]);

  const scheduleRestart = useCallback((reason: string, delay: number) => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
    }
    console.warn(`[STT] Restarting recognition (${reason}) in ${delay}ms`);
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = null;
      startSessionRef.current();
    }, delay);
  }, []);

  const startSessionRef = useRef(startSession);
  startSessionRef.current = startSession;
  const scheduleRestartRef = useRef(scheduleRestart);
  scheduleRestartRef.current = scheduleRestart;

  const resumeContinuousMode = useCallback(() => {
    if (!isRunning.current) return;
    pausedRef.current = false;
    listeningModeRef.current = false;
    console.info("[MIC] Continuous mode — resuming listening");
    startSessionRef.current();
    if (recognitionActiveRef.current) {
      setState("listening");
    }
  }, [setState]);

  const resumeContinuousRef = useRef(resumeContinuousMode);
  resumeContinuousRef.current = resumeContinuousMode;

  const setContinuousMode = useCallback(
    (enabled: boolean) => {
      const store = useVoiceStore.getState();
      if (enabled === store.continuousMode) return;
      store.setContinuousMode(enabled);
      if (enabled) {
        if (pausedRef.current) {
          console.info(
            "[MIC] Continuous mode enabled — will resume after current turn"
          );
          return;
        }
        listeningModeRef.current = false;
        if (recognitionActiveRef.current) {
          console.info("[MIC] Continuous mode enabled — listening now");
          setState("listening");
        } else {
          resumeContinuousRef.current();
        }
      } else {
        console.info("[MIC] Continuous mode disabled — wake-word standby");
        listeningModeRef.current = true;
        setState("idle");
      }
    },
    [setState]
  );

  const stopDeepgramRecording = useCallback(
    async (transcribe: boolean): Promise<void> => {
      const recorder = mediaRecorderRef.current;
      const stream = mediaStreamRef.current;
      mediaRecorderRef.current = null;
      mediaStreamRef.current = null;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (!recorder || recorder.state === "inactive") {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }

      const flushed = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      try {
        recorder.stop();
      } catch (error) {
        console.error("[STT] Failed to stop MediaRecorder:", error);
        stream?.getTracks().forEach((track) => track.stop());
        if (transcribe) {
          setMicError({
            code: "recognition-error",
            message: "Recording stopped unexpectedly. Try again.",
          });
        }
        return;
      }

      await Promise.race([
        flushed,
        new Promise((resolve) =>
          window.setTimeout(resolve, RECORDER_FLUSH_TIMEOUT_MS)
        ),
      ]);

      stream?.getTracks().forEach((track) => track.stop());

      if (!transcribe) return;

      const mimeType = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      if (blob.size === 0) {
        setMicError({
          code: "recognition-error",
          message: "No audio was captured. Try speaking closer to the mic.",
        });
        return;
      }

      try {
        const text = await transcribeViaDeepgram(blob, mimeType);
        const trimmed = text.trim();
        if (trimmed) {
          console.info(`[STT] Deepgram transcript: "${trimmed}"`);
          setTranscript(trimmed);
          setTranscription(trimmed);
        } else {
          setMicError({
            code: "recognition-error",
            message: "No speech was detected in the recording. Try again.",
          });
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Speech-to-text failed. Set DEEPGRAM_API_KEY in .env or use Chrome/Edge.";
        setMicError({ code: "transcription-failed", message });
      }
    },
    [setMicError, setTranscript, setTranscription]
  );

  const startListening = useCallback(async () => {
    setMicError(null);
    setInterimTranscript("");

    if (getSpeechRecognitionAPI()) {
      listeningModeRef.current = false;
      if (recognitionActiveRef.current) {
        console.info("[MIC] Listen mode enabled (session already active)");
        setState("listening");
        return;
      }
      if (!isRunning.current) {
        isRunning.current = true;
      }
      console.info("[MIC] Starting listen session");
      startSessionRef.current();
      if (recognitionActiveRef.current) {
        setState("listening");
      }
      return;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      await stopDeepgramRecording(true);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError({
        code: "unsupported",
        message:
          "Voice input is not available in this browser. Use Chrome or Edge for built-in speech recognition, or set DEEPGRAM_API_KEY in .env.",
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeTypes = ["audio/webm", "audio/ogg", "audio/mpeg"];
      const mimeType = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = (event) => {
        console.error("[MIC] MediaRecorder error:", event);
        setMicError({
          code: "recognition-error",
          message: "Microphone recording failed. Try again.",
        });
        setState("idle");
        void stopDeepgramRecording(false);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      console.info("[MIC] MediaRecorder started");
      setState("listening");
      setMicActive(true);
      timerRef.current = window.setTimeout(() => {
        void stopDeepgramRecording(true);
      }, DEEPGRAM_MAX_RECORDING_MS);
    } catch (error) {
      const name = (error as { name?: string })?.name;
      setState("idle");
      if (name === "NotAllowedError") {
        setMicError({
          code: "permission-denied",
          message:
            "Microphone permission was denied. Allow mic access in your browser settings to talk to JARVIS.",
        });
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setMicError({
          code: "device-unavailable",
          message: "No microphone was detected. Plug in a mic and try again.",
        });
      } else {
        setMicError({
          code: "device-unavailable",
          message: `Could not access the microphone (${name ?? "unknown error"}).`,
        });
      }
    }
  }, [setMicError, setState, setMicActive, stopDeepgramRecording, setInterimTranscript]);

  const stopListening = useCallback(() => {
    if (useVoiceStore.getState().continuousMode) {
      useVoiceStore.getState().setContinuousMode(false);
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      void stopDeepgramRecording(true);
      setState("idle");
      return;
    }
    console.info("[MIC] Returning to wake-word standby");
    listeningModeRef.current = true;
    setState("idle");
    setTranscript("");
    setInterimTranscript("");
    setMicActive(false);
  }, [setState, setTranscript, setInterimTranscript, setMicActive, stopDeepgramRecording]);

  const startWakeWordDetection = useCallback(() => {
    if (isRunning.current) return;
    isRunning.current = true;
    listeningModeRef.current = true;
    console.info("[MIC] Wake-word detection enabled");
    startSessionRef.current();
  }, []);

  useEffect(() => {
    if (isSpeechRecognitionSupported()) {
      startWakeWordDetection();
    }
    return () => {
      console.info("[MIC] Cleaning up voice pipeline");
      isRunning.current = false;
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      const session = activeSessionRef.current;
      if (session) {
        try { session.abort(); } catch {}
        try { session.stop(); } catch {}
      }
      activeSessionRef.current = null;
      tts.stop();
      void stopDeepgramRecording(false);
    };
  }, [startWakeWordDetection, stopDeepgramRecording]);

  useEffect(() => {
    return tts.subscribe((speaking) => {
      if (speaking) {
        setState("speaking");
      } else {
        if (useVoiceStore.getState().continuousMode) {
          resumeContinuousRef.current();
        } else {
          listeningModeRef.current = true;
          setState("idle");
        }
      }
    });
  }, [setState]);

  useEffect(() => {
    if (state === "listening") {
      setMicActive(true);
      const startedAt = Date.now();
      const timer = window.setInterval(() => {
        setRecordingMs(Date.now() - startedAt);
      }, 1000);
      return () => {
        window.clearInterval(timer);
        setMicActive(false);
        setRecordingMs(0);
      };
    }
    return undefined;
  }, [state, setMicActive, setRecordingMs]);

  const speak = useCallback((text: string) => {
    if (!isTtsSupported()) {
      console.warn("[TTS] Speech synthesis not supported");
      if (useVoiceStore.getState().continuousMode) {
        window.setTimeout(() => resumeContinuousRef.current(), 400);
      }
      return;
    }
    console.info(`[TTS] Speaking response (${text.length} chars)`);
    tts.speak(
      text,
      () => useConversationStore.getState().setState("speaking"),
      () => useConversationStore.getState().setState("idle")
    );
  }, []);

  const isSttSupported = useCallback(() => isSpeechRecognitionSupported(), []);

  return {
    state,
    startListening,
    stopListening,
    speak,
    setContinuousMode,
    resumeContinuousMode,
    isSttSupported,
  };
}
