/**
 * Regression gate for the "what am i weaing" bug: a typo in a vision trigger
 * word must route to the REAL vision pipeline (honest no-camera reply, no LLM)
 * instead of falling through to the plain conversational model, and the
 * conversational model must be bound by a capability-honesty guardrail plus a
 * no-camera backstop so it can never fabricate a camera it never opened.
 */

import { describe, expect, it } from "vitest";

import { runPipeline, type PipelineModel } from "@/services/chat";
import type { AIMessageInput } from "@/lib/ai/types";
import { classifyPlanIntent } from "@/services/planner";
import { buildNoCameraSystemContext } from "@/lib/ai/prompts";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/ai/prompts";

function captureModel(captured: { messages: AIMessageInput[] }[]): PipelineModel {
  return {
    streamText: async function* (opts: { messages: AIMessageInput[] }) {
      captured.push({ messages: opts.messages });
      yield "model reply";
    },
  };
}

/** A model that must never be invoked — throws loudly if it is. */
const neverModel: PipelineModel = {
  streamText: async function* () {
    throw new Error("model must not be invoked on the camera-off vision path");
  },
};

async function collect(
  prompt: string,
  model: PipelineModel,
  options: Parameters<typeof runPipeline>[3] = {}
): Promise<Array<{ kind: string; [key: string]: unknown }>> {
  const events: Array<{ kind: string; [key: string]: unknown }> = [];
  for await (const event of runPipeline(prompt, [{ role: "user", content: prompt }], model, options)) {
    events.push(event as { kind: string; [key: string]: unknown });
  }
  return events;
}

const tokensOf = (events: Array<{ kind: string; [key: string]: unknown }>): string =>
  events.filter((e) => e.kind === "token").map((e) => String(e.text)).join("");

const sourceOf = (events: Array<{ kind: string; [key: string]: unknown }>): string | null =>
  (events.find((e) => e.kind === "source")?.source as string | null) ?? null;

const planIntentOf = (events: Array<{ kind: string; [key: string]: unknown }>): string | null =>
  (events.find((e) => e.kind === "plan")?.intent as string | null) ?? null;

describe("typo tolerance — routing (Fix A)", () => {
  it.each([
    "what am i weaing",
    "what am i waering",
    "what am i holdin",
    "what am i holdign",
  ])("classifies %s as vision", (prompt) => {
    expect(classifyPlanIntent(prompt)).toBe("vision");
  });

  it("answers a typo'd wearing question from the vision pipeline with no LLM", async () => {
    const events = await collect("what am i weaing", neverModel, {
      vision: { state: "off", frames: [] },
    });
    expect(planIntentOf(events)).toBe("vision");
    expect(sourceOf(events)).toBe("vision");
    expect(tokensOf(events)).toContain("camera");
    expect(tokensOf(events)).not.toContain("activat");
  });
});

describe("conversational guardrail (Fix B.1)", () => {
  it("binds the reasoning model to the capability-honesty rule", async () => {
    const captured: { messages: AIMessageInput[] }[] = [];
    await collect("tell me a joke", captureModel(captured));
    expect(captured.length).toBe(1);
    const system = captured[0].messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    expect(system).toContain("Capability honesty");
    expect(system).toContain("NEVER claim to have activated");
    expect(system).toContain(DEFAULT_SYSTEM_PROMPT);
  });
});

describe("no-camera backstop (Fix B.2)", () => {
  it("injects the no-camera context for camera-adjacent reasoning requests", async () => {
    const captured: { messages: AIMessageInput[] }[] = [];
    const events = await collect("describe my room layout", captureModel(captured), {
      vision: { state: "off", frames: [] },
    });
    expect(planIntentOf(events)).toBe("reasoning");
    const system = captured[0].messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    expect(system).toContain(buildNoCameraSystemContext());
  });

  it("does not inject the no-camera context for plain conversation", async () => {
    const captured: { messages: AIMessageInput[] }[] = [];
    await collect("tell me a joke", captureModel(captured), {
      vision: { state: "off", frames: [] },
    });
    const system = captured[0].messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n");
    expect(system).not.toContain(buildNoCameraSystemContext());
  });
});
