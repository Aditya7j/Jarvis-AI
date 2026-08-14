/**
 * Rank-qualified DISCOVERY regression suite — the exact production failure:
 * "Who was the first Sikh Prime Minister of India?" returned "I couldn't
 * verify that" because the raw question surfaced unrelated pages ("Khalistan
 * movement"), hits.length > 0 skipped the canonical discovery search, the
 * movement was correctly rejected, and the biography (Manmohan Singh) was
 * never discovered.
 *
 * The fix: for rank-qualified questions the pipeline ALWAYS runs a small
 * fixed set of bounded discovery queries derived from the classified
 * structure (raw query, office + place, rank + office + place, qualifier
 * forms, canonical article title) CONCURRENTLY, merges and deduplicates the
 * candidate titles, and only then runs the existing relationship validation.
 * Search ranking is discovery only — it never decides the answer.
 *
 * Locked invariants:
 * 1. The poisoned raw-query result is still rejected, but the canonical
 *    discovery query now finds the biography, which wins.
 * 2. No hardcoding — the same cls-derived queries serve English, Hinglish
 *    and the "PM" abbreviation identically.
 * 3. Honest refusal is preserved: only-unrelated candidates, absent
 *    relationship sentences and wrong-country candidates still return null.
 * 4. Current officeholder, capital and generic behavior is unchanged.
 *
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRankQualifiedDiscoveryQueries,
  classifyKnowledgeQuery,
  invalidateSearchCache,
  searchCache,
  webSearch,
  type KnowledgeQuery,
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
        return { ok: true, json: async () => ["q", []] };
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

/** The canonical rank + qualifiers + office + place discovery query for the Sikh case. */
const SIKH_CANONICAL_QUERY = "first sikh prime minister india";

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  ddgPayload = {};
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery queries are derived from the classification, not hardcoded", () => {
  it("generates the canonical discovery set for the Sikh case", () => {
    const cls = classifyKnowledgeQuery("Who was the first Sikh Prime Minister of India?");
    expect(cls.kind).toBe("rank-qualified");
    const queries = buildRankQualifiedDiscoveryQueries(
      "Who was the first Sikh Prime Minister of India?",
      cls
    );
    // Raw query + office + place + rank + office + place + canonical article title.
    expect(queries).toContain("Who was the first Sikh Prime Minister of India?");
    expect(queries).toContain("sikh prime minister india");
    expect(queries).toContain("first sikh prime minister india");
    expect(queries).toContain("Sikh Prime Minister of India");
    expect(queries.length).toBeLessThanOrEqual(5);
  });

  it("the same cls-derived queries serve the Hinglish shape and the 'PM' abbreviation", () => {
    const english = classifyKnowledgeQuery("Who was the first Sikh Prime Minister of India?");
    const hinglish = classifyKnowledgeQuery("India ka pehla Sikh Prime Minister kaun tha?");
    const pm = classifyKnowledgeQuery("India ka pehla Sikh PM kaun tha?");
    expect(hinglish.kind).toBe("rank-qualified");
    expect(pm.kind).toBe("rank-qualified");
    // The first discovery query is the raw question text (language differs);
    // the canonical office/rank/qualifier queries are identical across shapes.
    const derived = (query: string, cls: KnowledgeQuery) =>
      buildRankQualifiedDiscoveryQueries(query, cls).slice(1);
    expect(derived("India ka pehla Sikh Prime Minister kaun tha?", hinglish)).toEqual(
      derived("Who was the first Sikh Prime Minister of India?", english)
    );
    expect(derived("India ka pehla Sikh PM kaun tha?", pm)).toEqual(
      derived("Who was the first Sikh Prime Minister of India?", english)
    );
    expect(buildRankQualifiedDiscoveryQueries("Who was the first Sikh Prime Minister of India?", english)).toContain(
      "first sikh prime minister india"
    );
  });
});

describe("the exact production bug: raw query is poisoned, canonical discovery finds the biography", () => {
  it("raw query returns Khalistan, canonical discovery returns Manmohan Singh -> Manmohan wins", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).not.toBeNull();
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist movement");
  });

  it("poisoned-first: search #1 is Khalistan, search #2 is Manmohan Singh — #1 rejected, #2 wins", async () => {
    // The exact production failure: the raw full-text search returned ONLY the
    // movement article; previously hits.length > 0 skipped the canonical
    // discovery and the walk had no biography to reach.
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("Sikh prime minister of India");
    expect(result?.abstract).not.toContain("Khalistan");
  });

  it("raw query returns an unrelated topic, another discovery query returns the biography -> biography wins", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Sikhism in India"])
    );
    SEARCH_RESPONSES.set(
      "search:sikh prime minister india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set("lead:Sikhism in India", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
  });

  it("multiple unrelated candidates before the valid biography -> biography wins", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement", "Sikhism in India"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set(
      "lead:Sikhism in India",
      "Indian Sikhs number approximately 21 million people and account for 1.7% of India's population."
    );
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist");
  });

  it("when the raw query is empty, the canonical discovery still finds the biography", async () => {
    SEARCH_RESPONSES.set("search:who was the first sikh prime minister of india", {
      query: { search: [] },
    });
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("Sikh prime minister of India");
  });
});

