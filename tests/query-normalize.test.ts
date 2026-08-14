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
  officeNounOf,
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

  describe("abbreviation expansion (regression: 'first Sikh PM of India')", () => {
    it("expands 'Sikh PM' BEFORE the length guard so the 2-letter token survives", () => {
      const parsed = parseRankQualifiedOffice("Who was the first Sikh PM of India?");
      expect(parsed).not.toBeNull();
      expect(parsed?.rank).toBe("first");
      expect(parsed?.office).toBe("sikh prime minister");
      expect(parsed?.officeNoun).toBe("minister");
      expect(parsed?.qualifiers).toEqual(["sikh", "prime"]);
      expect(parsed?.place).toBe("india");
    });

    it("non-regression: the full 'Sikh Prime Minister' form parses identically", () => {
      const full = parseRankQualifiedOffice("Who was the first Sikh Prime Minister of India?");
      const abbr = parseRankQualifiedOffice("Who was the first Sikh PM of India?");
      expect(full).toEqual(abbr);
    });

    it("expands 'Sikh CM' through the shared vocabulary — not a PM-only patch", () => {
      const parsed = parseRankQualifiedOffice("Who was the first Sikh CM of Punjab?");
      expect(parsed).not.toBeNull();
      expect(parsed?.office).toBe("sikh chief minister");
      expect(parsed?.officeNoun).toBe("minister");
      expect(parsed?.qualifiers).toEqual(["sikh", "chief"]);
      expect(parsed?.place).toBe("punjab");
    });

    it("non-regression: the Hinglish 'India ka pehla Sikh PM kaun tha?' path still expands", () => {
      const parsed = parseHinglishRankQualifiedOffice("India ka pehla Sikh PM kaun tha?");
      expect(parsed).not.toBeNull();
      expect(parsed?.office).toBe("sikh prime minister");
      expect(parsed?.officeNoun).toBe("minister");
      expect(parsed?.qualifiers).toEqual(["sikh", "prime"]);
      expect(parsed?.place).toBe("india");
    });

    it("officeNounOf derives the noun from the EXPANDED phrase too", () => {
      expect(officeNounOf("Who was the first Sikh PM of India?")).toBe("minister");
      expect(officeNounOf("Who was the first Sikh Prime Minister of India?")).toBe("minister");
      expect(officeNounOf("Who was the first Sikh CM of Punjab?")).toBe("minister");
    });

    it("classifyKnowledgeQuery routes the abbreviated form as rank-qualified with the expanded noun", () => {
      const cls = classifyKnowledgeQuery("Who was the first Sikh PM of India?");
      expect(cls.kind).toBe("rank-qualified");
      expect(cls.office).toBe("sikh prime minister");
      expect(cls.officeNoun).toBe("minister");
      expect(cls.qualifiers).toEqual(["sikh", "prime"]);
      expect(cls.place).toBe("india");
    });
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

describe("matrix: office forms × place forms × question templates", () => {
  // Every office phrase below must resolve to the SAME canonical English
  // phrase regardless of abbreviation ("PM"), Hinglish word ("pradhan mantri")
  // or attached qualifier ("Sikh PM") — proving the parser genuinely goes
  // through the shared expandHinglishOffice vocabulary, not one-off patches.
  const OFFICE_FORMS: Array<{ form: string; office: string; officeNoun: string; qualifiers: string[] }> = [
    { form: "PM", office: "prime minister", officeNoun: "minister", qualifiers: ["prime"] },
    { form: "pm", office: "prime minister", officeNoun: "minister", qualifiers: ["prime"] },
    { form: "prime minister", office: "prime minister", officeNoun: "minister", qualifiers: ["prime"] },
    { form: "pradhan mantri", office: "prime minister", officeNoun: "minister", qualifiers: ["prime"] },
    { form: "pradhanmantri", office: "prime minister", officeNoun: "minister", qualifiers: ["prime"] },
    { form: "CM", office: "chief minister", officeNoun: "minister", qualifiers: ["chief"] },
    { form: "chief minister", office: "chief minister", officeNoun: "minister", qualifiers: ["chief"] },
    { form: "mukhya mantri", office: "chief minister", officeNoun: "minister", qualifiers: ["chief"] },
    { form: "mukhyamantri", office: "chief minister", officeNoun: "minister", qualifiers: ["chief"] },
    { form: "VP", office: "vice president", officeNoun: "president", qualifiers: ["vice"] },
    { form: "vice president", office: "vice president", officeNoun: "president", qualifiers: ["vice"] },
    { form: "uprashtrapati", office: "vice president", officeNoun: "president", qualifiers: ["vice"] },
    { form: "rashtrapati", office: "president", officeNoun: "president", qualifiers: [] },
    { form: "president", office: "president", officeNoun: "president", qualifiers: [] },
    { form: "Sikh PM", office: "sikh prime minister", officeNoun: "minister", qualifiers: ["sikh", "prime"] },
    { form: "Sikh pradhan mantri", office: "sikh prime minister", officeNoun: "minister", qualifiers: ["sikh", "prime"] },
    { form: "Sikh CM", office: "sikh chief minister", officeNoun: "minister", qualifiers: ["sikh", "chief"] },
  ];

  const PLACE_FORMS: Array<{ form: string; place: string; canonicalPlace: string | null }> = [
    { form: "India", place: "india", canonicalPlace: null },
    { form: "Bharat", place: "bharat", canonicalPlace: "India" },
    { form: "Hindustan", place: "hindustan", canonicalPlace: "India" },
    { form: "USA", place: "usa", canonicalPlace: "United States" },
    { form: "United Kingdom", place: "united kingdom", canonicalPlace: "United Kingdom" },
  ];

  const EN_TEMPLATES: Array<{ label: string; rank: string; build: (office: string, place: string) => string }> = [
    { label: "who was the first", rank: "first", build: (o, p) => `Who was the first ${o} of ${p}?` },
    { label: "who is the first", rank: "first", build: (o, p) => `Who is the first ${o} of ${p}?` },
    { label: "who was the last", rank: "last", build: (o, p) => `Who was the last ${o} of ${p}?` },
  ];

  const HI_TEMPLATES: Array<{ label: string; build: (place: string, office: string) => string }> = [
    { label: "<place> ka pehla <office> kaun tha?", build: (p, o) => `${p} ka pehla ${o} kaun tha?` },
    { label: "kaun tha <place> ka pehla <office>?", build: (p, o) => `kaun tha ${p} ka pehla ${o}?` },
  ];

  const englishCases = OFFICE_FORMS.flatMap((of) =>
    PLACE_FORMS.flatMap((pf) =>
      EN_TEMPLATES.map((t) => ({
        name: `EN[${t.label}] ${of.form} × ${pf.form}`,
        question: t.build(of.form, pf.form),
        rank: t.rank,
        office: of.office,
        officeNoun: of.officeNoun,
        qualifiers: of.qualifiers,
        place: pf.place,
        canonicalPlace: pf.canonicalPlace,
      }))
    )
  );

  it.each(englishCases)("English: $name", (c) => {
    const parsed = parseRankQualifiedOffice(c.question);
    expect(parsed).not.toBeNull();
    expect(parsed?.rank).toBe(c.rank);
    expect(parsed?.office).toBe(c.office);
    expect(parsed?.officeNoun).toBe(c.officeNoun);
    expect(parsed?.qualifiers).toEqual(c.qualifiers);
    expect(parsed?.place).toBe(c.place);
    expect(parsed?.canonicalPlace).toBe(c.canonicalPlace);
    const cls = classifyKnowledgeQuery(c.question);
    expect(cls.kind).toBe("rank-qualified");
    expect(cls.officeNoun).toBe(c.officeNoun);
    expect(cls.office).toBe(c.office);
  });

  // Hinglish templates use place names that pass the Hinglish possessive and
  // the pronoun guard ("the united states" trips \bthe\b) — the same English
  // office-form and canonicalization expectations must hold on this path.
  const hinglishPlaces = PLACE_FORMS.filter((pf) => ["India", "Bharat", "Hindustan"].includes(pf.form));
  const hinglishCases = OFFICE_FORMS.flatMap((of) =>
    hinglishPlaces.flatMap((pf) =>
      HI_TEMPLATES.map((t) => ({
        name: `HI[${t.label}] ${of.form} × ${pf.form}`,
        question: t.build(pf.form, of.form),
        office: of.office,
        officeNoun: of.officeNoun,
        qualifiers: of.qualifiers,
        place: pf.place,
        canonicalPlace: pf.canonicalPlace,
      }))
    )
  );

  it.each(hinglishCases)("Hinglish: $name", (c) => {
    const parsed = parseHinglishRankQualifiedOffice(c.question);
    expect(parsed).not.toBeNull();
    expect(parsed?.rank).toBe("first");
    expect(parsed?.office).toBe(c.office);
    expect(parsed?.officeNoun).toBe(c.officeNoun);
    expect(parsed?.qualifiers).toEqual(c.qualifiers);
    expect(parsed?.place).toBe(c.place);
    expect(parsed?.canonicalPlace).toBe(c.canonicalPlace);
    const cls = classifyKnowledgeQuery(c.question);
    expect(cls.kind).toBe("rank-qualified");
    expect(cls.officeNoun).toBe(c.officeNoun);
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
    // Abbreviated office forms route the Hinglish detector to web_search too;
    // the web toolkit's expandHinglishOffice expands them before parsing.
    expect(FACT_LOOKUP_TERMS).toContain("pm");
    expect(FACT_LOOKUP_TERMS).toContain("cm");
    expect(FACT_LOOKUP_TERMS).toContain("vp");
    expect(new Set(FACT_LOOKUP_TERMS).size).toBe(FACT_LOOKUP_TERMS.length);
  });

  it("exposes Hinglish particles", () => {
    expect(HINGLISH_PARTICLES.has("kya")).toBe(true);
    expect(HINGLISH_PARTICLES.has("hai")).toBe(true);
  });
});
