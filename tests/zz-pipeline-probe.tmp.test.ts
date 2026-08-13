import { describe, it } from "vitest";
import { runPipelineText, type PipelineModel } from "@/services/chat";
import { invalidateSearchCache } from "@/lib/toolkit/web";

const fakeModel: PipelineModel = {
  streamText: async function* () {
    yield "never";
  },
};

describe("LIVE pipeline probe (temporary)", () => {
  it("run the failing query through the real pipeline", async () => {
    invalidateSearchCache();
    for (const q of [
      "who is the current PM of India?",
      "who is the current Prime Minister of India?",
      "India ka pradhan mantri kaun hai?",
      "who is the current Chief Minister of Bihar?",
      "who was the first Sikh Prime Minister of India?",
      "what is the capital of India?",
    ]) {
      console.log("==== PIPELINE QUERY:", JSON.stringify(q));
      try {
        const out = await runPipelineText(q, [{ role: "user", content: q }], fakeModel);
        console.log(
          "PIPELINE_OUT",
          JSON.stringify({
            intent: out.intent,
            source: out.source,
            text: out.text,
            events: out.events
              .filter((e) => e.kind === "plan" || e.kind === "tool" || e.kind === "fact" || e.kind === "source")
              .map((e) => ({ kind: e.kind, ...("intent" in e ? { intent: e.intent } : {}), ...("tool" in e ? { tool: e.tool, ok: e.ok, fallbackReason: e.fallbackReason } : {}) })),
          })
        );
      } catch (err) {
        console.log("PIPELINE_ERR", JSON.stringify((err as Error).message));
      }
    }
  }, 180000);
});