describe("Hinglish and 'PM' abbreviation use the SAME discovery pipeline", () => {
  it("India ka pehla Sikh Prime Minister kaun tha? -> Manmohan Singh", async () => {
    SEARCH_RESPONSES.set(
      "search:india ka pehla sikh prime minister kaun tha",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("India ka pehla Sikh Prime Minister kaun tha?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");
    expect(result?.abstract).not.toContain("separatist movement");
  });

  it("India ka pehla Sikh PM kaun tha? (abbreviation) -> Manmohan Singh", async () => {
    SEARCH_RESPONSES.set(
      "search:india ka pehla sikh pm kaun tha",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("India ka pehla Sikh PM kaun tha?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("Sikh prime minister of India");
  });

  it("Who was the first Sikh PM of India? (English abbreviation) -> Manmohan Singh", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh pm of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh PM of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("Sikh prime minister of India");
  });
});

describe("honest refusal is preserved after all discovery is exhausted", () => {
  it("only unrelated candidates from every discovery query -> null", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(
      "search:sikh prime minister india",
      searchResult(["Sikhism in India"])
    );
    SEARCH_RESPONSES.set(
      `search:${SIKH_CANONICAL_QUERY}`,
      searchResult(["Sikhism in India"])
    );
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);
    SEARCH_RESPONSES.set(
      "lead:Sikhism in India",
      "Indian Sikhs number approximately 21 million people and account for 1.7% of India's population."
    );

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("a valid candidate whose lead lacks the relationship sentence -> null", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh is an Indian economist. The first Sikh communities arrived in India " +
        "centuries ago. He was a prime minister and a respected scholar."
    );

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("a wrong-country candidate whose lead binds the office to another place -> null", async () => {
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the first Sikh prime minister of Pakistan, serving from 2004 to 2014."
    );

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("the current officeholder is never returned for a historical rank question", async () => {
    // "Narendra Modi is the current PM" lacks rank + qualifiers: honest null.
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Narendra Modi"]));
    SEARCH_RESPONSES.set(
      "lead:Narendra Modi",
      "Narendra Modi is the Prime Minister of India. He is the current head of government."
    );

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("cache never resurrects a previously invalid rank-qualified result", async () => {
    // Only a movement article is discoverable -> null, and null is never cached.
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Khalistan movement"])
    );
    SEARCH_RESPONSES.set("lead:Khalistan movement", KHALISTAN_LEAD);

    const first = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(first).toBeNull();
    expect(searchCache.has("who was the first sikh prime minister of india")).toBe(false);

    // A stale invalid entry inserted into the cache is dropped on read and the
    // valid biography is recomputed fresh.
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
    SEARCH_RESPONSES.set(`search:${SIKH_CANONICAL_QUERY}`, searchResult(["Manmohan Singh"]));
    SEARCH_RESPONSES.set("lead:Manmohan Singh", MANMOHAN_LEAD);

    const second = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(second?.heading).toBe("Manmohan Singh");
    expect(second?.abstract).not.toContain("separatist movement");
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

  it("India ka pradhan mantri kaun hai? is preserved (Narendra Modi)", async () => {
    SEARCH_RESPONSES.set(
      "search:india ka pradhan mantri kaun hai",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_OFFICE_WIKITEXT);
    const result = await webSearch("India ka pradhan mantri kaun hai?");
    expect(result?.answer).toContain("Narendra Modi");
  });

  it("the capital answer is preserved (New Delhi)", async () => {
    SEARCH_RESPONSES.set("search:what is the capital of india", searchResult(["India"]));
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.answer).toContain("New Delhi");
  });

  it("Bharat ki rajdhani kya hai? is a capital question answered from the India infobox (New Delhi)", async () => {
    // The Hinglish capital shape ("<place> ki rajdhani kya hai?") is classified
    // capital (a WHAT place-fact, never rank-qualified), normalized to its
    // canonical place ("bharat" -> "India") and answered from the India
    // article's infobox `capital` field — the same authoritative path as the
    // English "what is the capital of India?".
    const cls = classifyKnowledgeQuery("Bharat ki rajdhani kya hai?");
    expect(cls.kind).toBe("capital");
    expect(cls.place).toBe("bharat");
    expect(cls.canonicalPlace).toBe("India");
    expect(cls.kind).not.toBe("rank-qualified");
    SEARCH_RESPONSES.set("search:bharat ki rajdhani kya hai", searchResult(["India"]));
    SEARCH_RESPONSES.set("search:India", searchResult(["India"]));
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("Bharat ki rajdhani kya hai?");
    expect(result?.answer).toContain("New Delhi");
    expect(result?.answer).toContain("capital of India");
    expect(result?.answer).not.toContain("Bharat");
  });

  it("the generic technical path is preserved (What is React?)", async () => {
    SEARCH_RESPONSES.set("search:what is react", searchResult(["React (JavaScript library)"]));
    SEARCH_RESPONSES.set("lead:React (JavaScript library)", REACT_LEAD);
    const result = await webSearch("What is React?");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("React (JavaScript library)");
    expect(result?.abstract).toContain("user interfaces");
  });
});
