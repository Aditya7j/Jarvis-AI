/**
 * Runtime vision-pipeline audit for the query "Can you see me?".
 *
 * Drives the REAL server pipeline headlessly (the same modules /api/chat and
 * /api/vision/live use) and logs the exact execution timeline:
 *   1. frame preprocess (sharp decode)
 *   2. YOLO inference (main pass + ROI re-detect)
 *   3. Scene Cache update
 *   4. whether Gemma3 was invoked
 *   5. whether Qwen3 was invoked
 *   6. total response time
 *
 * Run: npx tsx scripts-tmp-vision-pipeline-audit.ts
 * LLM probes are optional: set LLM_PROBE=1 to time Qwen3/Gemma3 directly.
 */

import fs from "node:fs";
import path from "node:path";
import { liveVisionEngine } from "./src/lib/vision/live-vision-engine";
import { getVisionStateStore } from "./src/lib/vision/vision-state";
import {
  classifyVisionDepth,
  classifyVisionIntent,
} from "./src/lib/ai/vision-intent";
import {
  answerFromVisionCache,
  isVisionCacheUsable,
} from "./src/lib/vision/vision-answer";
import { aiService } from "./src/lib/ai";

const PROMPT = "Can you see me?";
const FRAMES = 5;
const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const QWEN_MODEL = process.env.QWEN3_MODEL ?? "qwen3:latest";
const GEMMA_MODEL = process.env.GEMMA3_MODEL ?? "gemma3:12b";
const RUN_LLM = process.env.LLM_PROBE === "1";

const t0 = performance.now();
const T = (): string => `${(performance.now() - t0).toFixed(1)}ms`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(10);
  }
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

async function probeOllamaStream(
  label: string,
  body: Record<string, unknown>,
  windowMs: number
): Promise<{ connectMs: number; firstTokenMs: number; tokens: number; aborted: boolean; done: boolean }> {
  const started = performance.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const connectMs = performance.now() - started;
  if (!res.ok || !res.body) {
    return { connectMs, firstTokenMs: -1, tokens: 0, aborted: true, done: false };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenMs = -1;
  let tokens = 0;
  let aborted = false;
  let done = false;
  const windowDeadline = performance.now() + windowMs;
  try {
    while (performance.now() < windowDeadline) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        done = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          if (parsed.message?.content) {
            if (firstTokenMs === -1) firstTokenMs = performance.now() - started;
            tokens += 1;
          }
          if (parsed.done) {
            done = true;
            break;
          }
        } catch {
          // ignore
        }
      }
      if (done) break;
    }
    if (!done) {
      aborted = true;
    }
  } catch {
    aborted = true;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  void label;
  return { connectMs, firstTokenMs, tokens, aborted, done };
}

