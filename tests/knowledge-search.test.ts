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
});
