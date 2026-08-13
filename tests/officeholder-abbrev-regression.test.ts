/**
 * English office abbreviation regression suite — "PM"/"CM" questions.
 *
 * Production bug: "who is the current PM of India?" answered with the lead of
 * the "Chief minister (India)" article ("In India, a chief minister is the
 * elected head of government of each state out of the 28 states ...") instead
 * of naming the current Prime Minister.
 *
 * Root cause (not a validator weakness): parseOfficeQuestion rejected the
 * 2-letter office label "PM" before expansion, so the query never entered the
 * officeholder path (classified generic). The generic path's office scorer then
 * ranked "Chief minister (India)" (16.78) one hundredth of a point above
 * "Prime Minister of India" (16.77) — a title-length penalty tie-break — and
 * served the lead of the WRONG article. The Hinglish parser expanded "PM"
 * before ITS length guard, so "India ka PM kaun hai?" worked while the English
 * "PM" form did not — a language asymmetry.
 *
 * Locked invariants:
 * 1. English abbreviated office questions ("PM", "CM") route to the SAME
 *    officeholder infobox path as their full-word and Hinglish forms.
 * 2. A state-level article ("Chief minister (India)") that outranks or sits
 *    alongside the correct national article is REJECTED by the validator — the
 *    PM article is chosen, or the pipeline fails honestly; never the CM article.
 * 3. The reverse: a CM question never accepts a state-generic India article.
 * 4. A stale generic cache entry for an officeholder query is revalidated,
 *    evicted and re-answered from the infobox — never served.
 * 5. Full-word and Hinglish officeholder behavior is unchanged.
 *
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyKnowledgeQuery,
  invalidateSearchCache,
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

const INDIA_WIKITEXT =
  "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}";
const BIHAR_WIKITEXT =
  "{{Infobox officeholder\n| office = Chief Minister of Bihar\n| incumbent = [[Nitish Kumar]]\n}}";
// The exact generic lead the reported bug served for the "current PM of India"
// question — reused as the poison candidate and as the stale cache payload.
const CHIEF_MINISTER_INDIA_LEAD =
  "In India, a chief minister is the elected head of government of each state out of the 28 states and sometimes a union territory (UT).";

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  ddgPayload = {};
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classification: abbreviated office questions route to officeholder", () => {
  it("classifies 'Who is the current PM of India?' as officeholder with the expanded office", () => {
    const cls = classifyKnowledgeQuery("Who is the current PM of India?");
    expect(cls.kind).toBe("officeholder");
    expect(cls.office).toBe("prime minister");
    expect(cls.place).toBe("india");
  });

  it("classifies 'Who is the current CM of Bihar?' as officeholder with the expanded office", () => {
    const cls = classifyKnowledgeQuery("Who is the current CM of Bihar?");
    expect(cls.kind).toBe("officeholder");
    expect(cls.office).toBe("chief minister");
    expect(cls.place).toBe("bihar");
  });

  it("classifies the lower-case abbreviation too", () => {
    expect(classifyKnowledgeQuery("who is the current pm of india?").kind).toBe("officeholder");
    expect(classifyKnowledgeQuery("who is the current cm of bihar?").kind).toBe("officeholder");
  });
});

describe("PM of India — abbreviated, poisoned candidate list", () => {
  it("answers the incumbent, rejecting the Chief minister (India) article that outranks the correct one", async () => {
    // The raw-question search returns the CM state-level article FIRST, the
    // correct national PM article second, plus a list page — the exact hazard
    // where a generic scorer picks "Chief minister (India)". Only the PM
    // article may be read for its incumbent.
    SEARCH_RESPONSES.set(
      "search:who is the current pm of india",
      searchResult(["Chief minister (India)", "Prime Minister of India", "List of prime ministers of India"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("search:prime minister of india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("lead:Chief minister (India)", CHIEF_MINISTER_INDIA_LEAD);
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);

    const result = await webSearch("Who is the current PM of India?");
    expect(result).not.toBeNull();
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("Prime Minister of India");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of India");
    expect(result?.abstract).toBeNull();
    expect(result?.answer).not.toContain("chief minister");
    expect(result?.answer).not.toContain("elected head of government of each state");
  });

  it("fails honestly when only the Chief minister (India) article exists — never its lead", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current pm of india",
      searchResult(["Chief minister (India)", "Songs of India"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Chief minister (India)"]));
    SEARCH_RESPONSES.set("search:prime minister of india", searchResult(["Chief minister (India)"]));
    SEARCH_RESPONSES.set("lead:Chief minister (India)", CHIEF_MINISTER_INDIA_LEAD);

    const result = await webSearch("Who is the current PM of India?");
    expect(result).toBeNull();
  });
});

describe("CM of Bihar — abbreviated, poison in the reverse direction", () => {
  it("answers the Bihar incumbent, rejecting the state-generic Chief minister (India) article", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current cm of bihar",
      searchResult(["Chief minister (India)", "Chief Minister of Bihar"])
    );
    SEARCH_RESPONSES.set("search:chief minister bihar", searchResult(["Chief Minister of Bihar"]));
    SEARCH_RESPONSES.set("search:chief minister of bihar", searchResult(["Chief Minister of Bihar"]));
    SEARCH_RESPONSES.set("lead:Chief minister (India)", CHIEF_MINISTER_INDIA_LEAD);
    SEARCH_RESPONSES.set("wt:Chief Minister of Bihar", BIHAR_WIKITEXT);

    const result = await webSearch("Who is the current CM of Bihar?");
    expect(result).not.toBeNull();
    expect(result?.heading).toBe("Chief Minister of Bihar");
    expect(result?.answer).toContain("Nitish Kumar");
    expect(result?.answer).toContain("Chief Minister of Bihar");
    expect(result?.abstract).toBeNull();
    expect(result?.answer).not.toContain("elected head of government of each state");
  });
});

describe("cache revalidation for abbreviated officeholder queries", () => {
  it("evicts a stale generic entry and re-answers from the infobox", async () => {
    // Simulate the historical state that created the bug: under the old
    // (generic) classification the query was cached with the Chief minister
    // (India) lead. The SAME query must now reclassify as officeholder, fail
    // the officeholder cache gate (no infobox answer), be evicted and be
    // answered fresh from the validated article.
    const staleGeneric: Awaited<ReturnType<typeof webSearch>> = {
      query: "Who is the current PM of India?",
      heading: "Chief minister (India)",
      abstract: `Chief minister (India) — ${CHIEF_MINISTER_INDIA_LEAD}`,
      answer: null,
      source: "Wikipedia",
      url: "https://en.wikipedia.org/wiki/Chief_minister_(India)",
      topics: [],
      engine: "Wikipedia",
    };
    searchCache.set("who is the current pm of india", { value: staleGeneric!, at: Date.now() });

    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("search:prime minister of india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("lead:Chief minister (India)", CHIEF_MINISTER_INDIA_LEAD);
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);

    const result = await webSearch("Who is the current PM of India?");
    expect(result?.answer).toContain("Narendra Modi");
    expect(result?.answer).toContain("Prime Minister of India");
    expect(result?.answer).not.toContain("chief minister");
    expect(result?.abstract).toBeNull();
  });
});

describe("non-regression — full-word and Hinglish officeholder behavior is unchanged", () => {
  it("full-word English still answers from the validated article", async () => {
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("Who is the current Prime Minister of India?");
    expect(result?.answer).toContain("Narendra Modi");
  });

  it("Hinglish 'India ka PM kaun hai?' still answers", async () => {
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("India ka PM kaun hai?");
    expect(result?.answer).toContain("Narendra Modi");
  });

  it("skips DuckDuckGo for the abbreviated English form, like full-word forms", async () => {
    SEARCH_RESPONSES.set("search:prime minister india", searchResult(["Prime Minister of India"]));
    SEARCH_RESPONSES.set("wt:Prime Minister of India", INDIA_WIKITEXT);
    const result = await webSearch("Who is the current PM of India?");
    expect(result?.answer).toContain("Narendra Modi");
    const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect((fn.mock.calls as Array<[RequestInfo | URL]>).some(([u]) => String(u).includes("api.duckduckgo.com"))).toBe(false);
  });

  it("generic questions are unaffected", () => {
    expect(classifyKnowledgeQuery("What is React?").kind).toBe("generic");
    expect(classifyKnowledgeQuery("Who is this?").kind).toBe("generic");
  });
});
