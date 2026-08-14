/**
 * Shared query normalization + knowledge-entity layer.
 *
 * Everything here is PURE: no network, no logging, no clock. The module owns
 * three things the rest of the system used to re-implement:
 *
 *   1. Text normalization primitives (lowercasing, tokenization, title-case,
 *      typo-tolerant matching).
 *   2. Entity vocabularies — currencies, place aliases, Hinglish rank words,
 *      Hinglish office expansions, stopwords, interrogative particles — plus
 *      the resolver functions that map user phrases to canonical entities.
 *   3. The knowledge-question parsers that turn free text into structured
 *      entities (officeholder / rank-qualified / capital / generic) and the
 *      conversation-aware query enrichment.
 *
 * Both the web toolkit (src/lib/toolkit/web.ts) and the planner's intent
 * detectors (src/services/planner/intents.ts) consume this single source of
 * truth, so the same phrase parses identically everywhere and a vocabulary
 * fix lands in exactly one place.
 *
 * web.ts re-exports every public symbol so existing consumers keep working.
 */

// ---------------------------------------------------------------------------
// Text normalization primitives
// ---------------------------------------------------------------------------

/**
 * Canonical lowercase form for parsing: lowercase, whitespace collapsed to
 * single spaces, trimmed. Trailing sentence punctuation is deliberately left
 * in place — the parsers strip it with their own `[?.!]?\s*$` anchors.
 */
export function normalizeQueryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Lowercase alphanumeric tokens of a text ("[a-z0-9]+" runs). */
export function tokenizeWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Edit distance — used for typo-tolerant entity matching (distance ≤ 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diagonal = above;
    }
  }
  return prev[b.length];
}

/** Whether a token appears in a title, tolerating a one-character typo. */
export function tokenInTitle(token: string, lowerTitle: string): boolean {
  if (lowerTitle.includes(token)) return true;
  if (token.length < 4) return false;
  return lowerTitle.split(/[^a-z]+/).some((word) => word.length >= 4 && levenshtein(token, word) <= 1);
}

/** Capitalize every word of a text (display/title building). */
export function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Title-case a place for display, keeping articles lowercase and acronyms uppercase. */
export function displayTitle(place: string): string {
  const minor = new Set(["the", "of", "and", "in", "on", "at", "a", "an"]);
  const acronyms = new Set(["usa", "us", "uk", "uae", "eu", "un", "u.s."]);
  return place
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      if (minor.has(lower)) return lower;
      return lower[0].toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// Entity vocabularies
// ---------------------------------------------------------------------------

/** Content words that never carry query meaning ("who is the current X of Y"). */
export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  "who", "what", "when", "where", "why", "how", "is", "are", "was", "were",
  "the", "of", "in", "on", "at", "for", "to", "a", "an", "and", "or", "it",
  "this", "that", "these", "those", "current", "currently", "please", "tell",
  "me", "about", "do", "does", "did", "can", "you", "give", "name", "list",
  "which", "has", "have", "as", "by", "with", "from", "be", "been", "being",
]);

/** Hinglish interrogative particles — never content, never a search subject. */
export const HINGLISH_PARTICLES: ReadonlySet<string> = new Set([
  "kya", "hai", "tha", "thi", "hain", "the", "hota", "hoti", "kaun", "kis",
  "konsa", "kiska", "kiski", "ho", "hue", "hoga",
]);

/** ISO 4217 codes and their everyday names. */
const CURRENCY_ALIASES: Record<string, string> = {
  usd: "USD", dollar: "USD", dollars: "USD", "$": "USD", "us$": "USD",
  eur: "EUR", euro: "EUR", euros: "EUR", "€": "EUR",
  inr: "INR", rupee: "INR", rupees: "INR", "₹": "INR", rs: "INR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", "£": "GBP",
  jpy: "JPY", yen: "JPY", "¥": "JPY",
  aud: "AUD", cad: "CAD", chf: "CHF", cny: "CNY", "yuan": "CNY",
  sgd: "SGD", hkd: "HKD", aed: "AED", "dirham": "AED",
  brl: "BRL", "real": "BRL", zar: "ZAR", mxn: "MXN", sek: "SEK", nok: "NOK",
  dkk: "DKK", nzd: "NZD", krw: "KRW", "won": "KRW", rub: "RUB",
};

