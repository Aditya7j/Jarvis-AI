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
 * 4. Hinglish rank-qualified ("pehla … kaun tha") AND plain officeholder
 *    questions ("India ka pradhan mantri kaun hai?") are treated like their
 *    English shapes, while definitional Hinglish ("kya hai") questions stay
 *    generic.
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalPlaceOf,
  classifyKnowledgeQuery,
  invalidateSearchCache,
  isContentfulTopicText,
  parseHinglishOfficeholderOffice,
  parseHinglishRankQualifiedOffice,
  parseRankQualifiedOffice,
  searchCache,
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

describe("parseHinglishRankQualifiedOffice", () => {
  it("parses 'India ka pehla Sikh Prime Minister kaun tha?' into the English parts", () => {
    const parsed = parseHinglishRankQualifiedOffice("India ka pehla Sikh Prime Minister kaun tha?");
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe("sikh prime minister");
    expect(parsed?.officeNoun).toBe("minister");
    expect(parsed?.qualifiers).toEqual(["sikh", "prime"]);
    expect(parsed?.place).toBe("india");
  });

  it("handles the topicalized order 'kaun tha India ka pichhla PM?'", () => {
    const parsed = parseHinglishRankQualifiedOffice("kaun tha India ka pichhla PM?");
    expect(parsed?.rank).toBe("previous");
    expect(parsed?.office).toBe("prime minister");
    expect(parsed?.officeNoun).toBe("minister");
    expect(parsed?.place).toBe("india");
  });

  it("expands Hindi office phrases and canonicalizes place aliases", () => {
    const parsed = parseHinglishRankQualifiedOffice("Bharat ka pehla pradhan mantri kaun tha?");
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe("prime minister");
    expect(parsed?.officeNoun).toBe("minister");
    expect(parsed?.place).toBe("bharat");
    expect(parsed?.canonicalPlace).toBe("India");
  });

  it("returns null for definitional 'kya hai' questions and English-only shapes", () => {
    expect(parseHinglishRankQualifiedOffice("React kya hai?")).toBeNull();
    expect(parseHinglishRankQualifiedOffice("Weather kaisa hai?")).toBeNull();
    expect(parseHinglishRankQualifiedOffice("Who is the first Sikh PM of India?")).toBeNull();
  });
});

