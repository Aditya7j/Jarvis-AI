"use client";

const CHUNK_MAX_CHARS = 200;
const SPEAK_AFTER_CANCEL_MS = 80;
const PIPER_STATUS_TTL_MS = 30_000;

type TTSListener = (speaking: boolean) => void;

let piperStatusCache: { available: boolean; checkedAt: number } | null = null;

async function piperAvailable(): Promise<boolean> {
  if (
    piperStatusCache &&
    Date.now() - piperStatusCache.checkedAt < PIPER_STATUS_TTL_MS
  ) {
    return piperStatusCache.available;
  }
  try {
    const res = await fetch("/api/tts/status");
    const body = (await res.json()) as { piper?: { available?: boolean } };
    piperStatusCache = {
      available: Boolean(body?.piper?.available),
      checkedAt: Date.now(),
    };
  } catch {
    piperStatusCache = { available: false, checkedAt: Date.now() };
  }
  return piperStatusCache.available;
}

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

type AudioContextCtor = typeof AudioContext;

class TTSManager {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private queue: string[] = [];
  private currentSpeaking = false;
  private generation = 0;
  private readonly listeners = new Set<TTSListener>();
  private audioContext: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;

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
    const generation = ++this.generation;
    this.queue = [];
    this.synth?.cancel();
    this.currentSpeaking = true;
    console.info(
      `[TTS] Speaking ${text.length} chars (piper-first)`
    );
    this.notify(true);

    window.setTimeout(() => {
      if (generation !== this.generation) return;
      onStart?.();
      void this.dispatch(text, generation, onEnd);
    }, SPEAK_AFTER_CANCEL_MS);
  }

  private async dispatch(
    text: string,
    generation: number,
    onEnd?: () => void
  ): Promise<void> {
    if (await piperAvailable()) {
      try {
        const spoken = await this.speakViaPiper(text, generation, onEnd);
        if (spoken) return;
      } catch (error) {
        console.warn("[TTS] Piper synthesis failed:", error);
      }
      piperStatusCache = { available: false, checkedAt: Date.now() };
    }
    if (generation !== this.generation) return;
    this.speakBrowser(text, generation, onEnd);
  }

  private async speakViaPiper(
    text: string,
    generation: number,
    onEnd?: () => void
  ): Promise<boolean> {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: cleanForSpeech(text) }),
    });
    if (!res.ok) return false;
    const arrayBuffer = await res.arrayBuffer();
    if (generation !== this.generation) return true;
    await this.playWav(arrayBuffer, generation);
    if (generation === this.generation) {
      this.finish(generation, onEnd);
    }
    return true;
  }

  private async playWav(
    arrayBuffer: ArrayBuffer,
    generation: number
  ): Promise<void> {
    const AudioContextCtor: AudioContextCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor })
        .webkitAudioContext;
    if (!AudioContextCtor) throw new Error("WebAudio unavailable");
    if (!this.audioContext) {
      this.audioContext = new AudioContextCtor();
    }
    const ctx = this.audioContext;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    if (generation !== this.generation) return;
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    this.activeSource = source;
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    if (this.activeSource === source) {
      this.activeSource = null;
    }
  }

  private speakBrowser(text: string, generation: number, onEnd?: () => void): void {
    if (!this.synth) {
      this.finish(generation, onEnd);
      return;
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      this.finish(generation, onEnd);
      return;
    }
    this.queue = chunks;
    console.info(
      `[TTS] Browser fallback — speaking ${chunks.length} chunk(s), ${text.length} chars`
    );
    this.speakNext(generation, onEnd);
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
    this.generation++;
    this.queue = [];
    if (this.synth) {
      this.synth.cancel();
    }
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // source may already have ended
      }
      this.activeSource = null;
    }
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
