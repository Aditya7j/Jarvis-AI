/**
 * Direct unit suite for the shared query-normalization layer
 * (src/lib/toolkit/query-normalize.ts). Imports ONLY from that module — no
 * web toolkit, no network — proving the parsers and vocabularies the web
 * toolkit and the planner consume are self-contained and independently
 * testable. The web toolkit re-exports the same symbols, so these assertions
 * also pin the behavior the integration suites exercise through web.ts.
 */

import { describe, expect, it } from "vitest";

import {
  FACT_LOOKUP_TERMS,
  HINGLISH_PARTICLES,
  anchorOf,
  canonicalPlaceOf,
  classifyKnowledgeQuery,
  displayTitle,
  enrichSearchQuery,
  escapeRegExp,
  levenshtein,
  normalizeCurrency,
  normalizeQueryText,
  officeLabelOf,
  parseCapitalQuestion,
  parseCurrencyRequest,
  parseHinglishCapitalQuestion,
  parseHinglishOfficeholderOffice,
  parseHinglishRankQualifiedOffice,
  parseMapsRequest,
  parseOfficeQuestion,
  parseRankQualifiedOffice,
  properNounsOf,
  queryKeywords,
  titleCase,
  tokenInTitle,
  tokenizeWords,
} from "@/lib/toolkit/query-normalize";

describe("normalizeQueryText", () => {
  it("lowercases, collapses whitespace and trims", () => {
    expect(normalizeQueryText("  Who   Is   the PM? ")).toBe("who is the pm?");
    expect(normalizeQueryText("India\n\tka pradhan mantri")).toBe("india ka pradhan mantri");
  });
});

describe("tokenizeWords", () => {
  it("splits on non-alphanumeric runs", () => {
    expect(tokenizeWords("Who is PM of India?")).toEqual(["who", "is", "pm", "of", "india"]);
  });
});

describe("queryKeywords", () => {
  it("extracts content keywords, dropping stopwords and duplicates", () => {
    expect(queryKeywords("who is the current prime minister of india")).toEqual([
      "prime",
      "minister",
      "india",
    ]);
  });
});

describe("currency parsing", () => {
  it("normalizes currency tokens", () => {
    expect(normalizeCurrency("USD")).toBe("USD");
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency("euros")).toBe("EUR");
    expect(normalizeCurrency("rupees")).toBe("INR");
    expect(normalizeCurrency("₹")).toBe("INR");
    expect(normalizeCurrency("xyz")).toBe("XYZ");
    expect(normalizeCurrency("")).toBeNull();
  });

  it("parses amount + from + to requests", () => {
    expect(parseCurrencyRequest("100 usd to inr")).toEqual({ amount: 100, from: "usd", to: "inr" });
    expect(parseCurrencyRequest("convert 50 euros into yen")).toEqual({
      amount: 50,
      from: "euros",
      to: "yen",
    });
    expect(parseCurrencyRequest("what is 1,000 usd in eur")).toEqual({
      amount: 1000,
      from: "usd",
      to: "eur",
    });
  });

  it("rejects non-currency requests", () => {
    expect(parseCurrencyRequest("what is the capital of France?")).toBeNull();
    expect(parseCurrencyRequest("who is the prime minister?")).toBeNull();
  });
});