describe("parseHinglishOfficeholderOffice", () => {
  it("parses 'India ka pradhan mantri kaun hai?' into office + place", () => {
    const parsed = parseHinglishOfficeholderOffice("India ka pradhan mantri kaun hai?");
    expect(parsed?.office).toBe("prime minister");
    expect(parsed?.place).toBe("india");
    expect(parsed?.canonicalPlace).toBeNull();
  });

  it("expands Hindi office phrases and canonicalizes place aliases", () => {
    const parsed = parseHinglishOfficeholderOffice("Bharat ke rashtrapati kaun hai?");
    expect(parsed?.office).toBe("president");
    expect(parsed?.place).toBe("bharat");
    expect(parsed?.canonicalPlace).toBe("India");
  });

  it("handles the topicalized order 'kaun hai America ka president?'", () => {
    const parsed = parseHinglishOfficeholderOffice("kaun hai America ka president?");
    expect(parsed?.office).toBe("president");
    expect(parsed?.place).toBe("america");
  });

  it("accepts the polite plural 'kaun hain'", () => {
    const parsed = parseHinglishOfficeholderOffice("India ke pradhan mantri kaun hain?");
    expect(parsed?.office).toBe("prime minister");
    expect(parsed?.place).toBe("india");
  });

  it("returns null for past-tense, place-fact and definitional questions", () => {
    expect(parseHinglishOfficeholderOffice("India ka pradhan mantri kaun tha?")).toBeNull();
    expect(parseHinglishOfficeholderOffice("India ka pehla pradhan mantri kaun tha?")).toBeNull();
    expect(parseHinglishOfficeholderOffice("Bharat ki rajdhani kaun hai?")).toBeNull();
    expect(parseHinglishOfficeholderOffice("React kya hai?")).toBeNull();
    expect(parseHinglishOfficeholderOffice("Who is the current prime minister of India?")).toBeNull();
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

  it("detects Hinglish rank-qualified questions", () => {
    const cls = classifyKnowledgeQuery("India ka pehla Sikh Prime Minister kaun tha?");
    expect(cls.kind).toBe("rank-qualified");
    expect(cls.officeNoun).toBe("minister");
    expect(cls.place).toBe("india");
    expect(cls.rank).toBe("first");
    expect(cls.qualifiers).toEqual(["sikh", "prime"]);
  });

  it("detects Hinglish plain officeholder questions", () => {
    const cls = classifyKnowledgeQuery("India ka pradhan mantri kaun hai?");
    expect(cls.kind).toBe("officeholder");
    expect(cls.office).toBe("prime minister");
    expect(cls.place).toBe("india");
  });

  it("keeps past-tense Hinglish questions generic but routes the capital place-fact to capital", () => {
    expect(classifyKnowledgeQuery("India ka pradhan mantri kaun tha?").kind).toBe("generic");
    expect(classifyKnowledgeQuery("Bharat ki rajdhani kya hai?").kind).toBe("capital");
  });

  it("detects capital questions with a canonical place", () => {
    const cls = classifyKnowledgeQuery("What is the capital of USA?");
    expect(cls.kind).toBe("capital");
    expect(cls.place).toBe("usa");
    expect(cls.canonicalPlace).toBe("United States");
  });

  it("treats generic and Hinglish questions as generic", () => {
    expect(classifyKnowledgeQuery("What is a JavaScript closure?").kind).toBe("generic");
    expect(classifyKnowledgeQuery("What is React?").kind).toBe("generic");
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

  it("REJECTS a rank-qualified candidate whose content does not support the requested relationship", async () => {
    // The requested relationship is "first Sikh prime minister OF INDIA".
    // This candidate only shares the office noun ("minister") — its content
    // never establishes rank, qualifiers or the place. It must be rejected.
    ddgPayload = { Heading: "", AbstractText: "", Answer: "", RelatedTopics: [] };
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Sukhdev Singh Barnala"])
    );
    SEARCH_RESPONSES.set(
      "lead:Sukhdev Singh Barnala",
      "Prime Minister of Punjab"
    );
    const result = await webSearch("who was the first sikh prime minister of india");
    expect(result).toBeNull();
  });

  it("ACCEPTS a rank-qualified candidate whose content establishes rank, qualifiers, office and place", async () => {
    ddgPayload = { Heading: "", AbstractText: "", Answer: "", RelatedTopics: [] };
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the first Sikh prime minister of India."
    );
    const result = await webSearch("who was the first sikh prime minister of india");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first Sikh prime minister");
    expect(result?.abstract).toContain("India");
  });

  it("answers a Hinglish rank-qualified question from content supporting rank, qualifiers, office and place", async () => {
    // The fallback searches the office + place phrase ("sikh prime minister
    // india") — that exact retry is mocked here.
    ddgPayload = { Heading: "", AbstractText: "", Answer: "", RelatedTopics: [] };
    SEARCH_RESPONSES.set(
      "search:sikh prime minister india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the first Sikh prime minister of India, serving 2004 to 2014."
    );
    const result = await webSearch("india ka pehla sikh prime minister kaun tha");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first Sikh prime minister");
  });

  it("REJECTS a Hinglish rank-qualified candidate whose content does not support the relationship", async () => {
    ddgPayload = { Heading: "", AbstractText: "", Answer: "", RelatedTopics: [] };
    SEARCH_RESPONSES.set(
      "search:sikh prime minister india",
      searchResult(["Sukhdev Singh Barnala"])
    );
    SEARCH_RESPONSES.set(
      "lead:Sukhdev Singh Barnala",
      "Prime Minister of Punjab"
    );
    const result = await webSearch("india ka pehla sikh prime minister kaun tha");
    expect(result).toBeNull();
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

  it("a generic DuckDuckGo abstract that only shares a keyword loses to the Wikipedia fallback", async () => {
    // The question is about "closure"; a JavaScript definition shares the
    // keyword "JavaScript" but never names the subject. It must not win the
    // race over a fallback that actually answers the question.
    ddgPayload = {
      Heading: "JavaScript",
      AbstractText: "JavaScript is a high-level programming language used on the web.",
      Answer: "",
      RelatedTopics: [],
    };
    SEARCH_RESPONSES.set(
      "search:what is a javascript closure",
      searchResult(["Closure (computer programming)"])
    );
    SEARCH_RESPONSES.set(
      "lead:Closure (computer programming)",
      "In programming languages, a closure is a technique of lexically binding names to values."
    );
    const result = await webSearch("what is a javascript closure");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("Closure (computer programming)");
  });

  it("a generic DuckDuckGo result that names the subject wins the race", async () => {
    ddgPayload = {
      Heading: "Closure (computer programming)",
      AbstractText:
        "In programming languages, a closure, also lexical closure or function closure, is a technique for implementing lexically scoped name binding.",
      Answer: "",
      RelatedTopics: [],
    };
    const result = await webSearch("what is a javascript closure");
    expect(result?.engine).toBe("DuckDuckGo");
    expect(result?.abstract).toContain("closure");
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

  it("answers a Hinglish officeholder question from the infobox incumbent, skipping DuckDuckGo", async () => {
    // "india ka pradhan mantri kaun hai" is classified officeholder: it skips
    // DuckDuckGo, searches the office + place phrase ("prime minister india")
    // and reads the incumbent field of the matched article.
    SEARCH_RESPONSES.set(
      "search:prime minister india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set(
      "wt:Prime Minister of India",
      "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}"
    );
    const result = await webSearch("india ka pradhan mantri kaun hai");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of India");
    expect(fetchCalls().some((u) => u.includes("api.duckduckgo.com"))).toBe(false);
  });
});

describe("webSearch cache validation (mocked)", () => {
  function wrongCachedResult(query: string, heading: string, abstract: string) {
    searchCache.set(query, {
      value: {
        query,
        heading,
        abstract,
        answer: null,
        source: "Wikipedia",
        url: `https://en.wikipedia.org/wiki/${heading.replace(/ /g, "_")}`,
        topics: [],
        engine: "Wikipedia",
      },
      at: Date.now(),
    });
  }

  it("rejects a stale cached result for a Hinglish officeholder query and re-runs the authoritative path", async () => {
    // The OLD implementation cached an unrelated generic Wikipedia page for
    // "india ka pradhan mantri kaun hai" (a playback singer) before the
    // Hinglish officeholder parser existed. That stale entry must NOT be
    // served; the query is re-classified as officeholder and answered from
    // the infobox incumbent.
    wrongCachedResult(
      "india ka pradhan mantri kaun hai",
      "Palak Muchhal",
      "Palak Muchhal Sharma is an Indian playback singer and songwriter."
    );
    SEARCH_RESPONSES.set(
      "search:prime minister india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set(
      "wt:Prime Minister of India",
      "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}"
    );
    const result = await webSearch("india ka pradhan mantri kaun hai");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of India");
    expect(result?.answer).not.toContain("Palak");
    // The stale entry was evicted and replaced with the validated result.
    expect(searchCache.get("india ka pradhan mantri kaun hai")?.value.answer).toContain(
      "Narendra Modi"
    );
  });

  it("rejects a stale cached result for an English officeholder query and re-runs the authoritative path", async () => {
    wrongCachedResult(
      "who is the current prime minister of india",
      "Palak Muchhal",
      "Palak Muchhal Sharma is an Indian playback singer and songwriter."
    );
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
    expect(result?.answer).not.toContain("Palak");
    expect(searchCache.get("who is the current prime minister of india")?.value.answer).toContain(
      "Narendra Modi"
    );
  });

  it("rejects a stale cached result for a capital query and re-runs the authoritative path", async () => {
    // A generic country page (even one that mentions the capital) is not the
    // structured capital answer — only the infobox-derived answer is valid.
    wrongCachedResult(
      "what is the capital of france",
      "France",
      "France is a country in Western Europe. Its capital is Paris."
    );
    SEARCH_RESPONSES.set(
      "search:what is the capital of france",
      searchResult(["France"])
    );
    SEARCH_RESPONSES.set(
      "wt:France",
      "{{Infobox country\n| capital = [[Paris]]\n| largest_city = Paris\n}}"
    );
    const result = await webSearch("what is the capital of france");
    expect(result?.answer).toContain("Paris");
    expect(result?.answer).toContain("capital of France");
    expect(searchCache.get("what is the capital of france")?.value.answer).toContain("Paris");
  });

  it("a stale cached rank-qualified result cannot bypass the semantic gate", async () => {
    // The stale entry answers with the CURRENT incumbent — it never names the
    // requested rank ("first"). It must be rejected and the fresh search used.
    searchCache.set("who was the first sikh prime minister of india", {
      value: {
        query: "who was the first sikh prime minister of india",
        heading: "Prime Minister of India",
        abstract: "The Prime Minister of India is the head of government.",
        answer: "The current Prime Minister of India is Narendra Modi (per Wikipedia).",
        source: "Wikipedia",
        url: "https://en.wikipedia.org/wiki/Prime_Minister_of_India",
        topics: [],
        engine: "Wikipedia",
      },
      at: Date.now(),
    });
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the first Sikh prime minister of India, serving 2004 to 2014."
    );
    const result = await webSearch("who was the first sikh prime minister of india");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first Sikh prime minister");
    expect(result?.abstract).not.toContain("Narendra Modi");
  });

  it("rejects a stale generic cached result that never names the question's subject", async () => {
    wrongCachedResult(
      "what is a javascript closure",
      "India",
      "India is a country in South Asia."
    );
    SEARCH_RESPONSES.set(
      "search:what is a javascript closure",
      searchResult(["Closure (computer programming)"])
    );
    SEARCH_RESPONSES.set(
      "lead:Closure (computer programming)",
      "In programming languages, a closure is a technique for implementing lexically scoped name binding."
    );
    const result = await webSearch("what is a javascript closure");
    expect(result?.heading).toBe("Closure (computer programming)");
    expect(result?.abstract).toContain("closure");
    expect(result?.abstract).not.toContain("South Asia");
  });

  it("serves a valid cached result without re-hitting the network", async () => {
    // Genuinely valid results keep the 5-minute cache behavior.
    SEARCH_RESPONSES.set(
      "search:what is a javascript closure",
      searchResult(["Closure (computer programming)"])
    );
    SEARCH_RESPONSES.set(
      "lead:Closure (computer programming)",
      "In programming languages, a closure is a technique for implementing lexically scoped name binding."
    );
    const first = await webSearch("what is a javascript closure");
    expect(first?.heading).toBe("Closure (computer programming)");
    const callsAfterFirst = fetchCalls().length;
    const second = await webSearch("what is a javascript closure");
    expect(second?.heading).toBe("Closure (computer programming)");
    expect(fetchCalls().length).toBe(callsAfterFirst);
  });
});
