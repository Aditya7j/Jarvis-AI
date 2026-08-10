/**
 * Knowledge-relevance suite.
 *
 * Locks the query-aware relevance gates:
 * 1. classifyKnowledgeQuery routes officeholder/capital questions to the
 *    authoritative Wikipedia infobox path and rank-qualified questions to the
 *    concurrent race, where DuckDuckGo wins only when the content names the
 *    office, place AND rank (best-effort qualifier).
 * 2. Capital aliases ("usa" -> "United States") are normalized so the place's
 *    own article — the one carrying the `capital` infobox — is searched and
 *    answered from, and the answer never echoes the alias.
 * 3. A DuckDuckGo result whose only content is a bare title is never accepted
 *    as an answer; the Wikipedia fallback continues.
 * 4. Hinglish knowledge questions are not treated as officeholder/capital
 *    questions.
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalPlaceOf,
  classifyKnowledgeQuery,
  invalidateSearchCache,
  isContentfulTopicText,
  parseRankQualifiedOffice,
  webSearch,
} from "@/lib/toolkit/web";

const SEARCH_RESPONSES = new Map<string, unknown>();
let ddgPayload: unknown = {};

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.duckduckgo.com")) {
        return { ok: true, json: async () => ddgPayload };
      }
      if (url.includes("list=search") && !url.includes("opensearch")) {
        return {
          ok: true,
          json: async () => {
            for (const [key, val] of SEARCH_RESPONSES) {
              if (key.startsWith("search:") && url.includes(encodeURIComponent(key.slice(7)))) {
                return val;
              }
            }
            return { query: { search: [] } };
          },
        };
      }
      if (url.includes("action=opensearch")) {
        return {
          ok: true,
          json: async () => {
            for (const [key, val] of SEARCH_RESPONSES) {
              if (key.startsWith("open:") && url.includes(encodeURIComponent(key.slice(5)))) {
                return val;
              }
            }
            return ["q", []];
          },
        };
      }
      if (url.includes("prop=extracts")) {
        const title = decodeURIComponent(/titles=([^&]+)/.exec(url)?.[1] ?? "");
        return {
          ok: true,
          json: async () => ({
            query: { pages: [{ extract: SEARCH_RESPONSES.get(`lead:${title}`) ?? null }] },
          }),
        };
      }
      if (url.includes("prop=revisions")) {
        const title = decodeURIComponent(/titles=([^&]+)/.exec(url)?.[1] ?? "");
        return {
          ok: true,
          json: async () => ({
            query: {
              pages: [
                {
                  revisions: [
                    { slots: { main: { content: SEARCH_RESPONSES.get(`wt:${title}`) ?? null } } },
                  ],
                },
              ],
            },
          }),
        };
      }
      throw new Error(`unmocked url: ${url}`);
    })
  );
}

function searchResult(titles: string[]): unknown {
  return {
    query: { search: titles.map((title, i) => ({ title, snippet: `<span>${title}</span>`, pageid: 1000 + i })) },
  };
}

function fetchCalls(): string[] {
  const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return (fn.mock.calls as Array<[RequestInfo | URL]>).map(([input]) => String(input));
}

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  ddgPayload = {};
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isContentfulTopicText", () => {
  it("accepts a 'Title — description' topic", () => {
    expect(isContentfulTopicText("Event loop (JavaScript) — The mechanism that handles asynchronous operations.")).toBe(true);
    expect(isContentfulTopicText("Closure — A function that captures its lexical scope.")).toBe(true);
  });

  it("accepts a long-enough passage even without a separator", () => {
    expect(isContentfulTopicText("In programming languages, a closure is a technique for implementing lexically scoped name binding.")).toBe(true);
  });

  it("rejects a bare title and empty text", () => {
    expect(isContentfulTopicText("Event loop")).toBe(false);
    expect(isContentfulTopicText("Closure")).toBe(false);
    expect(isContentfulTopicText("   ")).toBe(false);
    expect(isContentfulTopicText("")).toBe(false);
  });
});

describe("canonicalPlaceOf", () => {
  it("normalizes unambiguous aliases to their article title", () => {
    expect(canonicalPlaceOf("usa")).toBe("United States");
    expect(canonicalPlaceOf("USA")).toBe("United States");
    expect(canonicalPlaceOf("uk")).toBe("United Kingdom");
    expect(canonicalPlaceOf("uae")).toBe("United Arab Emirates");
  });

  it("strips a leading 'the' before matching", () => {
    expect(canonicalPlaceOf("the usa")).toBe("United States");
    expect(canonicalPlaceOf("the UK")).toBe("United Kingdom");
  });

  it("returns null for places that need no normalization", () => {
    expect(canonicalPlaceOf("india")).toBeNull();
    expect(canonicalPlaceOf("france")).toBeNull();
    expect(canonicalPlaceOf("")).toBeNull();
  });
});

describe("parseRankQualifiedOffice", () => {
  it("extracts rank, office, noun, qualifiers and place", () => {
    const parsed = parseRankQualifiedOffice("Who is the first Sikh prime minister of India?");
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe("sikh prime minister");
    expect(parsed?.officeNoun).toBe("minister");
    expect(parsed?.qualifiers).toEqual(["sikh", "prime"]);
    expect(parsed?.place).toBe("india");
  });

  it("handles 'who was the last president of the United States?'", () => {
    const parsed = parseRankQualifiedOffice("Who was the last president of the United States?");
    expect(parsed?.rank).toBe("last");
    expect(parsed?.officeNoun).toBe("president");
    expect(parsed?.qualifiers).toEqual([]);
    expect(parsed?.place).toBe("the united states");
  });

  it("returns null for non-rank-qualified questions", () => {
    expect(parseRankQualifiedOffice("Who is the current prime minister of India?")).toBeNull();
    expect(parseRankQualifiedOffice("What is the capital of France?")).toBeNull();
    expect(parseRankQualifiedOffice("Who is Narendra Modi?")).toBeNull();
  });
});

describe("classifyKnowledgeQuery", () => {
  it("detects rank-qualified questions before plain officeholder questions", () => {
    const cls = classifyKnowledgeQuery("Who was the first Sikh prime minister of India?");
    expect(cls.kind).toBe("rank-qualified");
    expect(cls.officeNoun).toBe("minister");
    expect(cls.place).toBe("india");
    expect(cls.rank).toBe("first");
  });

  it("detects plain officeholder questions", () => {
    const cls = classifyKnowledgeQuery("Who is the current prime minister of India?");
    expect(cls.kind).toBe("officeholder");
    expect(cls.office).toBe("prime minister");
    expect(cls.place).toBe("india");
  });

  it("detects capital questions with a canonical place", () => {
    const cls = classifyKnowledgeQuery("What is the capital of USA?");
    expect(cls.kind).toBe("capital");
    expect(cls.place).toBe("usa");
    expect(cls.canonicalPlace).toBe("United States");
  });

  it("treats generic and Hinglish questions as generic", () => {
    expect(classifyKnowledgeQuery("What is a JavaScript closure?").kind).toBe("generic");
    expect(classifyKnowledgeQuery("React kya hai?").kind).toBe("generic");
    expect(classifyKnowledgeQuery("What is the weather today?").kind).toBe("generic");
  });
});

describe("webSearch relevance gates (mocked)", () => {
  it("capital alias 'usa' is answered from the United States article, never the alias", async () => {
    SEARCH_RESPONSES.set(
      "search:what is the capital of usa",
      searchResult(["Usa"])
    );
    SEARCH_RESPONSES.set("search:United States", searchResult(["United States"]));
    SEARCH_RESPONSES.set(
      "wt:United States",
      "{{Infobox country\n| capital = [[Washington, D.C.]]\n| largest_city = New York City\n}}"
    );
    const result = await webSearch("what is the capital of usa");
    expect(result?.heading).toBe("United States");
    expect(result?.answer).toContain("Washington, D.C.");
    expect(result?.answer).toContain("the United States");
    expect(result?.answer).not.toContain("Usa");
  });

  it("capital alias 'uk' is answered from the United Kingdom article", async () => {
    SEARCH_RESPONSES.set(
      "search:what is the capital of uk",
      searchResult(["UK Independence Party"])
    );
    SEARCH_RESPONSES.set("search:United Kingdom", searchResult(["United Kingdom"]));
    SEARCH_RESPONSES.set(
      "wt:United Kingdom",
      "{{Infobox country\n| capital = [[London]]\n| largest_city = London\n}}"
    );
    const result = await webSearch("what is the capital of uk");
    expect(result?.heading).toBe("United Kingdom");
    expect(result?.answer).toContain("London");
    expect(result?.answer).not.toContain("UK Independence");
  });

  it("a rank-qualified question never consults the current-incumbent shortcut, and an irrelevant DuckDuckGo abstract loses to the fallback", async () => {
    // DuckDuckGo returns a non-empty but IRRELEVANT abstract (mentions no
    // office, no rank). It must not abort the Wikipedia fallback.
    ddgPayload = {
      Heading: "India",
      AbstractText: "India is a country in South Asia.",
      Answer: "",
      RelatedTopics: [],
    };
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the 13th prime minister of India and the first Sikh to hold the office."
    );
    const result = await webSearch("who was the first sikh prime minister of india");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.abstract).toContain("prime minister");
    expect(result?.abstract).not.toContain("country in South Asia");
  });

  it("DuckDuckGo wins a rank-qualified question only when it names office, place, rank and qualifier", async () => {
    ddgPayload = {
      Heading: "Manmohan Singh",
      AbstractText:
        "Manmohan Singh was the first Sikh prime minister of India, serving from 2004 to 2014.",
      Answer: "",
      RelatedTopics: [],
    };
    const result = await webSearch("who was the first sikh prime minister of india");
    expect(result?.engine).toBe("DuckDuckGo");
    expect(result?.abstract).toContain("first Sikh prime minister");
  });

  it("a title-only DuckDuckGo topic never becomes the answer — the Wikipedia fallback continues", async () => {
    ddgPayload = {
      Heading: "Event loop",
      AbstractText: "",
      Answer: "",
      RelatedTopics: [{ Text: "Event loop", FirstURL: "https://duckduckgo.com/?q=event-loop" }],
    };
    SEARCH_RESPONSES.set(
      "search:what is the event loop",
      searchResult(["Event loop (JavaScript)"])
    );
    SEARCH_RESPONSES.set(
      "lead:Event loop (JavaScript)",
      "In computer science, an event loop is a programming construct that waits for and dispatches events."
    );
    const result = await webSearch("what is the event loop");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.abstract).toContain("dispatches events");
    expect(result?.abstract).not.toBe("Event loop");
  });

  it("fails honestly (null) when DuckDuckGo is irrelevant and the fallback finds nothing", async () => {
    ddgPayload = {
      Heading: "Closure",
      AbstractText: "",
      Answer: "",
      RelatedTopics: [{ Text: "Closure", FirstURL: "https://duckduckgo.com/?q=closure" }],
    };
    SEARCH_RESPONSES.set("search:what is the event loop", { query: { search: [] } });
    SEARCH_RESPONSES.set("search:event loop", { query: { search: [] } });
    SEARCH_RESPONSES.set("open:what is the event loop", ["q", []]);
    SEARCH_RESPONSES.set("open:event loop", ["q", []]);
    const result = await webSearch("what is the event loop");
    expect(result).toBeNull();
  });

  it("officeholder questions skip DuckDuckGo entirely and answer from the infobox", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set(
      "wt:Prime Minister of India",
      "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}"
    );
    const result = await webSearch("who is the current prime minister of india");
    expect(result?.answer).toContain("Narendra Modi");
    expect(fetchCalls().some((u) => u.includes("api.duckduckgo.com"))).toBe(false);
  });
});
