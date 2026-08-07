// Generates the original JARVIS UI sound-effect assets as 16-bit PCM WAV files.
//
// Every sound is synthesized here from scratch (sines, sweeps, noise, simple
// envelopes) so the assets are original — no copyrighted Iron Man/JARVIS audio
// is used. They are written once to public/sounds and served as static local
// files; nothing is synthesized at runtime in the browser.
//
// Run with:  node scripts/generate-sounds.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "sounds");
const SAMPLE_RATE = 44100;

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Exponential decay envelope (gain 1 -> ~0 over `duration`).
function decayEnv(t, duration, k = 6) {
  return Math.exp(-k * (t / duration));
}

// Linear frequency ramp from f0 to f1.
function sweepFreq(f0, f1, t, duration) {
  const p = clamp(t / duration, 0, 1);
  return f0 + (f1 - f0) * p;
}

function sine(phase) {
  return Math.sin(phase);
}

// Soft rounded attack so nothing sounds clicky.
function attack(t, ms = 0.008) {
  return clamp(t / ms, 0, 1);
}

// Simple one-pole low-pass filter applied to a sample stream in place.
function lowpass(samples, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff);
  const alpha = 1 / (SAMPLE_RATE * rc + 1);
  let y = 0;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    y = y + alpha * (samples[i] - y);
    out[i] = y;
  }
  return out;
}

// White noise source.
function noise(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1;
  return out;
}

function render({ duration, sampleFn, filterHz }) {
  const n = Math.floor(duration * SAMPLE_RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    out[i] = sampleFn(t, i);
  }
  if (filterHz) {
    return lowpass(out, filterHz);
  }
  void phase;
  return out;
}

function normalize(samples, peak = 0.8) {
  let max = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > max) max = a;
  }
  if (max === 0) return samples;
  const g = peak / max;
  for (let i = 0; i < samples.length; i++) samples[i] *= g;
  return samples;
}

function writeWav(name, samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = clamp(Math.round(samples[i] * 32767), -32768, 32767);
  }
  const dataSize = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) {
    buffer.writeInt16LE(pcm[i], 44 + i * 2);
  }
  const file = join(OUT_DIR, `${name}.wav`);
  writeFileSync(file, buffer);
  console.log(`  wrote ${name}.wav (${(buffer.length / 1024).toFixed(1)} KB)`);
}

// ---------------------------------------------------------------------------
// Sound definitions — short, subtle, futuristic, non-repetitive.
// ---------------------------------------------------------------------------

