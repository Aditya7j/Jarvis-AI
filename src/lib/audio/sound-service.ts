/**
 * JARVIS Sound Effects Layer.
 *
 * A completely independent, client-only audio service. It plays short, original,
 * pre-synthesized UI sounds from /public/sounds and never interacts with the
 * AI pipeline, the microphone, STT, or TTS:
 *
 *   - Non-blocking: `play()` returns immediately (void) and every internal
 *     async step (fetch/decode) runs in the background during `preload()`.
 *   - Preloaded: WAV buffers are decoded once ahead of time; triggering a sound
 *     after preload just schedules a decoded AudioBuffer (<50ms).
 *   - Local assets only: no remote URLs, no dynamic audio generation.
 *   - Mic-safe: this module never touches getUserMedia/MediaRecorder and never
 *     creates a microphone stream, so sound effects cannot enter the STT
 *     pipeline or make Jarvis hear itself.
 *   - Configurable: enable/disable and volume (0..1), persisted to localStorage.
 */

export const SOUND_EVENTS = [
  "wake",
  "listening",
  "thinking",
  "tool",
  "vision",
  "response-start",
  "response-end",
  "error",
  "camera-on",
  "camera-off",
] as const;

export type SoundEvent = (typeof SOUND_EVENTS)[number];

export const SOUND_FILES: Record<SoundEvent, string> = {
  wake: "/sounds/wake.wav",
  listening: "/sounds/listening.wav",
  thinking: "/sounds/thinking.wav",
  tool: "/sounds/tool.wav",
  vision: "/sounds/vision.wav",
  "response-start": "/sounds/response-start.wav",
  "response-end": "/sounds/response-end.wav",
  error: "/sounds/error.wav",
  "camera-on": "/sounds/camera-on.wav",
  "camera-off": "/sounds/camera-off.wav",
};

export const DEFAULT_SOUND_ENABLED = true;
export const DEFAULT_SOUND_VOLUME = 0.3;

const STORAGE_KEY_ENABLED = "jarvis.sound.enabled";
const STORAGE_KEY_VOLUME = "jarvis.sound.volume";
/** Coalescing window: a second trigger of the same sound within this window is
 * ignored so quick state flips can never stack duplicates. */
const MIN_PLAY_INTERVAL_MS = 90;

export interface SoundFXSettings {
  enabled: boolean;
  volume: number; // 0..1
}

export type SoundFXListener = (settings: SoundFXSettings) => void;

export interface SoundFXOptions {
  /** Injectable storage (tests). Defaults to window.localStorage. */
  storage?: Storage | null;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

type AudioContextCtor = typeof AudioContext;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createSoundFX(options: SoundFXOptions = {}): SoundFX {
  return new SoundFX(options);
}

export class SoundFX {
  private enabled = DEFAULT_SOUND_ENABLED;
  private volume = DEFAULT_SOUND_VOLUME;
  private readonly options: SoundFXOptions;
  private readonly listeners = new Set<SoundFXListener>();
  private ctx: AudioContext | null = null;
  private readonly buffers = new Map<SoundEvent, AudioBuffer>();
  private readonly loading = new Map<SoundEvent, Promise<void>>();
  private readonly lastPlayedAt = new Map<SoundEvent, number>();
  private preloadStarted = false;

  constructor(options: SoundFXOptions = {}) {
    this.options = options;
    this.loadSettings();
  }

  private get storage(): Storage | null {
    if (this.options.storage !== undefined) return this.options.storage;
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? globalThis.fetch;
  }

  private loadSettings(): void {
    const storage = this.storage;
    if (!storage) return;
    try {
      const enabled = storage.getItem(STORAGE_KEY_ENABLED);
      if (enabled !== null) {
        this.enabled = enabled !== "false";
      }
      const volume = storage.getItem(STORAGE_KEY_VOLUME);
      if (volume !== null) {
        this.volume = clamp01(Number(volume));
      }
    } catch {
      // storage access can throw (privacy mode) — keep defaults
    }
  }

  private persist(): void {
    const storage = this.storage;
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY_ENABLED, this.enabled ? "true" : "false");
      storage.setItem(STORAGE_KEY_VOLUME, String(this.volume));
    } catch {
      // ignore storage write failures
    }
  }

  private notify(): void {
    const settings = this.getState();
    this.listeners.forEach((listener) => listener(settings));
  }

  getState(): SoundFXSettings {
    return { enabled: this.enabled, volume: this.volume };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getVolume(): number {
    return this.volume;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.persist();
    this.notify();
  }

  setVolume(volume: number): void {
    const v = clamp01(volume);
    if (v === this.volume) return;
    this.volume = v;
    this.persist();
    this.notify();
  }

  subscribe(listener: SoundFXListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Background preload of every asset. Fire-and-forget; never blocks. */
  preload(): void {
    if (typeof window === "undefined") return;
    if (this.preloadStarted) return;
    this.preloadStarted = true;
    const ctor = getAudioContextCtor();
    if (!ctor) return;
    void (async () => {
      try {
        this.ctx = new ctor();
      } catch {
        this.ctx = null;
        return;
      }
      await Promise.allSettled(
        (SOUND_EVENTS as readonly SoundEvent[]).map((event) =>
          this.loadBuffer(event)
        )
      );
    })();
  }

  private async loadBuffer(event: SoundEvent): Promise<void> {
    const pending = this.loading.get(event);
    if (pending) return pending;
    const task = (async () => {
      const ctx = this.ctx;
      if (!ctx) throw new Error("No AudioContext");
      const res = await this.fetchImpl(SOUND_FILES[event]);
      if (!res.ok) throw new Error(`Sound load failed: ${res.status}`);
      const data = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(data);
      this.buffers.set(event, buffer);
    })();
    this.loading.set(event, task);
    try {
      await task;
    } finally {
      this.loading.delete(event);
    }
  }

  /** Coalesce rapid duplicate triggers of the same event. */
  private shouldCoalesce(event: SoundEvent): boolean {
    const now = Date.now();
    const last = this.lastPlayedAt.get(event) ?? 0;
    if (now - last < MIN_PLAY_INTERVAL_MS) return true;
    this.lastPlayedAt.set(event, now);
    return false;
  }

  /**
   * Play a sound effect. Synchronous, non-blocking: it returns immediately and
   * the audio is scheduled on the Web Audio graph (or an <audio> fallback).
   */
  play(event: SoundEvent): void {
    if (!this.enabled) return;
    if (typeof window === "undefined") return;
    if (this.shouldCoalesce(event)) return;

    const buffer = this.buffers.get(event);
    const ctx = this.ctx;
    if (buffer && ctx) {
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = this.volume;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(0);
        return;
      } catch {
        // fall through to the <audio> fallback if the graph throws
      }
    }

    // Fallback for browsers without Web Audio: a pre-primed <audio> element.
    try {
      const el = new Audio(SOUND_FILES[event]);
      el.volume = this.volume;
      el.play().catch(() => {});
    } catch {
      // audio playback unavailable — sound effects are optional by design
    }
  }
}

export const soundFX = createSoundFX();
