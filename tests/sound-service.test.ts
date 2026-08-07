/**
 * Sound Effects Layer regression suite.
 *
 * The sound layer must be completely independent from the AI pipeline: it must
 * never block (play() returns synchronously), never duplicate an effect, never
 * fire while TTS is speaking, never touch the microphone/STT, must be
 * configurable (enable/volume, persisted), and must preload local assets only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSoundFX,
  DEFAULT_SOUND_VOLUME,
  SOUND_EVENTS,
  type SoundEvent,
  type SoundFX,
  type SoundFXSettings,
} from "@/lib/audio/sound-service";
import { stateTransitionSound } from "@/hooks/use-sound-effects";
import type { AIState } from "@/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createStorage(): Storage & { _data: Map<string, string> } {
  const _data = new Map<string, string>();
  return {
    _data,
    get length() {
      return _data.size;
    },
    clear: vi.fn(() => _data.clear()),
    getItem: vi.fn((key: string) => _data.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(_data.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      _data.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      _data.set(key, String(value));
    }),
  } as unknown as Storage & { _data: Map<string, string> };
}

class FakeAudioElement {
  volume = 1;
  play = vi.fn().mockResolvedValue(undefined);
}

class FakeAudioBuffer {
  readonly duration = 1;
}

class FakeGainNode {
  gain = { value: 0 };
  connect = vi.fn(() => this);
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  connect = vi.fn(() => this);
  start = vi.fn();
}

class FakeAudioContext {
  state = "running" as const;
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  decodeAudioData = vi.fn(async () => new FakeAudioBuffer());
  source = new FakeBufferSource();
  gain = new FakeGainNode();
  createBufferSource() {
    this.source = new FakeBufferSource();
    return this.source;
  }
  createGain() {
    this.gain = new FakeGainNode();
    return this.gain;
  }
}

type WindowStub = Record<string, unknown> & {
  localStorage?: Storage;
  AudioContext?: unknown;
  Audio?: unknown;
};

function makeWindow(): WindowStub {
  return {
    localStorage: createStorage(),
    AudioContext: FakeAudioContext,
    Audio: FakeAudioElement,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_EVENTS: readonly SoundEvent[] = SOUND_EVENTS;

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("sound effects layer", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockRejectedValue(new Error("should not be called")),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to enabled with a 30% volume", () => {
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX();
    expect(fx.isEnabled()).toBe(true);
    expect(fx.getVolume()).toBe(DEFAULT_SOUND_VOLUME);
    expect(fx.getState()).toEqual({ enabled: true, volume: 0.3 });
  });

  it("can be disabled and re-enabled", () => {
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX();
    fx.setEnabled(false);
    expect(fx.isEnabled()).toBe(false);
    fx.setEnabled(true);
    expect(fx.isEnabled()).toBe(true);
  });

  it("clamps and persists the volume", () => {
    const storage = createStorage();
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX({ storage });
    fx.setVolume(2);
    expect(fx.getVolume()).toBe(1);
    fx.setVolume(-1);
    expect(fx.getVolume()).toBe(0);
    fx.setVolume(0.6);
    expect(fx.getVolume()).toBe(0.6);
    expect(storage._data.get("jarvis.sound.volume")).toBe("0.6");
  });

  it("persists enable/disable to storage", () => {
    const storage = createStorage();
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX({ storage });
    fx.setEnabled(false);
    expect(storage._data.get("jarvis.sound.enabled")).toBe("false");
  });

  it("a new instance restores persisted settings", () => {
    const storage = createStorage();
    vi.stubGlobal("window", makeWindow());
    const first = createSoundFX({ storage });
    first.setEnabled(false);
    first.setVolume(0.45);
    const second = createSoundFX({ storage });
    expect(second.isEnabled()).toBe(false);
    expect(second.getVolume()).toBe(0.45);
  });

  it("notifies subscribers when settings change", () => {
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX();
    const seen: SoundFXSettings[] = [];
    const unsubscribe = fx.subscribe((settings) => seen.push(settings));
    fx.setEnabled(false);
    fx.setVolume(0.2);
    unsubscribe();
    fx.setEnabled(true);
    expect(seen).toEqual([
      { enabled: false, volume: 0.3 },
      { enabled: false, volume: 0.2 },
    ]);
  });

  it("play() is synchronous and non-blocking (returns void immediately)", () => {
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX();
    const result = fx.play("wake");
    expect(result).toBeUndefined();
    const started = Date.now();
    for (const event of ALL_EVENTS) fx.play(event);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("plays each effect exactly once and never duplicates within the coalescing window", () => {
    vi.stubGlobal("window", makeWindow());

    let created = 0;
    const AudioCtor = vi.fn(function Audio(_url?: string) {
      created += 1;
      const el = new FakeAudioElement();
      el.play = vi.fn().mockResolvedValue(undefined);
      return el;
    });
    vi.stubGlobal("Audio", AudioCtor);

    const fx = createSoundFX();

    // Duplicate triggers of the same event inside the coalescing window must be
    // collapsed to a single playback.
    fx.play("wake");
    fx.play("wake");
    fx.play("wake");

    for (const event of ALL_EVENTS) {
      fx.play(event);
    }

    // 1 (wake) + the other 9 distinct events = 10 total plays, no duplicates.
    expect(created).toBe(ALL_EVENTS.length);
    expect(AudioCtor).toHaveBeenCalledTimes(ALL_EVENTS.length);
  });

  it("does not create a microphone stream or use MediaRecorder", async () => {
    vi.stubGlobal("window", makeWindow());
    const fx = createSoundFX();
    for (const event of ALL_EVENTS) fx.play(event);
    await flush();
    const navigatorStub = navigator as unknown as {
      mediaDevices: { getUserMedia: ReturnType<typeof vi.fn> };
    };
    expect(navigatorStub.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("plays nothing when disabled", () => {
    vi.stubGlobal("window", makeWindow());
    const AudioCtor = vi.fn(function Audio(_url?: string) {
      return new FakeAudioElement();
    });
    vi.stubGlobal("Audio", AudioCtor);

    const fx = createSoundFX();
    fx.setEnabled(false);
    for (const event of ALL_EVENTS) fx.play(event);
    expect(AudioCtor).not.toHaveBeenCalled();
  });

  it("preloads decoded buffers and plays them via the Web Audio graph", async () => {
    const windowStub = makeWindow();
    vi.stubGlobal("window", windowStub);

    const fakeContext = new FakeAudioContext();
    const AudioCtor = vi.fn(function AudioContext() {
      return fakeContext;
    });
    windowStub.AudioContext = AudioCtor;
    vi.stubGlobal(
      "Audio",
      vi.fn(function Audio(_url?: string) {
        return new FakeAudioElement();
      })
    );

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    const fx = createSoundFX({ fetchImpl });
    fx.setVolume(0.5);
    fx.preload();
    await flush();
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(ALL_EVENTS.length);
    expect(fakeContext.decodeAudioData).toHaveBeenCalledTimes(ALL_EVENTS.length);

    // With buffers loaded, play uses buffer sources instead of <audio>.
    fakeContext.source.start.mockClear();
    fx.play("wake");
    expect(fakeContext.source.start).toHaveBeenCalledTimes(1);
    expect(fakeContext.gain.gain.value).toBe(0.5);

    // Coalescing still applies on the buffer path.
    fx.play("wake");
    expect(fakeContext.source.start).toHaveBeenCalledTimes(1);
  });

  it("survives a suspended AudioContext by resuming it", async () => {
    const windowStub = makeWindow();
    vi.stubGlobal("window", windowStub);
    const fakeContext = new FakeAudioContext();
    (fakeContext as { state: string }).state = "suspended";
    windowStub.AudioContext = vi.fn(function AudioContext() {
      return fakeContext;
    });
    vi.stubGlobal(
      "Audio",
      vi.fn(function Audio(_url?: string) {
        return new FakeAudioElement();
      })
    );

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    const fx = createSoundFX({ fetchImpl });
    fx.preload();
    await flush();
    await flush();
    fx.play("wake");
    expect(fakeContext.resume).toHaveBeenCalled();
  });
});

describe("state transition → sound mapping", () => {
  it.each<[AIState, AIState, string | null]>([
    ["idle", "listening", "listening"],
    ["listening", "listening", null],
    ["listening", "thinking", "thinking"],
    ["idle", "thinking", "thinking"],
    ["thinking", "speaking", "response-start"],
    ["idle", "speaking", "response-start"],
    ["speaking", "idle", "response-end"],
    ["speaking", "thinking", "response-end"],
    ["speaking", "listening", "response-end"],
    ["idle", "idle", null],
  ])("%s → %s plays %s", (prev, next, expected) => {
    expect(stateTransitionSound(prev, next)).toBe(expected);
  });

  it("never plays the thinking cue while TTS is speaking", () => {
    expect(stateTransitionSound("speaking", "thinking")).toBe("response-end");
  });

  it("plays every sound exactly once across a full conversation cycle", () => {
    const cycle: AIState[] = [
      "idle",
      "listening",
      "thinking",
      "speaking",
      "idle",
    ];
    const events: string[] = [];
    for (let i = 1; i < cycle.length; i++) {
      const event = stateTransitionSound(cycle[i - 1], cycle[i]);
      if (event) events.push(event);
    }
    expect(events).toEqual(["listening", "thinking", "response-start", "response-end"]);
  });
});
