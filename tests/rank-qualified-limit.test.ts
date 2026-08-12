/**
 * Rank-qualified DISCOVERY-LIMIT regression suite — the exact remaining
 * production bug: searchWikipedia() hard-coded srlimit=5, but live Wikipedia
 * returns Manmohan Singh at ~result #10 for the semantic discovery query
 * "Sikh prime minister India" (behind Sikhism in India, Sikhs, Khalistan
 * movement, 1984 anti-Sikh riots, Insurgency in Punjab, Zail Singh, Parkash
 * Singh Badal, Hardeep Singh Nijjar, Baldev Singh). The validation gate was
 * already correct — the biography was simply never discovered.
 *
 * The fix: searchWikipedia() takes an optional bounded result `limit`
 * (default 5) and rank-qualified discovery requests 10 per semantic query
 * while merging, deduplicating and capping the candidate set at 20. Every
 * other path (generic, officeholder, capital) keeps the default 5.
 *
 * The mock here HONORS srlimit (it slices the hit list to the limit in the
 * URL), so the tests exercise the production limit for real: the Manmohan
 * test with the biography at rank #10 must FAIL under limit 5 and PASS under
 * limit 10.
 *
 * All network calls are mocked — no live requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invalidateSearchCache, webSearch } from "@/lib/toolkit/web";

type Hit = { title: string; snippet: string; pageid: number };

const QUERY_HITS = new Map<string, Hit[]>();
const LEADS = new Map<string, string>();
const REVISIONS = new Map<string, string>();
const SEARCH_CALLS: Array<{ query: string; limit: number }> = [];

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.duckduckgo.com")) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes("list=search") && !url.includes("opensearch")) {
        const limit = parseInt(/srlimit=(\d+)/.exec(url)?.[1] ?? "5", 10);
        const query = decodeURIComponent(/srsearch=([^&]+)/.exec(url)?.[1] ?? "")
          .toLowerCase()
          .replace(/[?!.]+$/, "")
          .trim();
        SEARCH_CALLS.push({ query, limit });
        const hits = QUERY_HITS.get(query) ?? [];
        return { ok: true, json: async () => ({ query: { search: hits.slice(0, limit) } }) };
      }
      if (url.includes("action=opensearch")) {
        return { ok: true, json: async () => ["q", []] };
      }
      if (url.includes("prop=extracts")) {
        const title = decodeURIComponent(/titles=([^&]+)/.exec(url)?.[1] ?? "");
        return {
          ok: true,
          json: async () => ({
            query: { pages: [{ extract: LEADS.get(title) ?? null }] },
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
                    { slots: { main: { content: REVISIONS.get(title) ?? null } } },
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

function hits(titles: string[]): Hit[] {
  return titles.map((title, i) => ({ title, snippet: `<span>${title}</span>`, pageid: 2000 + i }));
}

/**
 * The live Wikipedia top-10 for "Sikh prime minister India" with Manmohan
 * Singh as result #10 — the exact discovery bottleneck this suite protects.
 */
const SIKH_TOP10 = hits([
  "Sikhism in India",
  "Sikhs",
  "Khalistan movement",
  "1984 anti-Sikh riots",
  "Insurgency in Punjab",
  "Zail Singh",
  "Parkash Singh Badal",
  "Hardeep Singh Nijjar",
  "Baldev Singh",
  "Manmohan Singh",
]);

const MANMOHAN_LEAD =
  "Manmohan Singh (26 September 1932 - 26 December 2024) was an Indian politician who served " +
  "as the prime minister of India from 2004 to 2014. He was the first and remains the only " +
  "Sikh prime minister of India.";

/** Words scattered across sentences with no office→place binding — strict gate. */
const SCATTERED_LEAD =
  "Hardeep Singh Nijjar is a Sikh activist. The first communities arrived in India centuries " +
  "ago. He was a prime minister and a respected scholar.";

const INDIA_WIKITEXT = "{{Infobox country\n| capital = [[New Delhi]]\n| largest_city = Mumbai\n}}";
const PM_WIKITEXT =
  "{{Infobox officeholder\n| office = Prime Minister of India\n| incumbent = [[Narendra Modi]]\n}}";
const REACT_LEAD =
  "React is a free and open-source front-end JavaScript library for building user interfaces " +
  "based on components.";