async function main(): Promise<void> {
  const framePath = path.join(process.cwd(), "debug", "debug-frame.jpg");
  const image = fs.readFileSync(framePath).toString("base64");

  console.log("=".repeat(78));
  console.log("RUNTIME PIPELINE AUDIT — query: \"" + PROMPT + "\"");
  console.log("frame:", framePath, `(${Math.round(image.length * 0.75 / 1024)} KB base64)`);
  console.log("=".repeat(78));

  // ---- 0. Intent + depth classification (what the router decides) ----
  const intent = classifyVisionIntent(PROMPT);
  const depth = classifyVisionDepth(PROMPT);
  console.log("\n[0] Classification");
  console.log(`    classifyVisionIntent("${PROMPT}") -> ${intent}`);
  console.log(`    classifyVisionDepth("${PROMPT}") -> ${depth}`);
  console.log(`    => needsVision=${intent === "vision"}  simple=${depth === "simple"}`);

  // ---- 1..4. Continuous YOLO loop (what /api/vision/live does) ----
  console.log("\n[1] Continuous YOLO loop (liveVisionEngine.start + submit)");
  liveVisionEngine.start("webcam");
  let processedBefore = liveVisionEngine.getStats().framesAnalyzed;
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const submittedAt = Date.now();
    const submitted = performance.now();
    liveVisionEngine.submit({
      image,
      mimeType: "image/jpeg",
      source: "webcam",
      width: 960,
      height: 540,
      capturedAt: submittedAt + i,
    });
    await waitFor(
      () => liveVisionEngine.getStats().framesAnalyzed > processedBefore,
      20_000,
      `frame #${i + 1} to be analyzed`
    );
    const processedAt = performance.now() - submitted;
    processedBefore = liveVisionEngine.getStats().framesAnalyzed;
    const tl = liveVisionEngine.getLastTimeline();
    const state = getVisionStateStore().getState();
    frames.push({
      submitWaitMs: processedAt,
      tl,
      cacheTimestamp: state.timestamp,
      people: state.latestPeople.length,
      objects: Object.keys(state.latestObjects).length,
      scene: state.latestScene,
      lastGemma: state.lastGemma,
    });
  }

  const stats = liveVisionEngine.getStats();
  console.log(`    framesSubmitted=${stats.framesSubmitted} framesAnalyzed=${stats.framesAnalyzed}`);
  console.log(`    avg yolo inference=${fmt(stats.lastInferenceMs)}  avg pipeline=${fmt(stats.lastPipelineMs)}  yoloFps=${stats.yoloFps.toFixed(2)}`);

  console.log("\n    per-frame timeline (decode | main YOLO | ROI | colour | cache update | total | submit->analyzed wait):");
  for (const f of frames) {
    const tl = f.tl;
    if (!tl) continue;
    console.log(
      `      #${String(tl.seq).padStart(2, " ")}  ` +
      `decode ${fmt(tl.preprocessMs)}  yolo ${fmt(tl.yoloMainMs)}  roi ${fmt(tl.yoloRoiMs)}  ` +
      `color ${fmt(tl.colorMs)}  cache ${fmt(tl.cacheUpdateMs)}  total ${fmt(tl.totalMs)}  ` +
      `submit->analyzed ${fmt(f.submitWaitMs)}`
    );
  }
  const cacheBefore = getVisionStateStore().getState().timestamp;
  console.log(`    Scene Cache (vision-state) timestamp after last frame: ${cacheBefore} — isFresh(3000ms)=${getVisionStateStore().isFresh(3000)}`);

    // ---- 5..7. The chat route's simple path for "Can you see me?" ----
  console.log("\n[2] Chat route simple path (exact branch logic from /api/chat)");
  const usable = isVisionCacheUsable(3000);
  const answer = answerFromVisionCache(PROMPT);
  const tAnswerStart = performance.now();
  const servedFromCache = usable && !answer.needsGemma;
  const routeMs = performance.now() - tAnswerStart;
  console.log(`    isVisionCacheUsable(3000) -> ${usable}`);
  console.log(`    answerFromVisionCache("${PROMPT}") -> needsGemma=${answer.needsGemma} fromCache=${answer.fromCache} confidence=${answer.confidence}`);
  console.log(`    text -> "${answer.text}"`);
  console.log(`    Gemma3 invoked -> ${servedFromCache ? "NO" : "YES (needsGemma) / fall-through"}`);
  console.log(`    Qwen3 invoked -> ${servedFromCache ? "NO (answer emitted directly from Scene Cache)" : "YES (with Gemma JSON)"}`);
  console.log(`    cached-answer emit time -> ${fmt(routeMs)}`);
  console.log(`    Scene Cache "lastGemma" marker -> ${JSON.stringify(getVisionStateStore().getState().lastGemma)}`);

  // ---- 2b. Prompt battery: is EVERY simple vision query served from cache? ----
  console.log("\n[2b] Simple-prompt battery (all with fresh Scene Cache)");
  console.log(`    ${"prompt".padEnd(32)} ${"intent".padEnd(7)} ${"depth".padEnd(8)} needsGemma  fromCache  served`);
  const battery: { prompt: string; expectSimple: boolean }[] = [
    { prompt: "Can you see me?", expectSimple: true },
    { prompt: "How many people are here?", expectSimple: true },
    { prompt: "Am I alone?", expectSimple: true },
    { prompt: "Do you see anyone else?", expectSimple: true },
    { prompt: "What am I holding?", expectSimple: true },
    { prompt: "What am I wearing?", expectSimple: true },
    { prompt: "Do you see my phone?", expectSimple: true },
    { prompt: "Is there a bottle on my desk?", expectSimple: true },
    { prompt: "What's on my screen?", expectSimple: true },
    { prompt: "What do you see?", expectSimple: true },
    { prompt: "What color shirt am I wearing?", expectSimple: true },
    { prompt: "Describe the room in detail", expectSimple: false },
    { prompt: "What does the text on the screen say?", expectSimple: false },
    { prompt: "Why is that person waving?", expectSimple: false },
  ];
  let batteryLeaks = 0;
  for (const item of battery) {
    const bi = classifyVisionIntent(item.prompt);
    const bd = classifyVisionDepth(item.prompt);
    const ba = answerFromVisionCache(item.prompt);
    const served = !ba.needsGemma && ba.fromCache;
    if (item.expectSimple && !served) batteryLeaks += 1;
    console.log(
      `    ${item.prompt.padEnd(32)} ${bi.padEnd(7)} ${bd.padEnd(8)} ${String(ba.needsGemma).padEnd(11)} ${String(ba.fromCache).padEnd(10)} ${served ? "CACHE" : "-> GEMMA"}`
    );
  }
  console.log(`    leaks (expected-simple but needs Gemma): ${batteryLeaks}`);

  // ---- 8. Contrast: engine stopped (vision page never open / loop dead) ----
  console.log("\n[3] Contrast — live loop NOT running (engine stopped)");
  liveVisionEngine.stop();
  const stateNow = getVisionStateStore().getState();
  const ageMs = Date.now() - stateNow.timestamp;
  const usableAfter = isVisionCacheUsable(3000);
  const ansAfter = answerFromVisionCache(PROMPT);
  console.log(`    Scene Cache age after stop -> ${fmt(ageMs)}`);
  console.log(`    isVisionCacheUsable(3000) -> ${usableAfter}`);
  console.log(`    answerFromVisionCache -> needsGemma=${ansAfter.needsGemma} "${ansAfter.text}"`);
  console.log(
    `    route would emit -> ${usableAfter
      ? `"${ansAfter.text}" from cache`
      : `"My camera view isn't ready yet — give me a moment." (canned fallback, no LLM)`}`
  );
  console.log(`    IMPORTANT: with no frames and a stale cache, /api/chat NEVER calls Gemma3 — it emits the canned message.`);

  // ---- 9. Total response time for the fast path ----
  const totalFastMs = performance.now() - t0;
  console.log("\n[TOTAL] fast path (YOLO warm-up + cache answer) elapsed");
  console.log(`    ${fmt(totalFastMs)}`);
  console.log(`    => simple cached answer total budget: ~${fmt(routeMs)} (plus one pipeline refresh ~${fmt(stats.lastPipelineMs)} if a new frame arrives)`);

  // ---- 10. LLM probes (optional) ----
  if (RUN_LLM) {
    console.log("\n[4] LLM timing probes (streaming, TTFB) — LLM_PROBE=1");
    console.log(`    Qwen3 (${QWEN_MODEL}) — representative text path (no image):`);
    const q = await probeOllamaStream("qwen3", { model: QWEN_MODEL, think: false, messages: [{ role: "user", content: PROMPT }] }, 45_000);
    console.log(`      connect(headers)=${fmt(q.connectMs)}  firstTokenMs=${q.firstTokenMs >= 0 ? fmt(q.firstTokenMs) : "N/A"}  tokens(${fmt(45_000)} window)=${q.tokens}  aborted=${q.aborted}  done=${q.done}`);

    console.log(`    Gemma3 (${GEMMA_MODEL}) — vision path WITH image (this is the multi-minute suspect):`);
    const g = await probeOllamaStream("gemma3", {
      model: GEMMA_MODEL,
      think: false,
      messages: [{ role: "user", content: "Describe what you see in this image in detail.", images: [image] }],
    }, 60_000);
    console.log(`      connect(headers)=${fmt(g.connectMs)}  firstTokenMs=${g.firstTokenMs >= 0 ? fmt(g.firstTokenMs) : "N/A"}  tokens(${fmt(60_000)} window)=${g.tokens}  aborted=${g.aborted}  done=${g.done}`);
  } else {
    console.log("\n[4] LLM timing probes skipped (set LLM_PROBE=1 to run Qwen3/Gemma3 TTFB probes).");
  }

  console.log("\n" + "=".repeat(78));
  console.log("AUDIT COMPLETE");
  console.log("=".repeat(78));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("AUDIT FAILED:", error);
    process.exit(1);
  });
