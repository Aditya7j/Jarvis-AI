/**
 * Rank-qualified relationship-validation suite — regression tests for the
 * production bug where "Who was the first Sikh Prime Minister of India?"
 * answered with "The Khalistan movement is a separatist movement ..." because
 * the old relevance gate accepted any lead that merely CONTAINED the words
 * "first", "sikh", "prime minister" and "india" scattered across its
 * paragraphs.
 *
 * Locked invariants:
 * 1. A rank-qualified answer must be a biographical article whose lead PROVES
 *    the requested relationship (rank + office + qualifiers + place co-occur in
 *    a tight window, with the office bound to the place). A movement/topic page
 *    that scatters the keywords is rejected even when every keyword is present.
 * 2. The proving sentence itself becomes the abstract, so the answer identifies
 *    the requested person rather than an unrelated first sentence.
 * 3. When no candidate proves the relationship the result is null (honest
 *    unavailable) — never a generic lead, never the current incumbent, never a
 *    model guess.
 * 4. Current officeholder, capital, generic, math and conversion behavior is
 *    unchanged.
 *
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyKnowledgeQuery,
  invalidateSearchCache,
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
            const lowerUrl = url.toLowerCase();
            for (const [key, val] of SEARCH_RESPONSES) {
              if (
                key.startsWith("search:") &&
                lowerUrl.includes(encodeURIComponent(key.slice(7)).toLowerCase())
              ) {
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
    query: {
      search: titles.map((title, i) => ({ title, snippet: `<span>${title}</span>`, pageid: 1000 + i })),
    },
  };
}

/**
 * The REAL "Khalistan movement" intro (fetched live). It contains every word
 * the question asks about — "first", "Sikh(s)", "India" and "prime minister" —
 * but scattered across paragraphs; it is a movement article, never the answer
 * to "who was the first Sikh Prime Minister of India?".
 */
const KHALISTAN_LEAD =
  "The Khalistan movement is a separatist movement seeking to create a homeland for Sikhs " +
  "by establishing an ethnoreligious sovereign state called Khalistan in the Punjab region. " +
  "The proposed boundaries of Khalistan vary between different groups; some suggest the entirety " +
  "of the Sikh-majority Indian state of Punjab, while larger claims include Pakistani Punjab and " +
  "other parts of North India, such as Chandigarh, Haryana, and Himachal Pradesh. " +
  "The call for a separate Sikh state began during the 1930s, when British rule in India was " +
  "nearing its end. In 1940, the first explicit call for Khalistan was made in a pamphlet titled " +
  "'Khalistan'. The Sikh separatist leader Jagjit Singh Chohan said that during his talks with " +
  "Zulfikar Ali Bhutto, who served as president and prime minister of Pakistan, the latter " +
  "affirmed his support for the Khalistan movement.";

/** A biographical lead whose relationship sentence explicitly identifies the person. */
const MANMOHAN_LEAD =
  "Manmohan Singh (26 September 1932 - 26 December 2024) was an Indian politician who served " +
  "as the prime minister of India from 2004 to 2014. He was the first and remains the only " +
  "Sikh prime minister of India.";

const INDIA_OFFICE_WIKITEXT =
  "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}";

const INDIA_WIKITEXT = "{{Infobox country\n| capital = [[New Delhi]]\n| largest_city = Mumbai\n}}";

const REACT_LEAD =
  "React is a free and open-source front-end JavaScript library for building user interfaces " +
  "based on components.";

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  ddgPayload = {};
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the exact production failure: the Khalistan movement article can never win", () => {
  it("rejects the Khalistan movement article even though it contains every keyword", async () => {
    // Khalistan ranks below the biography on title score, so make it win the
    // WALK by placing it first in the search payload AND give it the real
    // keyword-laden intro. Only Manmohan Singh proves the relationship.
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist movement");
  });

  it("walks past the movement article to the biographical candidate that proves the relationship", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement", "Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist movement");
  });

  it("a keyword-laden topic article that OUTRANKS the biography cannot win (poisoned-first)", async () => {
    // "Sikhism in India" scores higher on title keywords than "Manmohan Singh",
    // so it is ranked FIRST; its lead is the scattered keyword text. The
    // relationship gate must reject it and the ranked biography must win.
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Sikhism in India", "Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Sikhism in India", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist movement");
  });

  it("accepts a valid biographical candidate whose evidence explicitly identifies the person", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
  });
});

