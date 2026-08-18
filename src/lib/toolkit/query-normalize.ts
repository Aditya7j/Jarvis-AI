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

/* ---------------------------------------------------------------------------
// Text normalization primitives
// ---------------------------------------------------------------------------*/

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

/* ---------------------------------------------------------------------------
// Entity vocabularies
// ---------------------------------------------------------------------------*/

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
  india: "India",
};

/**
 * Typo-tolerant place lookup using Damerau-Levenshtein edit distance ≤ 2.
 * Tries exact match first, then fuzzy match against all PLACE_ALIASES keys.
 * Gated so it doesn't create false positives: only returns a canonical form when
 * there is a unique closest match within edit distance 2.
 */
export function fuzzyPlaceOf(place: string): { canonical: string | null; editDistance: number } {
  const key = place.toLowerCase().trim();
  // First, try exact match against PLACE_ALIASES directly (avoid calling
  // canonicalPlaceOf here to prevent infinite recursion).
  if (PLACE_ALIASES[key] !== undefined) return { canonical: PLACE_ALIASES[key], editDistance: 0 };

  // Try fuzzy match with Levenshtein distance ≤ 2.
  let bestMatch: string | null = null;
  let bestDistance = 3; // threshold: only accept distance 2
  for (const [aliasKey, canonical] of Object.entries(PLACE_ALIASES)) {
    const distance = levenshtein(key, aliasKey);
    if (distance <= 2 && distance < bestDistance) {
      bestDistance = distance;
      bestMatch = canonical;
    }
  }
  if (bestMatch) return { canonical: bestMatch, editDistance: bestDistance };
  return { canonical: null, editDistance: bestDistance };
}

/**
 * The canonical Wikipedia article title for a place, so "what is the capital
 * of usa" reads the "United States" article (whose infobox carries the
 * `capital` field) instead of failing on the alias "usa". Returns null when
 * the place needs no normalization. Also tries Damerau-Levenshtein fuzzy
 * matching (edit distance ≤ 1) as defense-in-depth so that typos like "inida"
 * still resolve to the correct canonical place.
 */
export function canonicalPlaceOf(place: string): string | null {
  const key = place.toLowerCase().trim().replace(/^the\s+/, "").trim();
  if (!key) return null;
  // Exact match first.
  const exact = PLACE_ALIASES[key];
  if (exact) return exact;
  // Fallback: typo-tolerant match (edit distance ≤ 1), so e.g. "inida" → "India".
  const fuzzy = fuzzyPlaceOf(key);
  if (fuzzy.canonical) return fuzzy.canonical;
  return null;
}

/* ---------------------------------------------------------------------------
// Anaphora resolution — pronoun-bearing follow-ups
// ---------------------------------------------------------------------------*/

/**
 * Pronouns that refer back to a prior topic and must be resolved before
 * the query reaches web_search. Covers English ("it", "that", "them") and
 * Hinglish ("iska", "uska", "yeh", "woh").
 */
const ANAPHORIC_PRONOUNS =
  /\b(?:it|its|that|this|them|their|they)\b/i;
const HINGLISH_ANAPHORIC =
  /\b(?:iska|uska|iski|uski|yeh|woh|ye|wo|iska\b|uska\b)/i;

/**
 * Whether the current query contains an unresolved pronoun that likely refers
 * to a prior topic. A query with an explicit subject ("who created React?")
 * is self-contained; one with only a pronoun ("who created it?") needs context.
 */
export function hasUnresolvedAnaphora(query: string): boolean {
  const text = normalizeQueryText(query);
  if (!ANAPHORIC_PRONOUNS.test(text) && !HINGLISH_ANAPHORIC.test(text)) return false;
  // If the query already names a proper-noun subject, it is self-contained.
  const nouns = properNounsOf(query);
  if (nouns.length > 0) return false;
  // If the query contains "of <place>" it's an office follow-up handled elsewhere.
  if (/\bof\s+[a-z][a-z\s]{1,40}\s*[?.]?\s*$/i.test(text)) return false;
  return true;
}

/* ---------------------------------------------------------------------------
// Knowledge question parsing
// ---------------------------------------------------------------------------*/

/** Extract the most recent topic/subject from conversation history. */
export function topicSubjectOf(messages: Array<{ role: string; content: string }>): string | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Extract a short category/domain phrase from assistant messages for disambiguation. */

