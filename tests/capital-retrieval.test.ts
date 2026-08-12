/**
 * Capital-retrieval regression suite — the exact production bug:
 * "What is the capital of India?" returned "I couldn't verify that" even
 * though Wikipedia's India article carries `| capital = [[New Delhi]]`.
 *
 * Root cause: every Wikipedia call went out WITHOUT a User-Agent header, and
 * Wikipedia's MediaWiki API answers UA-less requests with HTTP 429, which the
 * fallback swallowed silently into null.
 *
 * The fix locks in:
 * 1. Every outbound request carries a descriptive User-Agent (Wikipedia no
 *    longer 429s the retrieval path).
 * 2. Capital discovery ALWAYS searches the raw question AND the canonical
 *    place article, merges + deduplicates + scores the candidates, prefers
 *    the exact canonical article and reads a BOUNDED number (max 8) of
 *    infoboxes; when search never surfaces the place article it is fetched
 *    directly by title. The answer comes ONLY from the infobox `capital`
 *    field — never "Capital punishment in India", "National Capital Region",
 *    a generic lead or a search snippet.
 * 3. The Hinglish shape ("Bharat ki rajdhani kya hai?") is a capital
 *    question, answered from the canonical place's infobox.
 * 4. Officeholder, rank-qualified and generic (React) behavior is unchanged.
 *
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyKnowledgeQuery,
  extractCapitalName,
  extractInfoboxField,
  invalidateSearchCache,
  searchCache,
  webSearch,
} from "@/lib/toolkit/web";

const SEARCH_RESPONSES = new Map<string, unknown>();

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.duckduckgo.com")) {
        return { ok: true, json: async () => ({}) };
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

function fetchInits(): Array<Record<string, unknown>> {
  const fn = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return (fn.mock.calls as Array<[RequestInfo | URL, unknown]>).map(([, init]) =>
    (init as Record<string, unknown>) ?? {}
  );
}

const INDIA_WIKITEXT = "{{Infobox country\n| capital = [[New Delhi]]\n| largest_city = Mumbai\n}}";
const US_WIKITEXT =
  "{{Infobox country\n| capital = [[Washington, D.C.]]\n| largest_city = New York City\n}}";
const UK_WIKITEXT = "{{Infobox country\n| capital = [[London]]\n| largest_city = London\n}}";
const JAPAN_WIKITEXT = "{{Infobox country\n| capital = [[Tokyo]]\n| largest_city = Tokyo\n}}";

beforeEach(() => {
  SEARCH_RESPONSES.clear();
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("root cause: outbound requests carry a User-Agent (Wikipedia 429)", () => {
  it("sends a descriptive User-Agent header on the Wikipedia search", async () => {
    SEARCH_RESPONSES.set("search:what is the capital of india", searchResult(["India"]));
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.answer).toContain("New Delhi");
    const uas = fetchInits()
      .map((init) => (init.headers as Record<string, unknown> | undefined)?.["User-Agent"])
      .filter((ua) => typeof ua === "string" && ua.length > 0);
    expect(uas.length).toBeGreaterThan(0);
    expect(uas[0]).toContain("JarvisAI");
  });
});

describe("capital extraction (existing generic helpers)", () => {
  it("extracts New Delhi from the wiki-link form", () => {
    expect(extractCapitalName("{{Infobox country\n| capital = [[New Delhi]]\n| largest_city = Mumbai\n}}")).toBe(
      "New Delhi"
    );
  });

  it("extracts plain-text, disambiguated and bracket forms", () => {
    expect(extractCapitalName("| capital = New Delhi\n")).toBe("New Delhi");
    expect(extractCapitalName("| capital = [[Washington, D.C.]]\n")).toBe("Washington, D.C.");
    expect(extractCapitalName("| capital = [[Tokyo]]\n")).toBe("Tokyo");
    expect(extractInfoboxField("| capital = [[London]], England\n", "capital")).toBe("London");
  });

  it("does not match unrelated fields like capital_type", () => {
    expect(extractCapitalName("| capital_type = City\n")).toBeNull();
  });
});

describe("capital questions (English and Hinglish)", () => {
  it("1. What is the capital of India? -> New Delhi", async () => {
    SEARCH_RESPONSES.set(
      "search:what is the capital of india",
      searchResult(["Capital punishment in India", "India", "National Capital Region"])
    );
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.heading).toBe("India");
    expect(result?.answer).toContain("The capital of India is New Delhi (per Wikipedia).");
  });

  it("2. Bharat ki rajdhani kya hai? -> New Delhi", async () => {
    expect(classifyKnowledgeQuery("Bharat ki rajdhani kya hai?").kind).toBe("capital");
    expect(classifyKnowledgeQuery("Bharat ki rajdhani kya hai?").canonicalPlace).toBe("India");
    SEARCH_RESPONSES.set("search:bharat ki rajdhani kya hai", searchResult(["India"]));
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("Bharat ki rajdhani kya hai?");
    expect(result?.heading).toBe("India");
    expect(result?.answer).toContain("The capital of India is New Delhi (per Wikipedia).");
  });

  it("3. What is the capital of USA? -> Washington, D.C.", async () => {
    SEARCH_RESPONSES.set("search:what is the capital of usa", searchResult(["Usa"]));
    SEARCH_RESPONSES.set("search:United States", searchResult(["United States"]));
    SEARCH_RESPONSES.set("wt:United States", US_WIKITEXT);
    const result = await webSearch("What is the capital of USA?");
    expect(result?.heading).toBe("United States");
    expect(result?.answer).toContain("Washington, D.C.");
    expect(result?.answer).toContain("the United States");
    expect(result?.answer).not.toContain("Usa");
  });

  it("4. What is the capital of the United Kingdom? -> London", async () => {
    SEARCH_RESPONSES.set(
      "search:what is the capital of the united kingdom",
      searchResult(["United Kingdom"])
    );
    SEARCH_RESPONSES.set("wt:United Kingdom", UK_WIKITEXT);
    const result = await webSearch("What is the capital of the United Kingdom?");
    expect(result?.heading).toBe("United Kingdom");
    expect(result?.answer).toContain("London");
    expect(result?.answer).toContain("the United Kingdom");
  });

  it("5. What is the capital of Japan? -> Tokyo", async () => {
    SEARCH_RESPONSES.set("search:what is the capital of japan", searchResult(["Japan"]));
    SEARCH_RESPONSES.set("wt:Japan", JAPAN_WIKITEXT);
    const result = await webSearch("What is the capital of Japan?");
    expect(result?.heading).toBe("Japan");
    expect(result?.answer).toContain("Tokyo");
  });

  it("6. correct article is NOT in the first 4 initial results — canonical place search still discovers it", async () => {
    // The raw-query hits (all 5 of them) never include "India"; only the
    // dedicated canonical-place search surfaces it.
    SEARCH_RESPONSES.set(
      "search:what is the capital of india",
      searchResult(["Delhi", "Capital punishment in India", "New Delhi", "Chennai", "Mumbai"])
    );
    SEARCH_RESPONSES.set("search:india", searchResult(["India"]));
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.heading).toBe("India");
    expect(result?.answer).toContain("New Delhi");
  });

  it("3b. canonical place search returns nothing — the direct canonical article lookup still answers", async () => {
    // Neither the raw question nor the canonical-place search returns the
    // article; the direct fetch of the canonical title ("India") resolves it.
    SEARCH_RESPONSES.set(
      "search:what is the capital of india",
      searchResult(["Capital punishment in India", "National Capital Region"])
    );
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.heading).toBe("India");
    expect(result?.answer).toContain("New Delhi");
  });

  it("7. unrelated initial hits (Capital punishment / National Capital Region) never become the answer", async () => {
    // Even when an unrelated hit carries its own `capital`-style field, the
    // canonical place article must win.
    SEARCH_RESPONSES.set(
      "search:what is the capital of india",
      searchResult(["Capital punishment in India", "National Capital Region"])
    );
    SEARCH_RESPONSES.set("search:india", searchResult(["India"]));
    SEARCH_RESPONSES.set(
      "wt:Capital punishment in India",
      "{{Infobox criminal law\n| capital = false\n}}"
    );
    SEARCH_RESPONSES.set(
      "wt:National Capital Region",
      "{{Infobox settlement\n| capital = Delhi\n}}"
    );
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const result = await webSearch("What is the capital of India?");
    expect(result?.heading).toBe("India");
    expect(result?.answer).toContain("New Delhi");
    expect(result?.answer).not.toContain("punishment");
    expect(result?.answer).not.toContain("National Capital");
  });

  it("9. no valid capital field anywhere -> null (honest verification failure)", async () => {
    SEARCH_RESPONSES.set("search:what is the capital of atlantis", searchResult(["Atlantis"]));
    SEARCH_RESPONSES.set("wt:Atlantis", "{{Infobox country\n| largest_city = Atlantis City\n}}");
    const result = await webSearch("What is the capital of Atlantis?");
    expect(result).toBeNull();
    // null is never cached.
    expect(searchCache.has("what is the capital of atlantis")).toBe(false);
  });

  it("the cache stores and serves a validated capital answer (cachedResultValidFor passes)", async () => {
    SEARCH_RESPONSES.set("search:what is the capital of india", searchResult(["India"]));
    SEARCH_RESPONSES.set("wt:India", INDIA_WIKITEXT);
    const first = await webSearch("What is the capital of India?");
    expect(first?.answer).toContain("New Delhi");
    expect(searchCache.get("what is the capital of india?")?.value.answer).toContain("New Delhi");
    const second = await webSearch("What is the capital of India?");
    expect(second?.answer).toContain("New Delhi");
  });
});

describe("non-capital paths are unchanged", () => {
  it("10. generic: What is React? (unchanged)", async () => {
    expect(classifyKnowledgeQuery("What is React?").kind).toBe("generic");
    SEARCH_RESPONSES.set("search:what is react", searchResult(["React (JavaScript library)"]));
    SEARCH_RESPONSES.set(
      "lead:React (JavaScript library)",
      "React is a free and open-source front-end JavaScript library for building user interfaces."
    );
    const result = await webSearch("What is React?");
    expect(result?.engine).toBe("Wikipedia");
    expect(result?.heading).toBe("React (JavaScript library)");
    expect(result?.abstract).toContain("user interfaces");
  });

  it("11. officeholder: Who is the current Prime Minister of India? (unchanged)", async () => {
    expect(classifyKnowledgeQuery("Who is the current Prime Minister of India?").kind).toBe(
      "officeholder"
    );
    SEARCH_RESPONSES.set(
      "search:who is the current prime minister of india",
      searchResult(["Prime Minister of India"])
    );
    SEARCH_RESPONSES.set(
      "wt:Prime Minister of India",
      "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}"
    );
    const result = await webSearch("Who is the current Prime Minister of India?");
    expect(result?.answer).toContain("Narendra Modi");
  });

  it("12. rank-qualified: Who was the first Sikh Prime Minister of India? (unchanged)", async () => {
    expect(classifyKnowledgeQuery("Who was the first Sikh Prime Minister of India?").kind).toBe(
      "rank-qualified"
    );
    SEARCH_RESPONSES.set(
      "search:who was the first sikh prime minister of india",
      searchResult(["Manmohan Singh"])
    );
    SEARCH_RESPONSES.set(
      "lead:Manmohan Singh",
      "Manmohan Singh was the 13th prime minister of India and the first Sikh to hold the office."
    );
    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first Sikh");
  });
});
