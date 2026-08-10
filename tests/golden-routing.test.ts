/**
 * GOLDEN ROUTING SUITE — deterministic intent-routing contract.
 *
 * This is the permanent regression gate. It runs on EVERY `npm test` (no env
 * flag). It encodes the routing contract for the user-defined golden question
 * categories (A date/time, B current facts, C general knowledge, D math,
 * E coding, F casual, G live info, H vision) plus the exact 10-question
 * sequence and the vision-canary set.
 *
 * Each case asserts the EXPECTED plan class. A wrong class means the shared
 * classifier chain hijacked the question into a different capability — the
 * exact mechanism behind the "can you tell me the time right now" → camera
 * refusal regression.
 *
 * Known pre-existing gaps (never worked, not regressions) are tagged `gap`:
 *   - "What is tomorrow's date?" routes to `search` (no date-arithmetic tool)
 *   - "If x + 5 = 12, what is x?" routes to `search` (no algebra support)
 *
 * Vision hijack regressions (failing today) are tagged `hijack`:
 *   - any "can you (tell|describe) X" phrase → vision, because the vision
 *     classifier runs at precedence position 2 in `classifyWithReasons` before
 *     time/date/weather/search.
 */

import { describe, expect, it } from "vitest";

import { classifyPlanIntent } from "@/services/planner";
import { classifyVisionIntent } from "@/lib/ai/vision-intent";
import type { PlanClass } from "@/services/planner";

interface GoldenCase {
  question: string;
  expected: PlanClass;
  tag?: "hijack" | "gap";
}

const A_DATE_TIME: GoldenCase[] = [
  { question: "What is today's date?", expected: "date" },
  { question: "What day is today?", expected: "date" },
  { question: "What day will 15 August 2026 be?", expected: "date-calc" },
  { question: "What day was 15 August 2025?", expected: "date-calc" },
  { question: "What time is it?", expected: "time" },
  { question: "What time is it in London?", expected: "time" },
  { question: "What is tomorrow's date?", expected: "date", tag: "gap" },
  { question: "Can you tell me the time right now?", expected: "time", tag: "hijack" },
];

const B_CURRENT_FACTS: GoldenCase[] = [
  { question: "Who is the current Prime Minister of India?", expected: "search" },
  { question: "Who is the current President of India?", expected: "search" },
  { question: "Who is the current Prime Minister of Canada?", expected: "search" },
  { question: "Who is the current President of the USA?", expected: "search" },
];

const C_GENERAL_KNOWLEDGE: GoldenCase[] = [
  { question: "What is the capital of India?", expected: "search" },
  { question: "Who invented the telephone?", expected: "search" },
  { question: "What is photosynthesis?", expected: "search" },
  { question: "What is the largest planet?", expected: "search" },
];

const D_MATH: GoldenCase[] = [
  { question: "What is 27 * 43?", expected: "math" },
  { question: "What is 9999 / 37?", expected: "math" },
  { question: "What is 25 percent of 80?", expected: "math" },
  { question: "What is the square root of 144?", expected: "math" },
  { question: "If x + 5 = 12, what is x?", expected: "math", tag: "gap" },
];

const E_CODING: GoldenCase[] = [
  { question: "What is a closure in JavaScript?", expected: "search" },
  { question: "What is the event loop?", expected: "search" },
  { question: "Difference between Promise and async/await", expected: "reasoning" },
  { question: "Write a JavaScript debounce function", expected: "reasoning" },
  { question: "Explain Redis", expected: "reasoning" },
];

const F_CASUAL: GoldenCase[] = [
  { question: "Hey Jarvis", expected: "reasoning" },
  { question: "Hello", expected: "reasoning" },
  { question: "How are you?", expected: "reasoning" },
  { question: "Good morning Jarvis", expected: "reasoning" },
];

const G_LIVE: GoldenCase[] = [
  { question: "What is the weather in Delhi?", expected: "weather" },
  { question: "Tell me the latest news", expected: "search" },
];

const H_VISION: GoldenCase[] = [
  { question: "Can you see me?", expected: "vision" },
  { question: "What am I holding?", expected: "vision" },
  { question: "What am I wearing?", expected: "vision" },
  { question: "What is on my screen?", expected: "vision" },
];

/**
 * Vision-canary set: every phrasing that must NEVER route to vision. These are
 * the questions the over-broad `can you (tell|describe)` strong pattern steals
 * from time/date/weather/search.
 */
const VISION_CANARIES: GoldenCase[] = [
  { question: "Can you tell me the time right now?", expected: "time", tag: "hijack" },
  { question: "Can you tell me today's date?", expected: "date", tag: "hijack" },
  { question: "Can you tell me the capital of France?", expected: "search", tag: "hijack" },
  { question: "Can you describe the weather?", expected: "weather", tag: "hijack" },
];

