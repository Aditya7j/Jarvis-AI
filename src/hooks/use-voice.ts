"use client";

import { useEffect, useRef, useCallback } from "react";
import { useVoiceStore } from "@/stores/voice-store";
import { useConversationStore } from "@/stores/conversation-store";
import { isSpeechRecognitionSupported, transcribeViaServer } from "@/lib/stt";
import { tts, isTtsSupported } from "@/lib/tts";
import { triggerInterrupt } from "@/lib/interrupt";
import {
  VoiceSessionController,
  logVoiceEvent,
  type RecognitionLike,
} from "@/lib/voice/lifecycle";

const WAKE_WORD = "hey jarvis";
const DEEPGRAM_MAX_RECORDING_MS = 20_000;

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

type SpeechRecognitionCtor = new () => RecognitionLike;

function getSpeechRecognitionAPI(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
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

function normalizeForEcho(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isEcho(transcript: string, spokenText: string): boolean {
  if (!spokenText) return false;
  const t = normalizeForEcho(transcript);
  if (t.length < 4) return false;
  const s = normalizeForEcho(spokenText);
  return s.length > 0 && s.includes(t);
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
    case "unsupported":
      return "Live voice input is not supported in this browser. Use Chrome or Edge for wake-word listening, or type your message.";
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
  const controllerRef = useRef<VoiceSessionController | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const lastSpokenRef = useRef("");

  const handleFinal = useCallback(
    (transcript: string) => {
      const lower = transcript.toLowerCase();
      if (isInterruptPhrase(lower)) {
        console.info(
          `[STT] Interrupt command detected: "${transcript.trim()}"`
        );
        listeningModeRef.current = true;
        setState("idle");
        setInterimTranscript("");
        triggerInterrupt();
        return;
      }
      if (listeningModeRef.current) {
        const wakeIndex = lower.indexOf(WAKE_WORD);
        if (wakeIndex !== -1) {
          listeningModeRef.current = false;
          setState("listening");
          const command = transcript
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
        const command = transcript.trim();
        if (command) {
          const speaking = tts.isSpeaking;
          if (speaking && isEcho(command, lastSpokenRef.current)) {
            console.info(`[STT] Ignoring echo while speaking: "${command}"`);
            setInterimTranscript("");
            return;
          }
          if (speaking) {
            console.info(
              `[STT] New command while speaking — interrupting: "${command}"`
            );
            triggerInterrupt();
          }
          console.info(`[STT] Final transcript: "${command}"`);
          setTranscript(command);
          setTranscription(command);
        }
        setInterimTranscript("");
        if (useVoiceStore.getState().continuousMode) {
          if (recognitionActiveRef.current) {
            setState("listening");
          }
        }
      }
    },
    [setState, setTranscript, setInterimTranscript, setTranscription]
  );
  const handleFinalRef = useRef(handleFinal);
  handleFinalRef.current = handleFinal;

  const handleInterim = useCallback(
    (transcript: string) => {
      if (listeningModeRef.current) return;
      const cleaned = stripWakeWord(transcript);
      setInterimTranscript(cleaned || transcript);
    },
    [setInterimTranscript]
  );
  const handleInterimRef = useRef(handleInterim);
  handleInterimRef.current = handleInterim;

  const handleError = useCallback(
    (code: string) => {
      const message = micErrorMessage(code);
      if (message) {
        setMicError({ code: "recognition-error", message });
      }
    },
    [setMicError]
  );
  const handleErrorRef = useRef(handleError);
  handleErrorRef.current = handleError;

  const resumeContinuousMode = useCallback(() => {
    if (!isRunning.current) return;
    listeningModeRef.current = false;
    console.info("[MIC] Continuous mode — resuming listening");
    controllerRef.current?.resume();
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
        if (controllerRef.current?.isPaused) {
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

  const stopServerRecording = useCallback(
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

      logVoiceEvent("MIC_STOPPED", "media recorder");

      const flushed = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      try {
        recorder.stop();
      } catch (error) {
        console.error("[STT] Failed to stop MediaRecorder:", error);
        stream?.getTracks().forEach((track) => track.stop());
        if (transcribe) {
          logVoiceEvent("ERROR", "recorder stop failed");
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
          window.setTimeout(resolve, 2_000)
        ),
      ]);

      stream?.getTracks().forEach((track) => track.stop());

      if (!transcribe) return;

      const mimeType = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      if (blob.size === 0) {
        logVoiceEvent("ERROR", "empty recording");
        setMicError({
          code: "recognition-error",
          message: "No audio was captured. Try speaking closer to the mic.",
        });
        return;
      }

      logVoiceEvent("STT_STARTED", "server transcription");
      try {
        const text = await transcribeViaServer(blob, mimeType);
        const trimmed = text.trim();
        if (trimmed) {
          console.info(`[STT] Server transcript: "${trimmed}"`);
          logVoiceEvent("STT_FINISHED", `"${trimmed}"`);
          setTranscript(trimmed);
          setTranscription(trimmed);
        } else {
          logVoiceEvent("ERROR", "no speech detected");
          setMicError({
            code: "recognition-error",
            message: "No speech was detected in the recording. Try again.",
          });
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Speech-to-text failed. Install Whisper locally or use Chrome/Edge.";
        logVoiceEvent("ERROR", "server transcription failed");
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
      controllerRef.current?.resume();
      if (recognitionActiveRef.current) {
        setState("listening");
      }
      return;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      await stopServerRecording(true);
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
        logVoiceEvent("ERROR", "media recorder error");
        setMicError({
          code: "recognition-error",
          message: "Microphone recording failed. Try again.",
        });
        setState("idle");
        void stopServerRecording(false);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      console.info("[MIC] MediaRecorder started");
      logVoiceEvent("MIC_STARTED", "media recorder");
      setState("listening");
      setMicActive(true);
      timerRef.current = window.setTimeout(() => {
        void stopServerRecording(true);
      }, DEEPGRAM_MAX_RECORDING_MS);
    } catch (error) {
      const name = (error as { name?: string })?.name;
      logVoiceEvent("ERROR", `mic access: ${name ?? "unknown"}`);
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
  }, [setMicError, setState, setMicActive, stopServerRecording, setInterimTranscript]);

  const stopListening = useCallback(() => {
    if (useVoiceStore.getState().continuousMode) {
      useVoiceStore.getState().setContinuousMode(false);
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      void stopServerRecording(true);
      setState("idle");
      return;
    }
    console.info("[MIC] Returning to wake-word standby");
    listeningModeRef.current = true;
    setState("idle");
    setTranscript("");
    setInterimTranscript("");
    setMicActive(false);
  }, [setState, setTranscript, setInterimTranscript, setMicActive, stopServerRecording]);

  useEffect(() => {
    const SpeechRecognitionCtor = getSpeechRecognitionAPI();
    if (!SpeechRecognitionCtor) return;

    const controller = new VoiceSessionController({
      createRecognition: () => new SpeechRecognitionCtor(),
      onFinal: (text) => handleFinalRef.current(text),
      onInterim: (text) => handleInterimRef.current(text),
      onError: (code) => handleErrorRef.current(code),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe((event) => {
      recognitionActiveRef.current = controller.isRecognizing;
      if (event.name === "MIC_STARTED" && !listeningModeRef.current) {
        setState("listening");
      }
    });

    isRunning.current = true;
    listeningModeRef.current = true;
    console.info("[MIC] Wake-word detection enabled");
    controller.start();

    return () => {
      console.info("[MIC] Cleaning up voice pipeline");
      isRunning.current = false;
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
      recognitionActiveRef.current = false;
      tts.stop();
      void stopServerRecording(false);
    };
  }, [setState, stopServerRecording]);

  useEffect(() => {
    return tts.subscribe((speaking) => {
      if (speaking) {
        logVoiceEvent("TTS_STARTED");
        controllerRef.current?.pause("assistant speaking");
        setState("speaking");
      } else {
        logVoiceEvent("TTS_FINISHED");
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
    lastSpokenRef.current = text;
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
