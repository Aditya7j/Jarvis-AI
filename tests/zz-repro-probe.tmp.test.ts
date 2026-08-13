import { describe, it } from "vitest";
import { webSearch, classifyKnowledgeQuery, parseOfficeQuestion, invalidateSearchCache } from "@/lib/toolkit/web";

const QUERIES = [
  "who is the current PM of India?",
  "who is the current Prime Minister of India?",
  "India ka pradhan mantri kaun hai?",
  "who is the current Chief Minister of Bihar?",
  "who was the first Sikh Prime Minister of India?",
  "what is the capital of India?",
  "what is React?",
];

describe("LIVE repro probe (temporary)", () => {
  it("classify + search each repro query", async () => {
    invalidateSearchCache();
    for (const q of QUERIES) {
      console.log("==== QUERY:", JSON.stringify(q));
      console.log("PARSE_OFFICE", JSON.stringify(parseOfficeQuestion(q)));
      const cls = classifyKnowledgeQuery(q);
      console.log("KNOWLEDGE_CLASS", JSON.stringify(cls));
      const result = await webSearch(q, 20000);
      console.log(
        "RESULT",
        JSON.stringify(
          result
            ? {
                engine: result.engine,
                heading: result.heading,
                answer: result.answer,
                abstract: result.abstract ? result.abstract.slice(0, 300) : null,
              }
            : null,
          null,
          2
        )
      );
    }
  }, 180000);
});