/** The exact 10-question sequence the user mandated, at the routing layer. */
const SEQUENCE_10: GoldenCase[] = [
  { question: "What is today's date?", expected: "date" },
  { question: "Who is the current prime minister of India?", expected: "search" },
  { question: "What is 27 * 43?", expected: "math" },
  { question: "What is React?", expected: "reasoning" },
  { question: "What is the capital of Japan?", expected: "search" },
  { question: "What is today's date?", expected: "date" },
  { question: "Who is the current prime minister of India?", expected: "search" },
  { question: "What day will 15 August 2026 be?", expected: "date-calc" },
  { question: "What is 999 * 999?", expected: "math" },
  { question: "Who invented the telephone?", expected: "search" },
];

/**
 * Hijack-proofing regressions. Each case pins a routing decision that was
 * previously stolen by an over-broad detector — the shared classifier chain
 * must keep these separated forever.
 */
const ROUTING_REGRESSIONS: GoldenCase[] = [
  // "what is this/that" only points at the camera when terminal — reference
  // questions ("what is that movie") must reach knowledge, not vision.
  { question: "What is that movie you mentioned?", expected: "search" },
  { question: "What is this?", expected: "vision" },
  { question: "What is that on my screen?", expected: "vision" },
  // "what does it say" with a referential continuation is not OCR.
  { question: "What does it say about global warming?", expected: "reasoning" },
  // timezone questions stay on the clock; explanatory uses must not.
  { question: "What is my timezone?", expected: "time" },
  { question: "Which timezone am I in?", expected: "time" },
  { question: "Why does timezone exist?", expected: "reasoning" },
  // live-weather queries stay; definitional/explanatory uses must not.
  { question: "Is it sunny in Paris?", expected: "weather" },
  { question: "How does weather forecasting work?", expected: "reasoning" },
  { question: "What is the economic forecast?", expected: "search" },
  // "power level" in a fictional sense is not a battery query.
  { question: "What power level is Goku at?", expected: "reasoning" },
  // bare numerals are not arithmetic unless an operator is present.
  { question: "9820 1234 5678", expected: "reasoning" },
  { question: "What is 1,000,000?", expected: "reasoning" },
  // "google" as a brand is not a search instruction.
  { question: "Google Chrome is slow", expected: "reasoning" },
  // schedule questions with a meeting/appointment route to calendar, not search.
  { question: "When is my meeting?", expected: "calendar" },
  { question: "What time is my meeting?", expected: "calendar" },
  // "where are you" is identity, not geolocation.
  { question: "Where are you?", expected: "reasoning" },
  // "tell me about the X of Y" is a factual-knowledge request.
  { question: "Tell me about the capital of France", expected: "search" },
];

/**
 * The exact 8-question acceptance set that triggered the routing/handling
 * overhaul. "What is not X" must reason (the web surfaces unrelated pages);
 * rank-qualified office questions still probe search first (then defer when
 * the web has no usable answer); math stays on the calculator.
 */
const EIGHT_QUESTIONS: GoldenCase[] = [
  { question: "What is React?", expected: "reasoning" },
  { question: "What is not just?", expected: "reasoning" },
  { question: "What is not JS?", expected: "reasoning" },
  { question: "Who is the first Sikh Prime Minister of India?", expected: "search" },
  { question: "Is the first Sikh Prime Minister of India?", expected: "reasoning" },
  { question: "What is the square root of 16?", expected: "math" },
  { question: "Write the table of 19", expected: "reasoning" },
  { question: "I ask you what is the square root of 16", expected: "math" },
];

function describeCases(group: string, cases: GoldenCase[]): void {
  describe(`golden routing — ${group}`, () => {
    for (const c of cases) {
      it(`${c.expected} <- "${c.question}"${c.tag ? `  [${c.tag}]` : ""}`, () => {
        const actual = classifyPlanIntent(c.question);
        expect(actual, `"${c.question}" classified as ${actual}, expected ${c.expected}`).toBe(
          c.expected
        );
      });
    }
  });
}

describeCases("A date/time", A_DATE_TIME);
describeCases("B current facts", B_CURRENT_FACTS);
describeCases("C general knowledge", C_GENERAL_KNOWLEDGE);
describeCases("D math", D_MATH);
describeCases("E coding", E_CODING);
describeCases("F casual", F_CASUAL);
describeCases("G live info", G_LIVE);
describeCases("H vision (must stay vision)", H_VISION);
describeCases("vision canary (must never be vision)", VISION_CANARIES);
describeCases("exact 10-question sequence", SEQUENCE_10);
describeCases("the 8-question acceptance set", EIGHT_QUESTIONS);
describeCases("routing regressions (hijack-proofed)", ROUTING_REGRESSIONS);

describe("vision classifier verdict per canary (component-level)", () => {
  for (const c of VISION_CANARIES) {
    it(`"${c.question}" must classify as text, not vision`, () => {
      expect(
        classifyVisionIntent(c.question),
        `classifyVisionIntent("${c.question}") returned vision — this is the hijack`
      ).toBe("text");
    });
  }
});
