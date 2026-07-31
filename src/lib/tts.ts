"use client";

const CHUNK_MAX_CHARS = 200;
const SPEAK_AFTER_CANCEL_MS = 80;

type TTSListener = (speaking: boolean) => void;

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`/g, "")
    .replace(/[*_~#>()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunkText(text: string): string[] {
  const normalized = cleanForSpeech(text);
  if (!normalized) return [];
  const sentences =
    normalized.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [normalized];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = (current + " " + sentence).trim();
    if (candidate.length > CHUNK_MAX_CHARS && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const enUs = voices.filter((v) => v.lang.toLowerCase().startsWith("en-us"));
  const pool = enUs.length > 0 ? enUs : voices;
  return (
    pool.find((v) => /google/i.test(v.name)) ??
    pool.find((v) => !v.localService) ??
    pool[0] ??
    null
  );
}

class TTSManager {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private queue: string[] = [];
  private currentSpeaking = false;
  private generation = 0;
  private readonly listeners = new Set<TTSListener>();

  constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      this.synth = window.speechSynthesis;
      this.loadVoices();
      this.synth.onvoiceschanged = () => this.loadVoices();
    }
  }

  private loadVoices(): void {
    if (!this.synth) return;
    const voices = this.synth.getVoices();
    if (voices.length === 0) return;
    this.voice = pickVoice(voices);
    console.info(
      `[TTS] Voices loaded (${voices.length}); using "${this.voice?.name ?? "default"}"`
    );
  }

  get isSpeaking(): boolean {
    return this.currentSpeaking;
  }

  subscribe(listener: TTSListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(speaking: boolean): void {
    this.listeners.forEach((listener) => listener(speaking));
  }

  speak(text: string, onStart?: () => void, onEnd?: () => void): void {
    if (!this.synth) {
      console.warn("[TTS] Speech synthesis unavailable");
      return;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) return;

    const generation = ++this.generation;
    this.synth.cancel();
    this.queue = chunks;
    this.currentSpeaking = true;
    console.info(
      `[TTS] Speaking ${chunks.length} chunk(s), ${text.length} chars`
    );
    this.notify(true);

    window.setTimeout(() => {
      if (generation !== this.generation) return;
      onStart?.();
      this.speakNext(generation, onEnd);
    }, SPEAK_AFTER_CANCEL_MS);
  }

  private speakNext(generation: number, onEnd?: () => void): void {
    if (!this.synth || generation !== this.generation) return;
    if (this.queue.length === 0) {
      this.finish(generation, onEnd);
      return;
    }
    if (this.synth.paused) {
      this.synth.resume();
    }
    const chunk = this.queue.shift()!;
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (this.voice) {
      utterance.voice = this.voice;
      utterance.lang = this.voice.lang;
    }
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.onend = () => this.speakNext(generation, onEnd);
    utterance.onerror = (event) => {
      console.warn(`[TTS] Utterance error: ${event.error}`);
      this.speakNext(generation, onEnd);
    };
    this.synth.speak(utterance);
  }

  private finish(generation: number, onEnd?: () => void): void {
    if (generation !== this.generation) return;
    this.currentSpeaking = false;
    this.queue = [];
    this.notify(false);
    onEnd?.();
    console.info("[TTS] Finished speaking");
  }

  stop(): void {
    if (!this.synth) return;
    this.generation++;
    this.queue = [];
    this.synth.cancel();
    if (this.currentSpeaking) {
      this.currentSpeaking = false;
      this.notify(false);
    }
    console.info("[TTS] Speech stopped");
  }
}

export function isTtsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export const tts = new TTSManager();
