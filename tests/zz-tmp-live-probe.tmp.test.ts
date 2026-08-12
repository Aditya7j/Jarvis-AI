import { describe, it } from "vitest";
import { webSearch, classifyKnowledgeQuery } from "@/lib/toolkit/web";

describe("LIVE probe (temporary)", () => {
  it("capital of india", async () => {
    const q = "What is the capital of India?";
    const cls = classifyKnowledgeQuery(q);
    console.log("PROBE_CLASS", JSON.stringify(cls));
    const result = await webSearch(q, 15000);
    console.log("PROBE_RESULT", JSON.stringify(result, null, 2));
  });

  it("capital of usa", async () => {
    const q = "What is the capital of USA?";
    const cls = classifyKnowledgeQuery(q);
    console.log("PROBE_CLASS", JSON.stringify(cls));
    const result = await webSearch(q, 15000);
    console.log("PROBE_RESULT", JSON.stringify(result, null, 2));
  });
});