const SOUNDS = {
  // Wake: bright rising activation sweep with a soft echo.
  wake: () => {
    const D = 0.34;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const f = sweepFreq(420, 1250, t, D);
          const vib = 1 + 0.006 * Math.sin(2 * Math.PI * 18 * t);
          const env = decayEnv(t, D, 7) * attack(t);
          return env * sine(2 * Math.PI * f * vib * t);
        },
      })
    );
  },

  // Listening: two soft overlapping chimes — a gentle "attention" cue.
  listening: () => {
    const D = 0.22;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const env = decayEnv(t, D, 8) * attack(t);
          const n1 = sine(2 * Math.PI * 860 * t);
          const n2 = sine(2 * Math.PI * 1290 * t) * clamp(2 - t / 0.05, 0, 1);
          return env * (0.6 * n1 + 0.4 * n2);
        },
      })
    );
  },

  // Thinking: a couple of quick soft processing ticks, never a loop.
  thinking: () => {
    const D = 0.26;
    const n = Math.floor(D * SAMPLE_RATE);
    const out = new Float32Array(n);
    for (const [at, f, amp] of [
      [0.0, 1180, 1.0],
      [0.09, 1480, 0.8],
    ]) {
      const start = Math.floor(at * SAMPLE_RATE);
      for (let i = start; i < n; i++) {
        const t = i / SAMPLE_RATE - at;
        const env = decayEnv(t, 0.12, 10) * attack(t, 0.004);
        out[i] += amp * 0.35 * env * sine(2 * Math.PI * f * t);
      }
    }
    const bed = lowpass(noise(n), 1400);
    for (let i = 0; i < n; i++) {
      out[i] += 0.05 * bed[i] * decayEnv(i / SAMPLE_RATE, D, 9);
    }
    return normalize(out);
  },

  // Tool: a single very short confirmation blip.
  tool: () => {
    const D = 0.09;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const f = 1560 - 260 * (t / D);
          return decayEnv(t, D, 12) * attack(t, 0.003) * sine(2 * Math.PI * f * t);
        },
      })
    );
  },

  // Vision: rising scanner sweep with a subtle shimmering wobble.
  vision: () => {
    const D = 0.42;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const f = sweepFreq(520, 1680, t, D);
          const wob = 1 + 0.04 * Math.sin(2 * Math.PI * 9 * t);
          const env = decayEnv(t, D, 4.5) * attack(t);
          return env * sine(2 * Math.PI * f * wob * t);
        },
      })
    );
  },

  // Response-start: soft upward gliss just before speech begins.
  "response-start": () => {
    const D = 0.13;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const f = sweepFreq(540, 1020, t, D);
          return decayEnv(t, D, 8) * attack(t) * sine(2 * Math.PI * f * t);
        },
      })
    );
  },

  // Response-end: short two-note descending completion chime.
  "response-end": () => {
    const D = 0.3;
    const n = Math.floor(D * SAMPLE_RATE);
    const out = new Float32Array(n);
    for (const [at, f, amp] of [
      [0.0, 1040, 0.9],
      [0.13, 720, 0.8],
    ]) {
      const start = Math.floor(at * SAMPLE_RATE);
      for (let i = start; i < n; i++) {
        const t = i / SAMPLE_RATE - at;
        const env = decayEnv(t, 0.18, 6) * attack(t, 0.006);
        out[i] += amp * 0.4 * env * sine(2 * Math.PI * f * t);
      }
    }
    return normalize(out);
  },

  // Error: soft, slightly dissonant low tones — subtle warning, not alarming.
  error: () => {
    const D = 0.4;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const env = decayEnv(t, D, 5) * attack(t);
          return env * 0.4 * (sine(2 * Math.PI * 216 * t) + sine(2 * Math.PI * 178 * t));
        },
      })
    );
  },

  // Camera-on: click followed by a quick high shimmer.
  "camera-on": () => {
    const D = 0.26;
    const n = Math.floor(D * SAMPLE_RATE);
    const out = new Float32Array(n);
    // mechanical click (filtered noise burst)
    const click = lowpass(noise(Math.floor(0.012 * SAMPLE_RATE)), 2600);
    for (let i = 0; i < click.length && i < n; i++) {
      out[i] += 0.5 * click[i] * decayEnv(i / SAMPLE_RATE, 0.012, 14);
    }
    // shimmering activation sweep
    for (let i = Math.floor(0.01 * SAMPLE_RATE); i < n; i++) {
      const t = i / SAMPLE_RATE - 0.01;
      const f = sweepFreq(900, 1500, t, D - 0.01);
      out[i] += 0.6 * decayEnv(t, D - 0.01, 6) * attack(t) * sine(2 * Math.PI * f * t);
    }
    return normalize(out);
  },

  // Camera-off: soft descending shutdown sweep.
  "camera-off": () => {
    const D = 0.34;
    return normalize(
      render({
        duration: D,
        sampleFn: (t) => {
          const f = sweepFreq(860, 210, t, D);
          return decayEnv(t, D, 5) * attack(t) * sine(2 * Math.PI * f * t);
        },
      })
    );
  },
};

mkdirSync(OUT_DIR, { recursive: true });
console.log("Generating JARVIS UI sound assets…");
for (const [name, build] of Object.entries(SOUNDS)) {
  writeWav(name, build());
}
console.log(`Done — ${Object.keys(SOUNDS).length} sounds in public/sounds/`);