beforeEach(() => {
  QUERY_HITS.clear();
  LEADS.clear();
  REVISIONS.clear();
  SEARCH_CALLS.length = 0;
  invalidateSearchCache();
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rank-qualified discovery limit (Manmohan Singh at result #10)", () => {
  it("English: Manmohan Singh at #10 is discovered with the validated relationship", async () => {
    // Raw question returns the poisoned/unrelated pages; the canonical
    // "sikh prime minister india" query returns Manmohan at rank #10.
    QUERY_HITS.set("who was the first sikh prime minister of india", hits([
      "Sikhism in India",
      "Sikhs",
      "Khalistan movement",
      "1984 anti-Sikh riots",
      "Insurgency in Punjab",
    ]));
    QUERY_HITS.set("sikh prime minister india", SIKH_TOP10);
    LEADS.set("Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).not.toBeNull();
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");

    // The discovery search for the canonical query requested the larger
    // bounded limit — this is the fix.
    const canonical = SEARCH_CALLS.find((c) => c.query === "sikh prime minister india");
    expect(canonical).toBeDefined();
    expect(canonical?.limit).toBe(10);
  });

  it("Hinglish: India ka pehla Sikh Prime Minister kaun tha? discovers the same biography", async () => {
    QUERY_HITS.set("india ka pehla sikh prime minister kaun tha", hits([
      "Sikhism in India",
      "Sikhs",
      "Khalistan movement",
    ]));
    QUERY_HITS.set("sikh prime minister india", SIKH_TOP10);
    LEADS.set("Manmohan Singh", MANMOHAN_LEAD);

    const result = await webSearch("India ka pehla Sikh Prime Minister kaun tha?");
    expect(result).not.toBeNull();
    expect(result?.heading).toBe("Manmohan Singh");
    expect(result?.abstract).toContain("first and remains the only Sikh prime minister of India");

    const canonical = SEARCH_CALLS.find((c) => c.query === "sikh prime minister india");
    expect(canonical?.limit).toBe(10);
  });
});

describe("validation stays strict even with a wider discovery net", () => {
  it("Khalistan movement (title gate) and a scattered-relationship person are both rejected", async () => {
    QUERY_HITS.set("who was the first sikh prime minister of india", hits([
      "Khalistan movement",
      "Hardeep Singh Nijjar",
    ]));
    QUERY_HITS.set("sikh prime minister india", hits(["Khalistan movement"]));
    LEADS.set(
      "Khalistan movement",
      "The Khalistan movement is a separatist movement seeking a homeland for Sikhs in India."
    );
    LEADS.set("Hardeep Singh Nijjar", SCATTERED_LEAD);

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    // Movement page is title-rejected; the person's scattered words never form
    // the required relationship sentence. Honest null.
    expect(result).toBeNull();
  });

  it("a person candidate whose lead binds the office to another country is rejected", async () => {
    QUERY_HITS.set("sikh prime minister india", hits(["Manmohan Singh"]));
    LEADS.set(
      "Manmohan Singh",
      "Manmohan Singh was the first Sikh prime minister of Pakistan, serving from 2004 to 2014."
    );

    const result = await webSearch("Who was the first Sikh Prime Minister of India?");
    expect(result).toBeNull();
  });
});

describe("non-rank-qualified searches keep the default limit of 5", () => {
  it("generic (React), officeholder (PM) and capital (India) all use srlimit=5", async () => {
    QUERY_HITS.set("what is react", hits(["React (JavaScript library)"]));
    LEADS.set("React (JavaScript library)", REACT_LEAD);

    QUERY_HITS.set("who is the current prime minister of india", hits(["Prime Minister of India"]));
    QUERY_HITS.set("prime minister india", hits(["Prime Minister of India"]));
    QUERY_HITS.set("prime minister of india", hits(["Prime Minister of India"]));
    REVISIONS.set("Prime Minister of India", PM_WIKITEXT);

    QUERY_HITS.set("what is the capital of india", hits(["India"]));
    QUERY_HITS.set("india", hits(["India"]));
    REVISIONS.set("India", INDIA_WIKITEXT);

    const react = await webSearch("What is React?");
    expect(react?.heading).toBe("React (JavaScript library)");
    expect(react?.abstract).toContain("user interfaces");

    const pm = await webSearch("Who is the current Prime Minister of India?");
    expect(pm?.answer).toContain("Narendra Modi");

    const capital = await webSearch("What is the capital of India?");
    expect(capital?.answer).toContain("New Delhi");

    // Every search these paths made used the DEFAULT limit — never 10.
    expect(SEARCH_CALLS.length).toBeGreaterThan(0);
    for (const call of SEARCH_CALLS) {
      expect(call.limit).toBe(5);
    }
  });
});