/**
 * Normalize a currency token to its ISO 4217 code ("100 rupees" → "INR",
 * "usd" → "USD"). Returns null for an unrecognized token.
 */
export function normalizeCurrency(token: string): string | null {
  const clean = token.toLowerCase().replace(/[^a-z$€£¥₹]/g, "");
  if (clean.length === 0) return null;
  const code = CURRENCY_ALIASES[clean] ?? (clean.length === 3 ? clean.toUpperCase() : null);
  return code;
}

/** Unambiguous place aliases normalized to their Wikipedia article title. */
const PLACE_ALIASES: Record<string, string> = {
  usa: "United States",
  us: "United States",
  "u.s.": "United States",
  america: "United States",
  "united states": "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  "united kingdom": "United Kingdom",
  uae: "United Arab Emirates",
  "u.a.e.": "United Arab Emirates",
  bharat: "India",
  hindustan: "India",
};

/**
 * The canonical Wikipedia article title for a place, so "what is the capital
 * of usa" reads the "United States" article (whose infobox carries the
 * `capital` field) instead of failing on the alias "usa". Returns null when
 * the place needs no normalization.
 */
export function canonicalPlaceOf(place: string): string | null {
  const key = place.toLowerCase().trim().replace(/^the\s+/, "").trim();
  if (!key) return null;
  return PLACE_ALIASES[key] ?? null;
}

/** Hinglish rank words mapped to the English content word articles use. */
const HINGLISH_RANK_WORDS: Record<string, string> = {
  pehla: "first",
  pehli: "first",
  pehle: "first",
  pahla: "first",
  pahli: "first",
  "sabse pehla": "first",
  "sabse pehle": "first",
  aakhri: "last",
  akhri: "last",
  aakhir: "last",
  pichhla: "previous",
  pichhle: "previous",
  pichhli: "previous",
  pichla: "previous",
  agla: "next",
  agle: "next",
  agli: "next",
  doosra: "second",
  dusra: "second",
  teesra: "third",
  tisra: "third",
  chautha: "fourth",
  purana: "former",
  purani: "former",
  "sabse purana": "oldest",
  "sabse chhota": "youngest",
  "sabse naya": "latest",
};

/** Hinglish/Hindi office phrases expanded to the English phrase article content uses. */
const HINGLISH_OFFICE_EXPANSIONS: Record<string, string> = {
  "pradhan mantri": "prime minister",
  pradhanmantri: "prime minister",
  "mukhya mantri": "chief minister",
  mukhyamantri: "chief minister",
  mantri: "minister",
  rashtrapati: "president",
  uprashtrapati: "vice president",
  pm: "prime minister",
  cm: "chief minister",
  vp: "vice president",
};

/** Expand a Hinglish/Hindi office phrase to the English phrase article content uses. */
export function expandHinglishOffice(office: string): string {
  for (const [hing, eng] of Object.entries(HINGLISH_OFFICE_EXPANSIONS)) {
    const re = new RegExp(`\\b${hing.replace(/\s+/g, "\\s+")}\\b`);
    if (re.test(office)) return office.replace(re, eng);
  }
  return office;
}

/**
 * Shared factual-lookup vocabulary — regex-source fragments for the office,
 * place-fact and person-fact nouns that mark a Hinglish knowledge question.
 * The planner's `detectKnowledge` builds its phrasing pattern from this list
 * so the detector and the web toolkit's parsers agree on one vocabulary.
 */
export const FACT_LOOKUP_TERMS: readonly string[] = [
  "prime\\s+minister",
  "president",
  // Abbreviated office forms, so the planner's Hinglish detector routes
  // "India ka pehla Sikh PM kaun tha?" to web_search too; the web toolkit's
  // shared expandHinglishOffice expands them before parsing.
  "pm",
  "cm",
  "vp",
  "capital",
  "population",
  "history",
  "founded",
  "invented",
  "discovered",
  "highest",
  "largest",
  "tallest",
  "winner",
  "champion",
  "rajdhani",
  "rashtrapati",
  "pradhan\\s+mantri",
];

