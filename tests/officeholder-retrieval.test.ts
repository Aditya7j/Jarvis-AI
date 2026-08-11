/**
 * Officeholder retrieval-validation suite — regression tests for the
 * production bug where "India ka pradhan mantri kaun hai?" answered with
 * "Palak Muchhal Sharma ..." because an arbitrary Wikipedia search hit won
 * the fallback when hits.length > 0.
 *
 * Locked invariants:
 * 1. officeholder -> incumbent extraction only. Never an article lead, a
 *    generic abstract, a RelatedTopics text, an arbitrary search result or an
 *    LLM guess.
 * 2. An officeholder candidate is only read after isOfficeholderCandidate
 *    proves it represents the requested office + place ("Prime Minister of
 *    India"), and unvalidated candidates are never used merely because the
 *    search returned hits.
 * 3. No incumbent from a validated candidate -> null (honest unavailable),
 *    never a generic Wikipedia answer.
 * 4. Hinglish and English officeholder questions follow the SAME verified path.
 * 5. Historical/rank-qualified questions ("kaun tha", "who WAS the first ...")
 *    never become current-officeholder answers.
 * 6. The generic knowledge path ("What is React?") is unchanged.
 *
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyKnowledgeQuery,
  findValidatedOfficeholderArticle,
  invalidateSearchCache,
  isOfficeholderCandidate,
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

const INDIA_WIKITEXT =
  "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}";
const USA_WIKITEXT =
  "{{Infobox officeholder\n| office = President of the United States\n| incumbent = [[Joe Biden]]\n}}";
const UK_WIKITEXT =
  "{{Infobox officeholder\n| office = Prime Minister of the United Kingdom\n| incumbent = [[Keir Starmer]]\n}}";
const JAPAN_WIKITEXT =
  "{{Infobox officeholder\n| office = Prime Minister of Japan\n| incumbent = [[Shigeru Ishiba]]\n}}";

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  ddgPayload = {};
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isOfficeholderCandidate", () => {
  it("validates the canonical office-of-place title", () => {
    expect(isOfficeholderCandidate("Prime Minister of India", "prime minister", "india", null)).toBe(true);
    expect(
      isOfficeholderCandidate("President of the United States", "president", "the united states", "United States")
    ).toBe(true);
    expect(
      isOfficeholderCandidate("Prime Minister of the United Kingdom", "prime minister", "the united kingdom", "United Kingdom")
    ).toBe(true);
    expect(isOfficeholderCandidate("Prime Minister of Japan", "prime minister", "japan", null)).toBe(true);
  });

  it("matches the canonical alias when the user used an alias place", () => {
    expect(isOfficeholderCandidate("Prime Minister of India", "prime minister", "bharat", "India")).toBe(true);
    expect(isOfficeholderCandidate("President of the United States", "president", "america", "United States")).toBe(true);
  });

  it("REJECTS an arbitrary person page", () => {
    expect(isOfficeholderCandidate("Palak Muchhal Sharma", "prime minister", "india", null)).toBe(false);
    expect(isOfficeholderCandidate("Narendra Modi", "prime minister", "india", null)).toBe(false);
  });

  it("rejects list, disambiguation and administrative-body pages", () => {
    expect(isOfficeholderCandidate("List of prime ministers of India", "prime minister", "india", null)).toBe(false);
    expect(isOfficeholderCandidate("Prime Minister of India (disambiguation)", "prime minister", "india", null)).toBe(false);
    expect(isOfficeholderCandidate("Prime Minister's Office (India)", "prime minister", "india", null)).toBe(false);
  });

  it("rejects a different office that shares a noun", () => {
    expect(isOfficeholderCandidate("Deputy Prime Minister of India", "prime minister", "india", null)).toBe(false);
  });
});

describe("findValidatedOfficeholderArticle", () => {
  it("returns the incumbent of the validated canonical article, ignoring poisoned hits", async () => {
    // The raw question search returns junk; the canonical "office + place"
    // search returns the real article. Only the validated article is read.
    SEARCH_RESPONSES.set(
      "search:India ka pradhan mantri kaun hai",
      searchResult(["Palak Muchhal Sharma", "Songs of India", "Indian playback singers"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("lead:Palak Muchhal Sharma", "Palak Muchhal Sharma is an Indian playback singer and songwriter.");
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);

    const article = await findValidatedOfficeholderArticle(
      "India ka pradhan mantri kaun hai",
      "prime minister",
      "india",
      null,
      8_000
    );
    expect(article?.title).toBe("Prime Minister of India");
    expect(article?.incumbent).toBe("Narendra Modi");
  });

  it("returns null when every candidate is unrelated — never a random person", async () => {
    SEARCH_RESPONSES.set(
      "search:India ka pradhan mantri kaun hai",
      searchResult(["Palak Muchhal Sharma", "Songs of India"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Songs of India"]));
    const article = await findValidatedOfficeholderArticle(
      "India ka pradhan mantri kaun hai",
      "prime minister",
      "india",
      null,
      8_000
    );
    expect(article).toBeNull();
  });
});

describe("production regression: Hinglish officeholder", () => {
  it("answers Narendra Modi when the raw search is poisoned and the canonical search has the article", async () => {
    // Exact reproduction of the reported bug: the initial Wikipedia search on
    // the raw Hinglish question returns Palak Muchhal Sharma + unrelated hits
    // (hits.length > 0). The old code used the top irrelevant hit, found no
    // incumbent and fell through to its generic lead ("Palak Muchhal Sharma —
    // an Indian playback singer..."). The fix must reject it, run the canonical
    // office + place search and answer from the validated article's incumbent.
    SEARCH_RESPONSES.set(
      "search:India ka pradhan mantri kaun hai",
      searchResult(["Palak Muchhal Sharma", "Songs of India", "Indian playback singers"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("lead:Palak Muchhal Sharma", "Palak Muchhal Sharma is an Indian playback singer and songwriter.");
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);

    const result = await webSearch("India ka pradhan mantri kaun hai");
    expect(result).not.toBeNull();
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("Prime Minister of India");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of India");
    expect(result?.abstract).toBeNull();
    expect(result?.answer).not.toContain("Palak");
    expect(result?.answer).not.toContain("playback singer");
  });

  it("returns null when only unrelated results exist — never Palak Muchhal", async () => {
    SEARCH_RESPONSES.set(
      "search:India ka pradhan mantri kaun hai",
      searchResult(["Palak Muchhal Sharma", "Songs of India", "Indian playback singers"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Songs of India"]));
    SEARCH_RESPONSES.set("lead:Palak Muchhal Sharma", "Palak Muchhal Sharma is an Indian playback singer and songwriter.");
    SEARCH_RESPONSES.set("wt:Palak Muchhal Sharma", "{{Infobox person\n| occupation = Singer\n}}");

    const result = await webSearch("India ka pradhan mantri kaun hai");
    expect(result).toBeNull();
  });

  it("skips DuckDuckGo for officeholder queries", async () => {
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("India ka pradhan mantri kaun hai");
    expect(result?.answer).toContain("Narendra Modi");
    const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect((fn.mock.calls as Array<[RequestInfo | URL]>).some(([u]) => String(u).includes("api.duckduckgo.com"))).toBe(false);
  });
});

describe("English officeholder", () => {
  it("answers from the validated article's incumbent despite poisoned raw hits", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Palak Muchhal Sharma", "Prime Minister of India", "Songs of India"])
    );
    SEARCH_RESPONSES.set("lead:Palak Muchhal Sharma", "Palak Muchhal Sharma is an Indian playback singer and songwriter.");
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("Who is the current Prime Minister of India?");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).not.toContain("Palak");
  });

  it("returns null when only unrelated results exist", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Palak Muchhal Sharma", "Songs of India"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Songs of India"]));
    const result = await webSearch("Who is the current Prime Minister of India?");
    expect(result).toBeNull();
  });

  it("skips DuckDuckGo entirely for English officeholder questions", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("Who is the current Prime Minister of India?");
    expect(result?.answer).toContain("Narendra Modi");
    const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect((fn.mock.calls as Array<[RequestInfo | URL]>).some(([u]) => String(u).includes("api.duckduckgo.com"))).toBe(false);
  });
});

describe("Hinglish and English share the same verified path", () => {
  it.each([
    ["India ka pradhan mantri kaun hai?", "prime minister india", "Narendra Modi"],
    ["India ke pradhan mantri kaun hain?", "prime minister india", "Narendra Modi"],
    ["India ke PM kaun hain?", "prime minister india", "Narendra Modi"],
    ["India ka PM kaun hai?", "prime minister india", "Narendra Modi"],
    ["Who is the current Prime Minister of India?", "prime minister india", "Narendra Modi"],
  ])("answers %s with the same incumbent", async (q, canonicalQuery, incumbent) => {
    SEARCH_RESPONSES.set(`search:${canonicalQuery}`, searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch(q);
    expect(result?.answer).toContain(incumbent);
  });

  it("Bharat canonicalizes to India for the same verified path", async () => {
    SEARCH_RESPONSES.set("search:prime minister India", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("Bharat ke pradhan mantri kaun hain?");
    expect(result?.heading).toBe("Prime Minister of India");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of Bharat");
  });

  it("Bharat ka PM kaun hai uses the canonical India alias", async () => {
    SEARCH_RESPONSES.set("search:prime minister India", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("Bharat ka PM kaun hai?");
    expect(result?.answer).toContain("Narendra Modi");
  });
});

describe("officeholder retrieval across places", () => {
  it.each([
    [
      "Who is the current President of the United States?",
      "president United States",
      "President of the United States",
      USA_WIKITEXT,
      "Joe Biden",
      "the United States",
    ],
    [
      "Who is the current Prime Minister of the United Kingdom?",
      "prime minister United Kingdom",
      "Prime Minister of the United Kingdom",
      UK_WIKITEXT,
      "Keir Starmer",
      "the United Kingdom",
    ],
    [
      "Who is the current Prime Minister of Japan?",
      "prime minister Japan",
      "Prime Minister of Japan",
      JAPAN_WIKITEXT,
      "Shigeru Ishiba",
      "Japan",
    ],
  ])("answers %s from the validated article", async (q, canonicalQuery, title, wt, incumbent, placeDisplay) => {
    SEARCH_RESPONSES.set(`search:${canonicalQuery}`, searchResult([title]));
    SEARCH_RESPONSES.set(`wt:${title}`, wt);
    const result = await webSearch(q);
    expect(result?.heading).toBe(title);
    expect(result?.answer).toContain(incumbent);
    expect(result?.answer).toContain(placeDisplay);
  });
});

describe("historical/rank-qualified semantics are preserved", () => {
  it("keeps 'kaun tha' generic — never the current officeholder", () => {
    expect(classifyKnowledgeQuery("India ka pradhan mantri kaun tha?").kind).toBe("generic");
  });

  it("a rank-qualified question is never answered with the current incumbent", async () => {
    // Only the office article (with the CURRENT incumbent) is available. The
    // rank-qualified path must not use it: it lacks rank + qualifiers, so the
    // honest result is null — never "Narendra Modi is the current ...".
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set(
      "lead:Prime Minister of India",
      "The Prime Minister of India is the head of government of India."
    );
    const result = await webSearch("Who was the first Sikh prime minister of India?");
    expect(result).toBeNull();
  });

  it("classifies 'who was the first ...' as rank-qualified, not officeholder", () => {
    expect(classifyKnowledgeQuery("Who was the first Sikh prime minister of India?").kind).toBe("rank-qualified");
  });
});

describe("generic knowledge path is unchanged", () => {
  it("answers a generic definition through the generic path", async () => {
    expect(classifyKnowledgeQuery("What is React?").kind).toBe("generic");
    SEARCH_RESPONSES.set("search:what is react", searchResult(["React (JavaScript library)"]));
    SEARCH_RESPONSES.set(
      "lead:React (JavaScript library)",
      "React is a free and open-source front-end JavaScript library for building user interfaces."
    );
    const result = await webSearch("What is React?");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.abstract).toContain("React");
    expect(result?.abstract).toContain("user interfaces");
  });
});