describe("officeholder parsing", () => {
  it("parses officeholder questions", () => {
    expect(parseOfficeQuestion("Who is the current prime minister of India?")).toEqual({
      office: "prime minister",
      place: "india",
    });
    expect(parseOfficeQuestion("Who is the current prime minister of the united states?")).toEqual({
      office: "prime minister",
      place: "the united states",
    });
    expect(parseOfficeQuestion("Who is the current PM of India?")).toEqual({
      office: "prime minister",
      place: "india",
    });
  });

  it("rejects non-officeholder questions", () => {
    expect(parseOfficeQuestion("What is the capital of France?")).toBeNull();
    expect(parseOfficeQuestion("Who is Narendra Modi?")).toBeNull();
    expect(parseOfficeQuestion("Who is this?")).toBeNull();
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

describe("canonicalPlaceOf", () => {
  it("maps aliases to canonical article titles", () => {
    expect(canonicalPlaceOf("usa")).toBe("United States");
    expect(canonicalPlaceOf("US")).toBe("United States");
    expect(canonicalPlaceOf("the united kingdom")).toBe("United Kingdom");
    expect(canonicalPlaceOf("bharat")).toBe("India");
  });

  it("returns null when no normalization is needed", () => {
    expect(canonicalPlaceOf("france")).toBeNull();
    expect(canonicalPlaceOf("")).toBeNull();
  });
});

describe("rank-qualified parsing", () => {
  it("extracts rank, office, noun, qualifiers and place", () => {
    const parsed = parseRankQualifiedOffice("Who is the first Sikh prime minister of India?");
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe("sikh prime minister");
    expect(parsed?.officeNoun).toBe("minister");
    expect(parsed?.qualifiers).toEqual(["sikh", "prime"]);
    expect(parsed?.place).toBe("india");
  });

  it("returns null for non-rank-qualified questions", () => {
    expect(parseRankQualifiedOffice("Who is the current prime minister of India?")).toBeNull();
    expect(parseRankQualifiedOffice("What is the capital of France?")).toBeNull();
    expect(parseRankQualifiedOffice("what is 15 * 3?")).toBeNull();
  });
});

describe("parseHinglishRankQualifiedOffice", () => {
  it("parses 'India ka pehla Sikh Prime Minister kaun tha?' into English parts", () => {
    const parsed = parseHinglishRankQualifiedOffice("India ka pehla Sikh Prime Minister kaun tha?");
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe("sikh prime minister");
    expect(parsed?.officeNoun).toBe("minister");
    expect(parsed?.qualifiers).toEqual(["sikh", "prime"]);
    expect(parsed?.place).toBe("india");
  });

  it("expands Hindi office phrases and canonicalizes place aliases", () => {
    const parsed = parseHinglishRankQualifiedOffice("Bharat ka pehla pradhan mantri kaun tha?");
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe("prime minister");
    expect(parsed?.place).toBe("bharat");
    expect(parsed?.canonicalPlace).toBe("India");
  });

  it("returns null for definitional 'kya hai' questions", () => {
    expect(parseHinglishRankQualifiedOffice("React kya hai?")).toBeNull();
  });
});

describe("parseHinglishOfficeholderOffice", () => {
  it("parses 'India ka pradhan mantri kaun hai?'", () => {
    const parsed = parseHinglishOfficeholderOffice("India ka pradhan mantri kaun hai?");
    expect(parsed?.office).toBe("prime minister");
    expect(parsed?.place).toBe("india");
    expect(parsed?.canonicalPlace).toBeNull();
  });

  it("handles the topicalized order", () => {
    const parsed = parseHinglishOfficeholderOffice("kaun hai America ka president?");
    expect(parsed?.office).toBe("president");
    expect(parsed?.place).toBe("america");
  });

  it("returns null for past-tense and place-fact questions", () => {
    expect(parseHinglishOfficeholderOffice("India ka pradhan mantri kaun tha?")).toBeNull();
    expect(parseHinglishOfficeholderOffice("Bharat ki rajdhani kaun hai?")).toBeNull();
  });
});

describe("capital parsing", () => {
  it("parses English capital questions", () => {
    expect(parseCapitalQuestion("What is the capital of France?")).toEqual({ place: "france" });
    expect(parseCapitalQuestion("what is the capital of australia")).toEqual({ place: "australia" });
    expect(parseCapitalQuestion("Who is the current prime minister of india?")).toBeNull();
  });

  it("parses Hinglish capital questions", () => {
    expect(parseHinglishCapitalQuestion("Bharat ki rajdhani kya hai?")).toEqual({
      place: "bharat",
    });
    expect(parseHinglishCapitalQuestion("kya hai Bharat ki rajdhani?")).toEqual({
      place: "bharat",
    });
  });
});

describe("maps parsing", () => {
  it("parses 'where is X' as a search", () => {
    expect(parseMapsRequest("where is the nearest coffee shop")).toEqual({
      query: "the nearest coffee shop",
      mode: "search",
    });
  });

  it("parses directions requests", () => {
    expect(parseMapsRequest("directions to delhi")).toEqual({ query: "delhi", mode: "directions" });
    expect(parseMapsRequest("how do i get to the airport")).toEqual({
      query: "the airport",
      mode: "directions",
    });
  });

  it("parses 'map of X' as a search", () => {
    expect(parseMapsRequest("map of france")).toEqual({ query: "france", mode: "search" });
  });

  it("rejects non-maps requests", () => {
    expect(parseMapsRequest("what time is it")).toBeNull();
    expect(parseMapsRequest("who is the prime minister?")).toBeNull();
  });
});

describe("classifyKnowledgeQuery", () => {
  it("classifies each question kind", () => {
    expect(classifyKnowledgeQuery("Who was the first Sikh prime minister of India?").kind).toBe(
      "rank-qualified"
    );
    expect(classifyKnowledgeQuery("Who is the current prime minister of India?").kind).toBe(
      "officeholder"
    );
    expect(classifyKnowledgeQuery("What is the capital of France?").kind).toBe("capital");
    expect(classifyKnowledgeQuery("What is React?").kind).toBe("generic");
  });

  it("canonicalizes place aliases", () => {
    expect(classifyKnowledgeQuery("Bharat ki rajdhani kya hai?").canonicalPlace).toBe("India");
    expect(classifyKnowledgeQuery("What is the capital of USA?").canonicalPlace).toBe(
      "United States"
    );
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
  });

  it("ignores unrelated prior turns", () => {
    expect(
      enrichSearchQuery("who is the current prime minister?", ["What is 2+2?", "What day is it?"])
    ).toBe("who is the current prime minister?");
  });
});

describe("text utilities", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b")).toBe("a\\.b");
  });

  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("minister", "minister")).toBe(0);
  });

  it("matches tokens tolerantly in titles", () => {
    expect(tokenInTitle("minister", "prime minister of india")).toBe(true);
    expect(tokenInTitle("ministar", "prime minister of india")).toBe(true);
    expect(tokenInTitle("xyz", "prime minister of india")).toBe(false);
  });

  it("title-cases words", () => {
    expect(titleCase("prime minister")).toBe("Prime Minister");
  });

  it("title-cases places, keeping articles and acronyms", () => {
    expect(displayTitle("united states of america")).toBe("United States of America");
    expect(displayTitle("usa")).toBe("USA");
    expect(displayTitle("new delhi")).toBe("New Delhi");
  });
});

describe("shared vocabularies", () => {
  it("exposes the fact-lookup terms the planner detector builds its pattern from", () => {
    expect(FACT_LOOKUP_TERMS).toContain("prime\\s+minister");
    expect(FACT_LOOKUP_TERMS).toContain("pradhan\\s+mantri");
    expect(FACT_LOOKUP_TERMS).toContain("rajdhani");
    expect(new Set(FACT_LOOKUP_TERMS).size).toBe(FACT_LOOKUP_TERMS.length);
  });

  it("exposes Hinglish particles", () => {
    expect(HINGLISH_PARTICLES.has("kya")).toBe(true);
    expect(HINGLISH_PARTICLES.has("hai")).toBe(true);
  });
});