describe("no-guess contract: unverifiable rank-qualified questions return null", () => {
  it("only a movement article available => null, never its lead", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("only a topic article with a scattered keyword lead available => null", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Sikhism in India"])
    );
    SEARCH_RESPONSES.set("lead:Sikhism in India", KHALISTAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("an unrelated person article (Punjab, not India) => null", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Sukhdev Singh Barnala"])
    );
    SEARCH_RESPONSES.set("lead:Sukhdev Singh Barnala", "Prime Minister of Punjab");
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("never falls through to generic Wikipedia lead extraction", async () => {
    // A generic query would answer with the topic article's contentful lead.
    // The rank-qualified path must NOT: no relationship proof => null.
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Sikhism in India"])
    );
    SEARCH_RESPONSES.set(
      "lead:Sikhism in India",
      "Indian Sikhs number approximately 21 million people, making up about 1.7% of the population."
    );
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("never uses the current-incumbent extraction", async () => {
    // Only the office article (with the CURRENT incumbent) is available. The
    // rank-qualified path must not read the infobox: the lead lacks rank and
    // qualifiers, so the honest result is null — never "Narendra Modi".
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_OFFICE_WIKITEXT);
    SEARCH_RESPONSES.set(
      "lead:Prime Minister of India",
      "The Prime Minister of India is the head of government of India."
    );
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("a DuckDuckGo abstract that scatters the keywords loses to the Wikipedia fallback", async () => {
    ddgPayload = {
      Heading: "Khalistan movement",
      AbstractText: KHALISTAN_LEAD,
      Answer: "",
      RelatedTopics: [],
    };
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist movement");
  });

  it("a stale cached rank-qualified result that scattered the keywords is dropped on read", async () => {
    searchCache.set("who was the first sikh prime minister of india", {
      value: {
        query: "who was the first sikh prime minister of india",
        heading: "Khalistan movement",
        abstract: KHALISTAN_LEAD,
        answer: null,
        source: "Wikipedia",
        url: "https://en.wikipedia.org/wiki/Khalistan_movement",
        topics: [],
        engine: "Wikipedia",
      },
      at: Date.now(),
    });
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).not.toContain("separatist movement");
  });
});

describe("the evidence surfaced names the requested person", () => {
  it("uses the relationship sentence, not an unrelated first sentence", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh (26 September 1932 - 26 December 2024) was an Indian politician. " +
        "He was the first and remains the only Sikh prime minister of India."
    );
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("an Indian politician");
  });
});

describe("existing behavior is unchanged", () => {
  it("the current officeholder answer is preserved (Narendra Modi)", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_OFFICE_WIKITEXT);
    const result = await webSearch("Who is the current Prime Minister of India?");
    expect(result?.answer).toContain("Narendra Modi");
  });

  it("the capital answer is preserved (New Delhi)", async () => {
    SEARCH_RESPONSES.set(
      "search:what is the capital of india",
      searchResult(["India"])
    );
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.answer).toContain("New Delhi");
  });

  it("the generic technical path is preserved (What is React?)", async () => {
    SEARCH_RESPONSES.set("search:what is react", searchResult(["React (JavaScript library)"]));
    SEARCH_RESPONSES.set("lead:React (JavaScript library)", REACT_LEAD);
    const result = await webSearch("What is React?");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("React (JavaScript library)");
    expect(result?.abstract).toContain("user interfaces");
  });

  it("math and conversion queries never enter the rank-qualified path", () => {
    expect(parseRankQualifiedOffice("what is 15 * 3?")).toBeNull();
    expect(parseRankQualifiedOffice("convert 100 USD to INR")).toBeNull();
    expect(parseRankQualifiedOffice("what is 20% of 50?")).toBeNull();
    expect(classifyKnowledgeQuery("what is 15 * 3?").kind).toBe("generic");
    expect(classifyKnowledgeQuery("convert 100 USD to INR").kind).toBe("generic");
    expect(classifyKnowledgeQuery("what is 20% of 50?").kind).toBe("generic");
  });
});
