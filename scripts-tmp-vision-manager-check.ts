import { getVisionStateStore, type ScenePerson } from "./src/lib/vision/vision-state";
import { answerFromVisionCache } from "./src/lib/vision/vision-answer";
import { resolveVisualQuestion } from "./src/lib/vision/vision-manager";
import { stripReasoningOutput } from "./src/lib/ai/providers/ollama";

let failures = 0;
function expect(label: string, actual: string | boolean, expected: string | boolean) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n       got: ${String(actual)}\n       exp: ${String(expected)}`);
}

function person(trackingId: number, confidence: number): ScenePerson {
  const now = Date.now();
  return {
    trackingId,
    label: "person",
    classId: 0,
    box: { x: 10, y: 10, width: 50, height: 120 },
    confidence,
    hits: 2,
    misses: 0,
    age: 2,
    createdAt: now,
    lastSeenAt: now,
    lastConfidence: confidence,
  };
}

const store = getVisionStateStore();

// --- Banding: high confidence person -> direct answer ---
store.update({
  objects: [],
  people: [person(1, 0.96)],
  colors: {},
  confidence: 0.9,
});
const hi = answerFromVisionCache("can you see me?");
expect("high confidence sees me", hi.needsGemma, false);
expect("high confidence direct text", hi.text, "Yes, I can see you.");
expect("high confidence band", hi.confidence >= 80, true);

// --- Banding: low confidence person -> reposition, never a guess ---
store.update({
  objects: [],
  people: [person(2, 0.35)],
  colors: {},
  confidence: 0.4,
});
const lo = answerFromVisionCache("can you see me?");
expect("low confidence never guesses", lo.needsGemma, false);
expect("low confidence repositions", lo.text.includes("reposition"), true);
expect("low confidence band", lo.confidence < 50, true);

// --- Banding: mid confidence -> uncertain ---
store.update({
  objects: [],
  people: [person(3, 0.62)],
  colors: {},
  confidence: 0.6,
});
const mid = answerFromVisionCache("can you see me?");
expect("mid confidence uncertain text", mid.text.includes("not completely sure"), true);
expect("mid confidence band", mid.confidence >= 50 && mid.confidence < 80, true);

// --- Holding with low confidence -> reposition, never invents object ---
store.update({
  objects: [],
  people: [person(4, 0.9)],
  colors: {},
  heldObject: { label: "cell phone", confidence: 0.3 },
});
const held = answerFromVisionCache("what am I holding?");
expect("low-confidence held repositions", held.text.includes("reposition"), true);

async function main() {
// --- Manager: no camera -> hard refusal, no LLM, no cache ---
const off = await resolveVisualQuestion({
  prompt: "can you see me?",
  depth: "simple",
  visionState: "off",
  frames: [],
});
expect("off -> no-camera", off.kind, "no-camera");
if (off.kind === "no-camera") {
  expect("off -> refusal text", off.text, "I can't see your camera feed — no camera or screen source is connected. Turn one on and ask me again.");
  expect("off -> no gemma", off.meta.gemmaInvoked, false);
}

// --- Manager: fresh cache simple question -> cached answer, no gemma ---
store.update({
  objects: [],
  people: [person(5, 0.95)],
  colors: {},
  confidence: 0.95,
  frame: { buffer: "data:image/jpeg;base64,x", width: 640, height: 480, capturedAt: Date.now() },
});
const cached = await resolveVisualQuestion({
  prompt: "can you see me?",
  depth: "simple",
  visionState: "live",
  frames: [],
});
expect("fresh cache -> cached", cached.kind, "cached");
if (cached.kind === "cached") {
  expect("cached -> no gemma", cached.meta.gemmaInvoked, false);
  expect("cached -> text", cached.text, "Yes, I can see you.");
  expect("cached -> cache hit", cached.meta.cacheHit, true);
}

// --- Manager: complex question -> Gemma, regardless of fresh cache ---
const complex = await resolveVisualQuestion({
  prompt: "read the text on this paper",
  depth: "complex",
  visionState: "live",
  frames: [],
});
expect("complex -> gemma", complex.kind, "gemma");

// --- Manager: no camera + complex -> refusal (Qwen never answers camera content) ---
const complexOff = await resolveVisualQuestion({
  prompt: "what do you see?",
  depth: "complex",
  visionState: "off",
  frames: [],
});
expect("complex+off -> no-camera", complexOff.kind, "no-camera");

// --- Reasoning stripping (requirement 7) ---
const stripped = stripReasoningOutput("<think>I see a phone.</think>You are holding a phone.");
expect("strips <think> block", stripped, "You are holding a phone.");
const strippedCase = stripReasoningOutput("<Think>\ninternal plan\n</Think>The answer is 42.");
expect("strips case-insensitive tags", strippedCase, "The answer is 42.");
const clean = stripReasoningOutput("Hello world.");
expect("leaves clean text alone", clean, "Hello world.");

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
}

void main();