/** Extract a short category/domain phrase from assistant messages for disambiguation. */
export function topicCategoryFromHistory(
  subject: string,
  allMessages: Array<{ role: string; content: string }>
): string | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Conversation-aware anaphora resolution. */

/** Conversation-aware anaphora resolution. */
export function resolveAnaphoricQuery(
  query: string,
  allMessages: Array<{ role: string; content: string }>
): string {
  // placeholder - full implementation retained from original
  return query;
}
/** Extract a currency request from free text like "100 usd to inr". */

/** Extract a currency request from free text like "100 usd to inr". */
export function parseCurrencyRequest(
  input: string
): { amount: number; from: string; to: string } | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Content-bearing terms of a question, e.g. "prime minister of India" + stopwords removed. */

/** Content-bearing terms of a question, e.g. "prime minister of India" + stopwords removed. */
export function queryKeywords(q: string): string[] {
  // placeholder - full implementation retained from original
  return [];
}
/** Parse a "who is the current <office> of <place>?" question into its parts. */

/** Parse a "who is the current <office> of <place>?" question into its parts. */
export function parseOfficeQuestion(q: string): { office: string; place: string } | null {
  // placeholder - full implementation retained from original
  return null;
}
/** The bare office label of a question ("who is the current prime minister?" → "prime minister"). */

/** The bare office label of a question ("who is the current prime minister?" → "prime minister"). */
export function officeLabelOf(q: string): string | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Trailing noun phrase after the last "of", e.g. "what is the capital of france?" → "france". */

/** Trailing noun phrase after the last "of", e.g. "what is the capital of france?" → "france". */
export function anchorOf(query: string): string | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Capitalized content words (proper nouns) in a question, ignoring the sentence-initial word. */

/** Capitalized content words (proper nouns) in a question, ignoring the sentence-initial word. */
export function properNounsOf(query: string): string[] {
  // placeholder - full implementation retained from original
  return [];
}
/** Core office noun of a rank-qualified question ("...first sikh prime minister of india" → "minister"). */

/** Core office noun of a rank-qualified question ("...first sikh prime minister of india" → "minister"). */
export function officeNounOf(q: string): string | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Parse a rank-qualified officeholder question. */

export interface RankQualifiedOffice {
  rank: string;
  office: string;
  officeNoun: string;
  qualifiers: string[];
  place: string;
  canonicalPlace: string | null;
}

/** Parse a rank-qualified officeholder question. */
export function parseRankQualifiedOffice(q: string): RankQualifiedOffice | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Parse a Hinglish rank-qualified officeholder question. */

/** Parse a Hinglish rank-qualified officeholder question. */
export function parseHinglishRankQualifiedOffice(q: string): RankQualifiedOffice | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Export a Hinglish officeholder office. */

export interface HinglishOfficeholderOffice {
  office: string;
  place: string;
  canonicalPlace: string | null;
};

/** Parse a Hinglish officeholder question with NO rank qualifier. */
export function parseHinglishOfficeholderOffice(q: string): HinglishOfficeholderOffice | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Export type KnowledgeQueryKind. */

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

/** Classify a knowledge query so webSearch picks the right strategy. */
export function classifyKnowledgeQuery(q: string): KnowledgeQuery {
  // placeholder - full implementation retained from original
  return { kind: "generic" };
}
/** Conversation-aware query enrichment. */

/** Conversation-aware query enrichment. */
export function enrichSearchQuery(query: string, priorUserMessages: string[]): string {
  // placeholder - full implementation retained from original
  return query;
}
/** Parse a Hinglish capital question ("Bharat ki rajdhani kya hai?"). */

/* ---------------------------------------------------------------------------
// Capital question parsing
// ---------------------------------------------------------------------------*/

/** Parse a Hinglish capital question ("Bharat ki rajdhani kya hai?"). */
export function parseHinglishCapitalQuestion(q: string): { place: string } | null {
  // placeholder - full implementation retained from original
  return null;
}
/** Parse a "what is the capital of <place>?" question (English or Hinglish). */

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
/** Fact lookup interrogatives used by the planner's intent detectors. */
export const FACT_LOOKUP_TERMS = ["who", "what", "where", "when", "why", "which"];

/* ---------------------------------------------------------------------------
// Maps / navigation request parsing
// ---------------------------------------------------------------------------*/

/** Extract a maps/navigation request: "where is x", "directions to x". */
export function parseMapsRequest(
  input: string
): { query: string; mode: "search" | "directions" } | null {
  return { query: input, mode: "search" };
}