// ---------------------------------------------------------------------------
// Currency request parsing
// ---------------------------------------------------------------------------

/** Extract a currency request from free text like "100 usd to inr". */
export function parseCurrencyRequest(
  input: string
): { amount: number; from: string; to: string } | null {
  const text = input.toLowerCase().trim();
  const match =
    text.match(/(?:convert|what is|how much is|how much)\s+([\d.,]+\s*[a-z$€£¥₹]+)\s+(?:to|in|into|in)\s+([a-z$€£¥₹]+)/i) ??
    text.match(/([\d.,]+\s*[a-z$€£¥₹]+)\s+(?:to|in|into)\s+([a-z$€£¥₹]+)/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, "").match(/^[\d.]+/)?.[0] ?? NaN);
  if (!Number.isFinite(amount)) return null;
  const from = match[1].replace(/^[\d.,]+\s*/, "");
  const to = match[2];
  if (!from || !to) return null;
  return { amount, from, to };
}

// ---------------------------------------------------------------------------
// Knowledge question parsing
// ---------------------------------------------------------------------------

/** Content-bearing terms of a question, e.g. "prime minister of India" + stopwords removed. */
export function queryKeywords(q: string): string[] {
  const tokens = q.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (token.length < 3 || SEARCH_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Parse a "who is the current <office> of <place>?" question into its parts.
 * Returns null for anything that is not an officeholder question.
 */
export function parseOfficeQuestion(q: string): { office: string; place: string } | null {
  const m = normalizeQueryText(q).match(
    /\bwho\s+is\s+(?:the\s+)?(?:current\s+)?(.+?)\s+of\s+(.+?)\s*[?.!]?\s*$/
  );
  if (!m) return null;
  // Expand abbreviated and Hinglish office phrases ("PM", "CM", "pradhan
  // mantri") to the canonical English phrase BEFORE the length guard — the
  // same expansion the Hinglish parser applies — so "who is the current PM
  // of India?" routes to the officeholder path instead of falling through to
  // the generic Wikipedia ranking (where the wrong office-adjacent article
  // could win).
  const office = expandHinglishOffice(m[1].trim());
  const place = m[2].trim();
  if (office.length < 3 || place.length < 2) return null;
  if (/\b(?:you|this|that|it|there)\b/.test(place)) return null;
  return { office, place };
}

/** The bare office label of a question ("who is the current prime minister?" → "prime minister"). */
export function officeLabelOf(q: string): string | null {
  const m = normalizeQueryText(q).match(/\bwho\s+is\s+(?:the\s+)?(?:current\s+)?(.+?)\s*[?.]?\s*$/);
  // Expand abbreviated office phrases so the generic path scores and the
  // follow-up enrichment matches the canonical English phrase ("pm" → "prime
  // minister") instead of a 2-letter token that office matching ignores.
  return m ? expandHinglishOffice(m[1].trim()) : null;
}

/** Trailing noun phrase after the last "of", e.g. "what is the capital of france?" → "france". */
export function anchorOf(query: string): string | null {
  const m = normalizeQueryText(query).match(/\bof\s+([a-z][a-z0-9\s-]{0,40})[?.]?\s*$/);
  return m ? m[1].trim() : null;
}

/** Capitalized content words (proper nouns) in a question, ignoring the sentence-initial word. */
export function properNounsOf(query: string): string[] {
  const words = query.match(/[A-Z][a-zA-Z]+/g) ?? [];
  const first = query.trim().split(/\s+/)[0];
  return words.filter((w) => w !== first).map((w) => w.toLowerCase());
}

/**
 * Core office noun of a rank-qualified question ("...first sikh prime minister of india" → "minister").
 * The captured office phrase is expanded ("sikh pm" → "sikh prime minister") before the
 * length filter so abbreviations survive it — the same expansion every other parser applies.
 */
export function officeNounOf(q: string): string | null {
  const m = normalizeQueryText(q).match(
    /\bwho\s+(?:is|was)\s+(?:the\s+)?(?:first|last|previous|former|next|oldest|youngest|earliest|latest|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(.+?)\s+of\s+(.+?)\s*[?.!]?\s*$/
  );
  if (!m) return null;
  const office = expandHinglishOffice(m[1].trim());
  const words = office.split(/\s+/).filter((w) => w.length >= 3);
  return words[words.length - 1] ?? null;
}

export interface RankQualifiedOffice {
  rank: string;
  office: string;
  officeNoun: string;
  qualifiers: string[];
  place: string;
  canonicalPlace: string | null;
}

/**
 * Parse a rank-qualified officeholder question into its parts: rank
 * ("first"), office phrase ("sikh prime minister"), core office noun
 * ("minister"), content qualifiers ("sikh", "prime") and place ("india").
 * Returns null for anything that is not such a question.
 */
export function parseRankQualifiedOffice(q: string): RankQualifiedOffice | null {
  const m = normalizeQueryText(q).match(
    /\bwho\s+(?:is|was)\s+(?:the\s+)?(first|last|previous|former|next|oldest|youngest|earliest|latest|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(.+?)\s+of\s+(.+?)\s*[?.!]?\s*$/
  );
  if (!m) return null;
  const rank = m[1];
  let office = m[2].trim();
  const place = m[3].trim();
  if (place.length < 2) return null;
  if (/\b(?:you|this|that|it|there)\b/.test(place)) return null;
  // Expand short forms ("pm" → "prime minister") and Hindi office phrases
  // ("pradhan mantri") BEFORE the length guard so abbreviations survive it —
  // the same expansion the Hinglish parser applies. officeNoun and qualifiers
  // are then derived from the EXPANDED phrase, never the raw capture.
  office = expandHinglishOffice(office);
  if (office.length < 3) return null;
  const words = office.split(/\s+/).filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
  const officeNoun = words[words.length - 1] ?? "";
  if (!officeNoun) return null;
  return {
    rank,
    office,
    officeNoun,
    qualifiers: words.slice(0, -1),
    place,
    canonicalPlace: canonicalPlaceOf(place),
  };
}

/**
 * Parse a Hinglish rank-qualified officeholder question ("India ka pehla Sikh
 * Prime Minister kaun tha?") into the same parts as the English shape: place
 * ("india"), rank ("first"), office phrase ("sikh prime minister"), core noun
 * ("minister") and qualifiers ("sikh", "prime"). Both the canonical order
 * ("<place> ka/ke/ki <rank> <office> kaun <verb>") and the topicalized order
 * ("kaun <verb> <place> ka/ke/ki <rank> <office>") are accepted. Only matches
 * when a factual noun precedes the Hinglish interrogative, so definitional
 * "kya hai" questions stay generic. Returns null for anything else.
 */
export function parseHinglishRankQualifiedOffice(q: string): RankQualifiedOffice | null {
  const text = normalizeQueryText(q);
  const post = "(?:ka|ke|ki)";
  const rankSrc =
    "(?:sabse\\s+)?(?:pehla|pehli|pehle|pahla|pahli|aakhri|akhri|aakhir|pichhla|pichhle|pichhli|pichla|agla|agle|agli|doosra|dusra|teesra|tisra|chautha|purana|purani)";
  const verb = "(?:hai|tha|thi|the|hain|thay|hoga|hogi|honge)";
  const m = text.match(
    new RegExp(`^(.+?)\\s+${post}\\s+(${rankSrc})\\s+(.+?)\\s+kaun\\s+${verb}[?.!]?\\s*$`)
  );
  const mTop = !m
    ? text.match(
        new RegExp(`^kaun\\s+${verb}\\s+(.+?)\\s+${post}\\s+(${rankSrc})\\s+(.+?)[?.!]?\\s*$`)
      )
    : null;
  if (!m && !mTop) return null;
  const place = (m ? m[1] : mTop![1]).trim();
  const rankRaw = (m ? m[2] : mTop![2]).trim();
  let office = (m ? m[3] : mTop![3]).trim();
  if (place.length < 2) return null;
  if (/\b(?:you|this|that|it|there|mera|tera|aapka|tumhara)\b/.test(place)) return null;
  const rank = HINGLISH_RANK_WORDS[rankRaw] ?? rankRaw;
  // Expand short forms ("pm" → "prime minister") and Hindi office phrases
  // ("pradhan mantri") BEFORE the length guard so abbreviations survive it.
  office = expandHinglishOffice(office);
  if (office.length < 3) return null;
  const words = office.split(/\s+/).filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
  const officeNoun = words[words.length - 1] ?? "";
  if (!officeNoun) return null;
  return {
    rank,
    office,
    officeNoun,
    qualifiers: words.slice(0, -1),
    place,
    canonicalPlace: canonicalPlaceOf(place),
  };
}

export interface HinglishOfficeholderOffice {
  office: string;
  place: string;
  canonicalPlace: string | null;
}

/**
 * Parse a Hinglish officeholder question with NO rank qualifier ("India ka
 * pradhan mantri kaun hai?") into office + place, so it gets the same
 * verified-factual treatment as the English "who is the X of Y?" shape: the
 * answer comes from the article's infobox incumbent and, when the source is
 * unavailable, the pipeline refuses instead of asking the model to guess.
 * Only present-tense person interrogatives ("kaun hai/hain") are accepted —
 * a past-tense "kaun tha?" is time-ambiguous and its answer is never the
 * current incumbent, and "kya hai" place-facts ("Bharat ki rajdhani …") ask
 * WHAT, not WHO. Both the canonical ("<place> ka/ke/ki <office> kaun <verb>")
 * and topicalized ("kaun <verb> <place> ka/ke/ki <office>") orders are
 * accepted. Returns null for anything else.
 */
export function parseHinglishOfficeholderOffice(q: string): HinglishOfficeholderOffice | null {
  const text = normalizeQueryText(q);
  const post = "(?:ka|ke|ki)";
  const verb = "(?:hai|hain)";
  const m = text.match(new RegExp(`^(.+?)\\s+${post}\\s+(.+?)\\s+kaun\\s+${verb}[?.!]?\\s*$`));
  const mTop = !m
    ? text.match(new RegExp(`^kaun\\s+${verb}\\s+(.+?)\\s+${post}\\s+(.+?)[?.!]?\\s*$`))
    : null;
  if (!m && !mTop) return null;
  const place = (m ? m[1] : mTop![1]).trim();
  let office = (m ? m[2] : mTop![2]).trim();
  if (place.length < 2) return null;
  if (/\b(?:you|this|that|it|there|mera|tera|aapka|tumhara)\b/.test(place)) return null;
  office = expandHinglishOffice(office);
  if (office.length < 3) return null;
  // "Rajdhani" (capital) and other place-facts are WHAT-questions ("kya"),
  // never WHO-questions — a person-office parser must not claim them.
  if (/\b(?:rajdhani|capital|population|currency|language)\b/.test(office)) return null;
  return { office, place, canonicalPlace: canonicalPlaceOf(place) };
}

export type KnowledgeQueryKind = "officeholder" | "rank-qualified" | "capital" | "generic";

export interface KnowledgeQuery {
  kind: KnowledgeQueryKind;
  office?: string;
  officeNoun?: string;
  qualifiers?: string[];
  place?: string;
  canonicalPlace?: string | null;
  rank?: string;
}

/**
 * Classify a knowledge query so webSearch picks the right strategy.
 * Officeholder and capital questions are answered authoritatively from the
 * article's infobox (DuckDuckGo is skipped entirely); rank-qualified and
 * generic questions race DuckDuckGo but only accept it when the content is
 * genuinely relevant to THIS query.
 */
export function classifyKnowledgeQuery(q: string): KnowledgeQuery {
  const rank = parseRankQualifiedOffice(q) ?? parseHinglishRankQualifiedOffice(q);
  if (rank) {
    return {
      kind: "rank-qualified",
      office: rank.office,
      officeNoun: rank.officeNoun,
      qualifiers: rank.qualifiers,
      place: rank.place,
      canonicalPlace: rank.canonicalPlace,
      rank: rank.rank,
    };
  }
  const office = parseOfficeQuestion(q) ?? parseHinglishOfficeholderOffice(q);
  if (office) {
    return {
      kind: "officeholder",
      office: office.office,
      place: office.place,
      canonicalPlace: canonicalPlaceOf(office.place),
    };
  }
  const capital = parseCapitalQuestion(q);
  if (capital) {
    return {
      kind: "capital",
      place: capital.place,
      canonicalPlace: canonicalPlaceOf(capital.place),
    };
  }
  return { kind: "generic" };
}

/**
 * Conversation-aware query enrichment: when the current question is an office
 * question that omits the place ("who is the current prime minister?") and a
 * PRIOR user turn asked about the same office WITH a place ("...of india"),
 * the place is appended so the follow-up is searched with that context.
 */
export function enrichSearchQuery(query: string, priorUserMessages: string[]): string {
  if (/\bof\s+[a-z][a-z\s]{1,40}\s*[?.]?\s*$/i.test(query)) return query;
  const office = officeLabelOf(query);
  if (!office) return query;
  const queryLower = query.toLowerCase();
  for (const prior of priorUserMessages) {
    const parsed = parseOfficeQuestion(prior);
    if (
      parsed &&
      parsed.office === office &&
      parsed.place &&
      !queryLower.includes(parsed.place.toLowerCase())
    ) {
      return `${query.trim().replace(/[?.]\s*$/, "")} of ${parsed.place}`;
    }
  }
  return query;
}

// ---------------------------------------------------------------------------
// Capital question parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Hinglish capital question ("Bharat ki rajdhani kya hai?") into the
 * same shape as the English "what is the capital of <place>?" — place only.
 * Both the canonical order ("<place> ki rajdhani kya hai?") and the topicalized
 * order ("kya hai <place> ki rajdhani?") are accepted. Only the WHAT
 * interrogative ("kya hai/hain") matches — "kaun hai" (who) is a person
 * question, never a capital fact. Returns null for anything else.
 */
export function parseHinglishCapitalQuestion(q: string): { place: string } | null {
  const text = normalizeQueryText(q);
  const post = "(?:ka|ke|ki)";
  const verb = "(?:hai|hain)";
  const m = text.match(
    new RegExp(`^(.+?)\\s+${post}\\s+rajdhani\\s+kya\\s+${verb}[?.!]?\\s*$`)
  );
  const mTop = !m
    ? text.match(new RegExp(`^kya\\s+${verb}\\s+(.+?)\\s+${post}\\s+rajdhani[?.!]?\\s*$`))
    : null;
  if (!m && !mTop) return null;
  const place = (m ? m[1] : mTop![1]).trim();
  if (place.length < 2) return null;
  if (/\b(?:you|this|that|it|there|mera|tera|aapka|tumhara)\b/.test(place)) return null;
  return { place };
}

/** Parse a "what is the capital of <place>?" question (English or Hinglish). */
export function parseCapitalQuestion(q: string): { place: string } | null {
  const english = normalizeQueryText(q).match(/\bwhat\s+is\s+(?:the\s+)?capital\s+of\s+(.+?)\s*[?.]?\s*$/);
  if (english) {
    const place = english[1].trim();
    if (place.length < 2 || /\b(?:you|this|that|it|there)\b/.test(place)) return null;
    return { place };
  }
  return parseHinglishCapitalQuestion(q);
}

// ---------------------------------------------------------------------------
// Maps / navigation request parsing
// ---------------------------------------------------------------------------

/** Extract a maps/navigation request: "where is x", "directions to x". */
export function parseMapsRequest(
  input: string
): { query: string; mode: "search" | "directions" } | null {
  const text = normalizeQueryText(input);
  const where = text.match(/\bwhere\s+is\s+(.+)$/);
  if (where) return { query: where[1].trim(), mode: "search" };
  const directions = text.match(/\b(?:directions|route|navigate|how\s+do\s+i\s+get)\s+to\s+(.+)$/);
  if (directions) return { query: directions[1].trim(), mode: "directions" };
  const map = text.match(/\bmap\s+of\s+(.+)$/);
  if (map) return { query: map[1].trim(), mode: "search" };
  return null;
}
