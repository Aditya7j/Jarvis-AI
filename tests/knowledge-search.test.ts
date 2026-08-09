/**
 * Knowledge-search helper & Wikipedia-fallback suite.
 *
 * Locks the search fixes: the officeholder answer comes from the article's
 * infobox incumbent, the best article is picked by our own ranking (never the
 * raw MediaWiki order, which surfaces "Prime Minister's Office (India)" and
 * "Closed-ended question"), typo'd questions recover via OpenSearch
 * suggestions, and conversation context flows into follow-up queries.
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryKeywords,
  parseOfficeQuestion,
  parseCapitalQuestion,
  officeLabelOf,
  officeNounOf,
  anchorOf,
  properNounsOf,
  enrichSearchQuery,
  extractIncumbentName,
  extractCapitalName,
  webSearch,
} from "@/lib/toolkit/web";

const SEARCH_RESPONSES = new Map<string, unknown>();

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.duckduckgo.com")) {
        // The Instant Answer API is empty for these general queries, which is
        // what routes the real flow into the Wikipedia knowledge fallback.
        return { ok: true, json: async () => ({}) };
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

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("query parsing helpers", () => {
  it("extracts content keywords, dropping stopwords and duplicates", () => {
    expect(queryKeywords("who is the current prime minister of india")).toEqual([
      "prime",
      "minister",
      "india",
    ]);
  });

  it("parses officeholder questions", () => {
    expect(parseOfficeQuestion("Who is the current prime minister of India?")).toEqual({
      office: "prime minister",
      place: "india",
    });
    expect(parseOfficeQuestion("Who is the current prime minister of the united states?")).toEqual({
      office: "prime minister",
      place: "the united states",
    });
  });

  it("rejects non-officeholder questions", () => {
    expect(parseOfficeQuestion("What is the capital of France?")).toBeNull();
    expect(parseOfficeQuestion("Who is Narendra Modi?")).toBeNull();
    expect(parseOfficeQuestion("Who is this?")).toBeNull();
  });

  it("parses capital questions", () => {
    expect(parseCapitalQuestion("What is the capital of France?")).toEqual({ place: "france" });
    expect(parseCapitalQuestion("what is the capital of australia")).toEqual({ place: "australia" });
    expect(parseCapitalQuestion("Who is the current prime minister of india?")).toBeNull();
    expect(parseCapitalQuestion("What is this?")).toBeNull();
  });

  it("derives office labels and anchors", () => {
    expect(officeLabelOf("Who is the current prime minister?")).toBe("prime minister");
    expect(anchorOf("what is the capital of france?")).toBe("france");
    expect(anchorOf("who is the current prime minister of india?")).toBe("india");
    expect(anchorOf("what is 2+2?")).toBeNull();
  });

  it("picks proper nouns, ignoring the sentence-initial word", () => {
    expect(properNounsOf("What is the capital of France?")).toEqual(["france"]);
    expect(properNounsOf("who is the prime minister of India")).toEqual(["india"]);
  });
});

describe("enrichSearchQuery", () => {
  it("carries the place from a prior turn into an ambiguous follow-up", () => {
    expect(
      enrichSearchQuery("who is the current prime minister?", [
        "Who is the current prime minister of India?",
      ])
    ).toBe("who is the current prime minister of india");
  });

  it("leaves a self-contained question untouched", () => {
    expect(
      enrichSearchQuery("who is the current prime minister of india?", [
        "Who is the current prime minister of Canada?",
      ])
    ).toBe("who is the current prime minister of india?");
    expect(enrichSearchQuery("what is the capital of france?", [])).toBe(
      "what is the capital of france?"
    );
  });

  it("ignores unrelated prior turns", () => {
    expect(
      enrichSearchQuery("who is the current prime minister?", [
        "What is 2+2?",
        "What day is it?",
      ])
    ).toBe("who is the current prime minister?");
  });
});

describe("extractIncumbentName", () => {
  it("reads the first wikilink in the infobox incumbent line", () => {
    expect(
      extractIncumbentName("{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}")
    ).toBe("Narendra Modi");
    expect(
      extractIncumbentName("| incumbent = [[Narendra Modi]]\n| since = 26 May 2014")
    ).toBe("Narendra Modi");
  });

  it("falls back to the plain text value", () => {
    expect(extractIncumbentName("| incumbent = Vacant\n")).toBe("Vacant");
  });

  it("returns null when absent or unusable", () => {
    expect(extractIncumbentName("| office = Prime Minister\n")).toBeNull();
    expect(extractIncumbentName("| incumbent = [[File:logo.png]]\n")).toBeNull();
  });
});

describe("extractCapitalName", () => {
  it("reads the infobox capital field", () => {
    expect(
      extractCapitalName("{{Infobox country\n| capital = [[Paris]]\n| largest_city = Paris\n}}")
    ).toBe("Paris");
    expect(extractCapitalName("| capital = [[Canberra]]\n")).toBe("Canberra");
  });

  it("returns null when absent", () => {
    expect(extractCapitalName("| capital_type = City\n")).toBeNull();
  });
});

describe("officeNounOf", () => {
  it("extracts the core office noun of rank-qualified questions", () => {
    expect(officeNounOf("Who is the first Sikh Prime Minister of India?")).toBe("minister");
    expect(officeNounOf("Who was the last president of the United States?")).toBe("president");
    expect(officeNounOf("Who was the first sikh prime minister of india?")).toBe("minister");
  });

  it("returns null for questions that are not rank-qualified officeholder questions", () => {
    expect(officeNounOf("Who is the current prime minister of India?")).toBeNull();
    expect(officeNounOf("What is the capital of France?")).toBeNull();
    expect(officeNounOf("Who is Narendra Modi?")).toBeNull();
  });
});

describe("webSearch Wikipedia fallback (mocked)", () => {
  it("answers an officeholder question from the infobox incumbent, not the raw top hit", async () => {
    // Raw MediaWiki order puts "Prime Minister's Office (India)" first — the
    // exact junk the user saw. Our ranking must prefer the office article.
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Prime Minister's Office (India)", "Prime Minister of India", "Narendra Modi"])
    );
    SEARCH_RESPONSES.set(
      "wt:Prime Minister of India",
      "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}"
    );
    const result = await webSearch("who is the current prime minister of india");
    expect(result?.heading).toBe("Prime Minister of India");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of India");
  });

  it("ranks the anchored article above generic capital-city pages and answers from the infobox capital", async () => {
    SEARCH_RESPONSES.set(
      "search:what is the capital of france",
      searchResult(["Closed-ended question", "Capital city", "France", "Capital punishment", "WhatsApp"])
    );
    SEARCH_RESPONSES.set(
      "wt:France",
      "{{Infobox country\n| capital = [[Paris]]\n| largest_city = Paris\n}}"
    );
    const result = await webSearch("what is the capital of france");
    expect(result?.heading).toBe("France");
    expect(result?.answer).toContain("Paris");
    expect(result?.answer).toContain("capital of France");
  });

  it("recovers a typo'd officeholder question via OpenSearch suggestions", async () => {
    // Full-text search is strict: the typo'd question finds nothing.
    SEARCH_RESPONSES.set("search:who is the current prime misnister of india", {
      query: { search: [] },
    });
    SEARCH_RESPONSES.set(
      "open:who is the current prime misnister of india",
      ["q", ["Prime Minister (India)", "Prime ministers of India", "Prime Minister of India House", "Prime Minister of India Office"]]
    );
    // The top suggestion is a redirect — the wikitext fetch resolves it.
    SEARCH_RESPONSES.set(
      "wt:Prime Minister (India)",
      "{{Infobox officeholder\n| incumbent = [[Narendra Modi]]\n}}"
    );
    const result = await webSearch("who is the current prime misnister of india");
    expect(result?.answer).toContain("Narendra Modi");
  });

  it("returns null when nothing is usable", async () => {
    SEARCH_RESPONSES.set("search:zzzzqxyt notreal", { query: { search: [] } });
    SEARCH_RESPONSES.set("open:zzzzqxyt notreal", ["q", []]);
    const result = await webSearch("zzzzqxyt notreal");
    expect(result).toBeNull();
  });

  it("a rank-qualified office question with an irrelevant result returns null (never the current incumbent)", async () => {
    // "Who is the FIRST sikh prime minister of india" must not be answered with
    // whoever holds the office TODAY. The best Wikipedia hit is an unrelated
    // demographics article whose lead never mentions the office — the relevance
    // gate returns null so the caller defers to the reasoning model.
    SEARCH_RESPONSES.set(
      "search:who is the first sikh prime minister of india",
      searchResult(["Sikhism in India"])
    );
    SEARCH_RESPONSES.set(
      "wt:Sikhism in India",
      "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}"
    );
    SEARCH_RESPONSES.set(
      "lead:Sikhism in India",
      "Indian Sikhs number approximately 21 million in the country, making up about 1.7% of the population."
    );
    const result = await webSearch("who is the first sikh prime minister of india");
    expect(result).toBeNull();
  });

  it("a rank-qualified office question KEEPS a result that actually mentions the office", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the 13th prime minister of India and the first Sikh to hold the office."
    );
    const result = await webSearch("who is the first sikh prime minister of india");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("prime minister");
  });

  it("a truncated DuckDuckGo body (JSON parse failure) falls through to Wikipedia instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.duckduckgo.com")) {
          return {
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected end of JSON input");
            },
          };
        }
        if (url.includes("list=search") && !url.includes("opensearch")) {
          return { ok: true, json: async () => ({ query: { search: [] } }) };
        }
        if (url.includes("action=opensearch")) {
          return { ok: true, json: async () => ["q", []] };
        }
        if (url.includes("prop=extracts")) {
          return {
            ok: true,
            json: async () => ({ query: { pages: [{ extract: null }] } }),
          };
        }
        throw new Error(`unmocked url: ${url}`);
      })
    );
    const result = await webSearch("what is react");
    expect(result).toBeNull();
  });

  it("ranks the article for the head noun above a longer, more generic keyword — 'closure' not 'JavaScript'", async () => {
    // The subject of "what is a javascript closure?" is the LAST content
    // keyword. Keyword-length scoring alone would rank the 10-char "javascript"
    // above the 7-char "closure"; the head-noun bonus must pick the answer.
    SEARCH_RESPONSES.set(
      "search:what is a javascript closure",
      searchResult(["JavaScript", "JavaScript syntax", "Closure (computer programming)", "JavaScript engine", "JavaScript library"])
    );
    SEARCH_RESPONSES.set(
      "lead:Closure (computer programming)",
      "In programming languages, a closure is a technique for implementing lexically scoped name binding."
    );
    const result = await webSearch("what is a javascript closure");
    expect(result?.heading).toBe("Closure (computer programming)");
    expect(result?.abstract).toContain("closure");
    expect(result?.abstract).not.toContain("JavaScript (JS) is a programming language");
  });
});
