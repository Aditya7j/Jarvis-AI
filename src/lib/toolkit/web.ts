/**
 * Web-backed toolkit: currency conversion, web search and news. Every function
 * is network-facing, fails gracefully (returns `null` / throws a typed error)
 * and is cached so repeated questions never hit the network twice.
 */

import { getSystemClock } from "@/lib/time/time-service";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  at: number;
}

function cached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry.value;
}

export class ToolkitNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolkitNetworkError";
  }
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** ISO 4217 codes. */
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

export function normalizeCurrency(token: string): string | null {
  const clean = token.toLowerCase().replace(/[^a-z$€£¥₹]/g, "");
  if (clean.length === 0) return null;
  const code = CURRENCY_ALIASES[clean] ?? (clean.length === 3 ? clean.toUpperCase() : null);
  return code;
}

export interface CurrencyResult {
  amount: number;
  from: string;
  to: string;
  rate: number;
  converted: number;
  formatted: string;
  observedAt: string;
  source: string;
}

const currencyCache = new Map<string, CacheEntry<CurrencyResult>>();

/** Convert money using Frankfurter (ECB daily rates, keyless). */
export async function convertCurrency(
  amount: number,
  from: string,
  to: string,
  timeoutMs = 8_000,
  signal?: AbortSignal
): Promise<CurrencyResult> {
  const fromCode = normalizeCurrency(from);
  const toCode = normalizeCurrency(to);
  if (!fromCode || !toCode) {
    throw new ToolkitNetworkError(
      `Unrecognized currency "${!fromCode ? from : to}". Try codes like USD, EUR, INR.`
    );
  }
  if (fromCode === toCode) {
    return {
      amount,
      from: fromCode,
      to: toCode,
      rate: 1,
      converted: amount,
      formatted: `${amount.toLocaleString("en-US")} ${toCode}`,
      observedAt: getSystemClock().iso,
      source: "identity",
    };
  }
  const cacheKey = `${fromCode}:${toCode}`;
  const hit = cached(currencyCache, cacheKey);
  if (hit) {
    return {
      ...hit,
      amount,
      converted: round(hit.rate * amount),
      formatted: `${round(hit.rate * amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${toCode}`,
      observedAt: hit.observedAt,
    };
  }
  const url = `https://api.frankfurter.dev/v1/latest?base=${fromCode}&symbols=${toCode}`;
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  if (!res.ok) throw new ToolkitNetworkError(`Currency service responded with ${res.status}.`);
  const data = (await res.json()) as { date?: string; rates?: Record<string, number> };
  const rate = data.rates?.[toCode];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    throw new ToolkitNetworkError("Currency service returned no rate for that pair.");
  }
  const result: CurrencyResult = {
    amount,
    from: fromCode,
    to: toCode,
    rate: round(rate),
    converted: round(rate * amount),
    formatted: `${round(rate * amount).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${toCode}`,
    observedAt: data.date ?? getSystemClock().iso,
    source: "Frankfurter (ECB)",
  };
  currencyCache.set(cacheKey, { value: result, at: Date.now() });
  return result;
}

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

export interface SearchResult {
  query: string;
  heading: string | null;
  abstract: string | null;
  answer: string | null;
  source: string | null;
  url: string | null;
  topics: Array<{ text: string; url: string | null }>;
  engine: string;
}

const searchCache = new Map<string, CacheEntry<SearchResult>>();

/** Clear the web-search result cache (tests and cache-busting flows). */
export function invalidateSearchCache(): void {
  searchCache.clear();
}

/** Strip HTML tags and entities from a Wikipedia snippet fragment. */
function cleanHtmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Search fragments that are bibliographic/reference noise, never an answer. */
const JUNK_SNIPPET_RE =
  /\b(?:isbn|issn|doi\s*:|oclc\s*\d+|cite\s+(?:book|journal|web|news|magazine))\b/i;

/**
 * Whether a topic entry carries a real answer rather than a bare heading.
 * DuckDuckGo's RelatedTopics entries are "Title — Description" pairs; a topic
 * that is just a title ("Event loop", "Closure") is a heading, never an
 * answer. A long-enough passage is content even without the separator.
 */
export function isContentfulTopicText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[—–]/.test(t) || /\s-\s/.test(t)) return true;
  return t.length >= 40;
}

// ---------------------------------------------------------------------------
// Knowledge search ranking & answer extraction
//
// The raw MediaWiki search ordering is unusable as an answer: it ranks
// "Prime Minister's Office (India)" above "Prime Minister of India", and for
// ambiguous "current prime minister" queries it surfaces "List of prime
// ministers of Canada" — a list page, not an answer. We therefore rank hits
// ourselves and, when the question is a "who is the current X of Y?" office
// question, read the article's infobox `incumbent` field directly so the
// answer names the actual officeholder instead of pasting a snippet.
// ---------------------------------------------------------------------------

const SEARCH_STOPWORDS = new Set([
  "who", "what", "when", "where", "why", "how", "is", "are", "was", "were",
  "the", "of", "in", "on", "at", "for", "to", "a", "an", "and", "or", "it",
  "this", "that", "these", "those", "current", "currently", "please", "tell",
  "me", "about", "do", "does", "did", "can", "you", "give", "name", "list",
  "which", "has", "have", "as", "by", "with", "from", "be", "been", "being",
]);

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
  const m = q
    .toLowerCase()
    .trim()
    .match(/\bwho\s+is\s+(?:the\s+)?(?:current\s+)?(.+?)\s+of\s+(.+?)\s*[?.!]?\s*$/i);
  if (!m) return null;
  const office = m[1].trim();
  const place = m[2].trim();
  if (office.length < 3 || place.length < 2) return null;
  if (/\b(?:you|this|that|it|there)\b/.test(place)) return null;
  return { office, place };
}

/** The bare office label of a question ("who is the current prime minister?" → "prime minister"). */
export function officeLabelOf(q: string): string | null {
  const m = q
    .toLowerCase()
    .trim()
    .match(/\bwho\s+is\s+(?:the\s+)?(?:current\s+)?(.+?)\s*[?.]?\s*$/i);
  return m ? m[1].trim() : null;
}

/** Trailing noun phrase after the last "of", e.g. "what is the capital of france?" → "france". */
export function anchorOf(query: string): string | null {
  const m = query.toLowerCase().trim().match(/\bof\s+([a-z][a-z0-9\s-]{0,40})[?.]?\s*$/i);
  return m ? m[1].trim() : null;
}

/** Capitalized content words (proper nouns) in a question, ignoring the sentence-initial word. */
export function properNounsOf(query: string): string[] {
  const words = query.match(/[A-Z][a-zA-Z]+/g) ?? [];
  const first = query.trim().split(/\s+/)[0];
  return words.filter((w) => w !== first).map((w) => w.toLowerCase());
}

/** Unambiguous place aliases normalized to their Wikipedia article title. */
const PLACE_ALIASES: Record<string, string> = {
  usa: "United States",
  us: "United States",
  "u.s.": "United States",
  america: "United States",
  "united states of america": "United States",
  uk: "United Kingdom",
  "u.k.": "United Kingdom",
  britain: "United Kingdom",
  "great britain": "United Kingdom",
  uae: "United Arab Emirates",
  "u.a.e.": "United Arab Emirates",
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

/**
 * Rank-qualified officeholder questions ("who is/was the FIRST Sikh prime
 * minister of India?"). These can never be answered by the current-incumbent
 * infobox branch — answering a "first/last/previous" question with whoever
 * holds the office TODAY is the exact wrong-answer regression.
 */
const RANK_QUALIFIED_OFFICE =
  /\bwho\s+(?:is|was)\s+(?:the\s+)?(?:first|last|previous|former|next|oldest|youngest|earliest|latest|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;

/** Core office noun of a rank-qualified question ("...first sikh prime minister of india" → "minister"). */
export function officeNounOf(q: string): string | null {
  const m = q.toLowerCase().trim().match(
    /\bwho\s+(?:is|was)\s+(?:the\s+)?(?:first|last|previous|former|next|oldest|youngest|earliest|latest|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(.+?)\s+of\s+(.+?)\s*[?.!]?\s*$/
  );
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter((w) => w.length >= 3);
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
  const m = q
    .toLowerCase()
    .trim()
    .match(
      /\bwho\s+(?:is|was)\s+(?:the\s+)?(first|last|previous|former|next|oldest|youngest|earliest|latest|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(.+?)\s+of\s+(.+?)\s*[?.!]?\s*$/
    );
  if (!m) return null;
  const rank = m[1];
  const office = m[2].trim();
  const place = m[3].trim();
  if (office.length < 3 || place.length < 2) return null;
  if (/\b(?:you|this|that|it|there)\b/.test(place)) return null;
  const words = office.split(/\s+/).filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
  const officeNoun = words[words.length - 1] ?? "";
  return {
    rank,
    office,
    officeNoun,
    qualifiers: words.slice(0, -1),
    place,
    canonicalPlace: canonicalPlaceOf(place),
  };
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
  const rank = parseRankQualifiedOffice(q);
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
  const office = parseOfficeQuestion(q);
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

/**
 * Whether a title is the canonical "office of place" article: every office and
 * place token (typo-tolerant, edit distance 1) is covered by a distinct title
 * word. Returns the count of leftover non-stopword title words, which penalize
 * derivative titles like "Prime Minister of India Office".
 */
function canonicalCover(
  lowerTitle: string,
  officeTokens: string[],
  place: string
): { covered: boolean; extraWords: number } {
  const words = lowerTitle
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
  const target = [...officeTokens];
  if (place)
    target.push(...place.split(/\s+/).filter((t) => t.length >= 3 && !SEARCH_STOPWORDS.has(t)));
  if (target.length === 0) return { covered: false, extraWords: 0 };
  const used = new Array<boolean>(words.length).fill(false);
  for (const token of target) {
    let found = -1;
    for (let i = 0; i < words.length; i++) {
      if (used[i]) continue;
      if (
        words[i] === token ||
        (token.length >= 4 && words[i].length >= 4 && levenshtein(token, words[i]) <= 1)
      ) {
        found = i;
        break;
      }
    }
    if (found === -1) return { covered: false, extraWords: 0 };
    used[found] = true;
  }
  let extraWords = 0;
  for (let i = 0; i < words.length; i++) if (!used[i]) extraWords++;
  return { covered: true, extraWords };
}

function scoreOfficeHit(title: string, office: string, place: string): number {
  const lower = title.toLowerCase();
  let score = 0;
  const officeTokens = office.split(/\s+/).filter((t) => t.length >= 3);
  if (lower.startsWith(office)) score += 6;
  for (const token of officeTokens) {
    if (tokenInTitle(token, lower)) score += 3;
  }
  const cover = canonicalCover(lower, officeTokens, place);
  if (cover.covered) score += 30 - 8 * cover.extraWords;
  if (place && lower.includes(place)) score += 4;
  if (place && new RegExp(`\\bof\\s+${escapeRegExp(place)}\\b`).test(lower)) score += 3;
  if (/^list of\b/.test(lower)) score -= 15;
  if (/\b(?:disambiguation|index of|timeline of)\b/.test(lower)) score -= 12;
  score -= lower.length / 100;
  return score;
}

/**
 * Rank capital-question hits. "What is the capital of X?" is about the PLACE,
 * not the word "capital" — a keyword score matches "Capital punishment in
 * India" over the country itself. Anchoring on the place surfaces the article
 * that carries the `capital` infobox.
 */
function scoreCapitalHit(title: string, place: string): number {
  const lower = title.toLowerCase();
  let score = 0;
  const cover = canonicalCover(lower, [], place);
  if (cover.covered) score += 40 - 10 * cover.extraWords;
  const placeTokens = place.split(/\s+/).filter((t) => t.length >= 3 && !SEARCH_STOPWORDS.has(t));
  if (placeTokens.some((t) => lower.startsWith(t))) score += 6;
  if (place && new RegExp(`\\bof\\s+${escapeRegExp(place)}\\b`).test(lower)) score += 3;
  if (/^list of\b/.test(lower)) score -= 15;
  if (/\b(?:disambiguation|index of)\b/.test(lower)) score -= 12;
  score -= lower.length / 100;
  return score;
}

/** Title-case a place for display, keeping articles lowercase and acronyms uppercase. */
function displayPlace(place: string): string {
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

function scoreTitle(title: string, keywords: string[], anchors: string[], properNouns: string[]): number {
  const lower = title.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (lower.includes(keyword)) score += keyword.length;
  }
  for (const anchor of anchors) {
    if (lower.includes(anchor)) score += 15;
  }
  for (const noun of properNouns) {
    if (lower.includes(noun)) score += 10;
  }
  // The last content keyword is the subject of a "what is X?" question
  // ("closure" in "what is a javascript closure?"). A title that names it
  // directly is the answer even when a longer, more generic keyword
  // ("javascript") outranks it by raw length.
  const headNoun = keywords.length > 0 ? keywords[keywords.length - 1] : null;
  if (headNoun && lower.split(/[^a-z0-9]+/).includes(headNoun)) score += 15;
  // A title that LEADS with a content keyword is the canonical article for it
  // ("Closure (computer programming)"), while a brand-qualified derivative
  // ("Google Closure Tools") is not the subject the question asks about.
  if (keywords.some((kw) => kw.length >= 3 && lower.startsWith(kw))) score += 10;
  if (/^list of\b/.test(lower)) score -= 12;
  if (/\b(?:disambiguation|index of|timeline of)\b/.test(lower)) score -= 10;
  score -= lower.length / 100;
  return score;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function levenshtein(a: string, b: string): number {
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

/** Whether a token appears in a title, tolerating a one-character typo (edit distance 1). */
function tokenInTitle(token: string, lowerTitle: string): boolean {
  if (lowerTitle.includes(token)) return true;
  if (token.length < 4) return false;
  return lowerTitle.split(/[^a-z]+/).some((word) => word.length >= 4 && levenshtein(token, word) <= 1);
}

function capitalizeWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** MediaWiki search hits, lowest level. */
async function searchWikipedia(
  query: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Array<{ title: string; snippet: string; pageid: number }>> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
    `${encodeURIComponent(query)}&format=json&srlimit=5&utf8=1`;
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  if (!res.ok) throw new ToolkitNetworkError(`Search service responded with ${res.status}.`);
  const data = (await res.json()) as {
    query?: { search?: Array<{ title?: string; snippet?: string; pageid?: number }> };
  };
  return (data.query?.search ?? []).filter(
    (h) => h.title && h.title.trim().length > 0
  ) as Array<{ title: string; snippet: string; pageid: number }>;
}

/**
 * OpenSearch suggestions with redirects resolved — the "did you mean" channel.
 * Wikipedia's strict full-text search returns nothing for typo'd questions
 * ("prime misnister of india"), but the autocomplete API corrects them
 * ("Prime Minister (India)", "Prime ministers of India", …).
 */
async function opensearchSuggest(
  query: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=opensearch&search=` +
    `${encodeURIComponent(query)}&limit=5&redirects=resolve&format=json`;
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  if (!res.ok) throw new ToolkitNetworkError(`Search service responded with ${res.status}.`);
  const data = (await res.json()) as unknown;
  if (Array.isArray(data) && Array.isArray(data[1])) {
    return data[1].filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  }
  return [];
}

/** Full lead section (intro paragraphs) of an article, as clean text. */
async function fetchWikipediaLead(
  title: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&redirects=1` +
    `&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    query?: { pages?: Array<{ extract?: string }> };
  };
  return data.query?.pages?.[0]?.extract?.trim() || null;
}

/** Raw wikitext of an article — used to read the infobox `incumbent` field. */
async function fetchWikipediaWikitext(
  title: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string | null> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&redirects=1` +
    `&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> };
  };
  return data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? null;
}

/** Parse a "what is the capital of <place>?" question. */
export function parseCapitalQuestion(q: string): { place: string } | null {
  const m = q
    .toLowerCase()
    .trim()
    .match(/\bwhat\s+is\s+(?:the\s+)?capital\s+of\s+(.+?)\s*[?.]?\s*$/i);
  if (!m) return null;
  const place = m[1].trim();
  if (place.length < 2 || /\b(?:you|this|that|it|there)\b/.test(place)) return null;
  return { place };
}

/**
 * Extract an infobox field value, preferring the first wikilink.
 * Fields like `| incumbent = [[Narendra Modi]]` or `| capital = [[Paris]]`.
 */
export function extractInfoboxField(wikitext: string, field: string): string | null {
  const line = wikitext.match(new RegExp(`\\b${field}\\s*=\\s*([^\\n|]+)`, "i"));
  if (!line) return null;
  const raw = line[1].trim();
  const link = raw.match(/\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]/);
  const name = link
    ? link[1].trim()
    : raw
        .replace(/<ref[^>]*>.*?<\/ref>/g, "")
        .replace(/[\[\]{}<>]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  if (!name || /^file:/i.test(name)) return null;
  return name;
}

/** Extract the infobox `incumbent` value, preferring the first wikilink. */
export function extractIncumbentName(wikitext: string): string | null {
  return extractInfoboxField(wikitext, "incumbent");
}

/** Extract the infobox `capital` value, preferring the first wikilink. */
export function extractCapitalName(wikitext: string): string | null {
  return extractInfoboxField(wikitext, "capital");
}

/**
 * Fallback knowledge search — the MediaWiki API with our own result ranking.
 * The Instant Answer API returns nothing for most general factual queries and
 * the plain-HTML DuckDuckGo endpoints serve a JS-challenge page, so we query
 * Wikipedia directly. Keyless, reliable and a genuinely factual source;
 * returns null when nothing is usable.
 */
async function searchKnowledgeFallback(
  query: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SearchResult | null> {
  // Typo tolerance: if the raw question finds nothing (Wikipedia's full-text
  // search is strict — "prime misnister" returns zero hits), retry with the
  // content terms only, then with OpenSearch suggestions, whose autocomplete
  // "did you mean" behavior corrects the typo into the intended article titles.
  let hits = await searchWikipedia(query, timeoutMs, signal);
  if (hits.length === 0) {
    const terms = queryKeywords(query);
    if (terms.length) hits = await searchWikipedia(terms.join(" "), timeoutMs, signal);
  }
  if (hits.length === 0) {
    const suggestions = await opensearchSuggest(query, timeoutMs, signal).catch(() => []);
    const corrected =
      suggestions.length > 0
        ? suggestions
        : await opensearchSuggest(queryKeywords(query).join(" "), timeoutMs, signal).catch(() => []);
    if (corrected.length > 0) {
      hits = corrected.map((title) => ({ title, snippet: "", pageid: 0 }));
    }
  }
  if (hits.length === 0) return null;

  const parsed = parseOfficeQuestion(query);
  const officeLabel = officeLabelOf(query);
  const capitalQuestion = parseCapitalQuestion(query);
  const keywords = queryKeywords(query);
  const anchors = anchorOf(query) ? [anchorOf(query)!] : [];
  const nouns = properNounsOf(query);
  const ranked = [...hits].sort((a, b) => {
    if (parsed || officeLabel) {
      // Use the parse (office only, place separate) when available; the bare
      // office label is a greedy match that includes the place when present.
      const office = parsed ? parsed.office : (officeLabel ?? "");
      const place = parsed?.place ?? "";
      return scoreOfficeHit(b.title, office, place) - scoreOfficeHit(a.title, office, place);
    }
    if (capitalQuestion) {
      return (
        scoreCapitalHit(b.title, capitalQuestion.place) -
        scoreCapitalHit(a.title, capitalQuestion.place)
      );
    }
    return scoreTitle(b.title, keywords, anchors, nouns) - scoreTitle(a.title, keywords, anchors, nouns);
  });

  const topics: SearchResult["topics"] = [];
  for (const hit of ranked) {
    const text = cleanHtmlText(hit.snippet ?? "").slice(0, 200) || hit.title;
    if (JUNK_SNIPPET_RE.test(text)) continue;
    topics.push({
      text,
      url: hit.pageid
        ? `https://en.wikipedia.org/?curid=${hit.pageid}`
        : `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
    });
    if (topics.length >= 5) break;
  }
  const best = ranked[0];

  // Officeholder questions: read the article's infobox incumbent directly so
  // "who is the current prime minister of india" answers with the person.
  // Rank-qualified questions ("who is the FIRST x of y") are excluded — their
  // answer is never the current officeholder.
  if (parsed && !RANK_QUALIFIED_OFFICE.test(query)) {
    const wikitext = await fetchWikipediaWikitext(best.title, timeoutMs, signal).catch(() => null);
    const incumbent = wikitext ? extractIncumbentName(wikitext) : null;
    if (incumbent) {
      const officeDisplay =
        best.title.replace(/\s+of\s+.*$/i, "").trim() || capitalizeWords(parsed.office);
      return {
        query,
        heading: best.title,
        abstract: null,
        answer: `The current ${officeDisplay} of ${displayPlace(parsed.place)} is ${incumbent} (per Wikipedia).`,
        source: "Wikipedia",
        url: topics[0]?.url ?? null,
        topics,
        engine: "Wikipedia",
      };
    }
  }

  // Capital questions: rank the place's own article first and read its infobox
  // `capital` field directly, so "what is the capital of india" answers "New
  // Delhi" instead of matching the keyword "capital" to "Capital punishment in
  // India". If none of the ranked hits carries a `capital` infobox, search for
  // the place itself — its own article is what carries it.
  if (capitalQuestion) {
    // Normalize aliases ("usa" → "United States") so the place's own article —
    // the one carrying the `capital` infobox — is searched and scored under its
    // real name, and the answer displays the real name, never the alias.
    const place = canonicalPlaceOf(capitalQuestion.place) ?? capitalQuestion.place;
    const sorted = [...ranked].sort(
      (a, b) => scoreCapitalHit(b.title, place) - scoreCapitalHit(a.title, place)
    );
    const tryCapital = async (
      hits: Array<{ title: string }>
    ): Promise<{ title: string; capital: string } | null> => {
      for (const hit of hits) {
        const wikitext = await fetchWikipediaWikitext(hit.title, timeoutMs, signal).catch(() => null);
        const capital = wikitext ? extractCapitalName(wikitext) : null;
        if (capital) return { title: hit.title, capital };
      }
      return null;
    };
    let candidates = [...sorted];
    let found = await tryCapital(candidates.slice(0, 4));
    if (!found) {
      const originalCount = candidates.length;
      const placeHits = await searchWikipedia(place, timeoutMs, signal).catch(() => []);
      for (const h of placeHits) {
        if (!candidates.some((c) => c.title === h.title)) candidates.push(h);
      }
      found = await tryCapital(candidates.slice(originalCount));
    }
    if (found) {
      const placeDisplay =
        place.toLowerCase() === "united states" || place.toLowerCase() === "united kingdom"
          ? `the ${place}`
          : displayPlace(place);
      return {
        query,
        heading: found.title,
        abstract: null,
        answer: `The capital of ${placeDisplay} is ${found.capital} (per Wikipedia).`,
        source: "Wikipedia",
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(found.title.replace(/ /g, "_"))}`,
        topics,
        engine: "Wikipedia",
      };
    }
    // No article yielded a `capital` infobox — fall through to the lead path.
  }

  // Generic questions: fetch the FULL lead of the best article — a real
  // paragraph, not a 200-char search fragment from an unrelated page. When the
  // lead is unavailable and the fragment is bibliographic noise ("ISBN …"),
  // never paste it as an answer — move to the next ranked article's lead.
  let abstractTitle = best.title;
  let lead = await fetchWikipediaLead(best.title, timeoutMs, signal).catch(() => null);

  // Rank-qualified officeholder questions ("who was the FIRST x of y?") must
  // never be answered from a page that doesn't even mention the office — e.g.
  // a Sikh-demographics article for "…prime minister of India". Walk the
  // ranked list for the first article whose lead names the office; if none
  // does, return null so the caller defers to the reasoning model.
  if (RANK_QUALIFIED_OFFICE.test(query)) {
    const rankNoun = officeNounOf(query);
    if (rankNoun) {
      const mentionsOffice = (text: string | null) =>
        Boolean(text && text.toLowerCase().includes(rankNoun));
      if (!mentionsOffice(lead)) {
        lead = null;
        for (const hit of ranked.slice(1)) {
          const altLead = await fetchWikipediaLead(hit.title, timeoutMs, signal).catch(() => null);
          if (mentionsOffice(altLead)) {
            lead = altLead;
            abstractTitle = hit.title;
            break;
          }
        }
      }
      if (!lead) return null;
    }
  }
  const snippet = cleanHtmlText(best.snippet ?? "");
  if (!lead && snippet && JUNK_SNIPPET_RE.test(snippet)) {
    for (const hit of ranked.slice(1, 4)) {
      const altLead = await fetchWikipediaLead(hit.title, timeoutMs, signal).catch(() => null);
      if (altLead && !JUNK_SNIPPET_RE.test(altLead)) {
        lead = altLead;
        abstractTitle = hit.title;
        break;
      }
    }
  }
  const cleanSnippet = snippet && !JUNK_SNIPPET_RE.test(snippet) ? snippet : "";
  const body = lead || cleanSnippet;
  const abstract = body ? `${abstractTitle} — ${body.slice(0, 600)}` : null;
  if (!abstract && topics.length === 0) return null;
  return {
    query,
    heading: abstractTitle,
    abstract,
    answer: null,
    source: "Wikipedia",
    url: topics[0]?.url ?? null,
    topics,
    engine: "Wikipedia",
  };
}

/** DuckDuckGo Instant Answer API. Returns a best-effort factual snippet. */
export async function webSearch(
  query: string,
  timeoutMs = 8_000,
  signal?: AbortSignal
): Promise<SearchResult | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const hit = cached(searchCache, key);
  if (hit) return hit;
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=jarvis`;

  const isEmpty = (r: SearchResult | null): boolean =>
    !r || (!r.abstract && !r.answer && r.topics.length === 0);

  const cls = classifyKnowledgeQuery(query);

  let result: SearchResult | null = null;
  let ddgError: unknown = null;

  // Officeholder/capital questions are answered authoritatively from the
  // article's infobox ("The current Prime Minister of Canada is …"). A
  // DuckDuckGo abstract for those is a definition, not the name ("The prime
  // minister of Canada is the head of government…"), and letting it win the
  // race would abort the infobox answer. Run the Wikipedia fallback alone for
  // them; every other query (generic and rank-qualified) keeps the concurrent
  // race below.
  if (cls.kind === "officeholder" || cls.kind === "capital") {
    result = await searchKnowledgeFallback(query, timeoutMs, signal).catch(() => null);
  } else {
    // The Wikipedia fallback is independent of DuckDuckGo, and most factual
    // questions get no instant answer — start it concurrently so the fallback's
    // round-trips don't stack behind DuckDuckGo's. If DuckDuckGo answers, the
    // fallback is aborted and the instant answer is served immediately.
    const fallbackController = new AbortController();
    const onOuterAbort = () => fallbackController.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const fallbackPromise = searchKnowledgeFallback(query, timeoutMs, fallbackController.signal)
      .catch(() => null);

    try {
      const res = await fetchWithTimeout(url, timeoutMs, signal);
      if (!res.ok) throw new ToolkitNetworkError(`Search service responded with ${res.status}.`);
      let data: {
        AbstractText?: string;
        AbstractURL?: string;
        Heading?: string;
        Answer?: string;
        AbstractSource?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
      } | null = null;
      try {
        data = (await res.json()) as {
          AbstractText?: string;
          AbstractURL?: string;
          Heading?: string;
          Answer?: string;
          AbstractSource?: string;
          RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
        };
      } catch {
        // DuckDuckGo intermittently returns a truncated/empty body that cannot be
        // parsed as JSON. Treat it as "no instant answer" and fall through to the
        // Wikipedia fallback instead of surfacing a SyntaxError to the caller.
        data = null;
      }
      result = {
        query,
        heading: data?.Heading || null,
        abstract: data?.AbstractText || null,
        answer: data?.Answer || null,
        source: data?.AbstractSource || null,
        url: data?.AbstractURL || null,
        topics: buildTopics(data?.RelatedTopics ?? []),
        engine: "DuckDuckGo",
      };
    } catch (err) {
      ddgError = err;
    } finally {
      signal?.removeEventListener("abort", onOuterAbort);
    }

    // DuckDuckGo only wins when it actually answers THIS query: a
    // rank-qualified question needs content naming office + place + rank, and
    // a generic result needs real content, not a bare heading with title-only
    // topics. Otherwise the Wikipedia fallback continues.
    if (result && !isEmpty(result) && isSearchResultRelevant(result, cls)) {
      // The instant answer is relevant — cancel the concurrent fallback.
      fallbackController.abort();
    } else {
      const fallback = await fallbackPromise;
      if (fallback) result = fallback;
      else if (ddgError) throw ddgError;
      else result = null;
    }
  }
  if (isEmpty(result)) return null;
  if (!result) return null;
  // Rank-qualified results must name the office in the content we serve — an
  // unrelated page is worse than no result. The fallback already enforces this
  // internally; the gate here also guards the DuckDuckGo winner.
  if (cls.kind === "rank-qualified" && cls.officeNoun && !searchResultContent(result).includes(cls.officeNoun)) {
    return null;
  }
  searchCache.set(key, { value: result, at: Date.now() });
  return result;
}

function buildTopics(
  related: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
): SearchResult["topics"] {
  const topics: SearchResult["topics"] = [];
  for (const topic of related) {
    if (topic.Text && topic.FirstURL) {
      topics.push({ text: topic.Text.slice(0, 200), url: topic.FirstURL });
      if (topics.length >= 5) break;
    } else if (Array.isArray(topic.Topics)) {
      for (const sub of topic.Topics.slice(0, 5)) {
        if (sub.Text && sub.FirstURL) topics.push({ text: sub.Text.slice(0, 200), url: sub.FirstURL });
      }
    }
  }
  return topics;
}

/** Flatten a result's text fields into one lowercase searchable string. */
function searchResultContent(result: SearchResult): string {
  return `${result.heading ?? ""} ${result.abstract ?? ""} ${result.answer ?? ""} ${result.topics
    .map((t) => t.text)
    .join(" ")}`.toLowerCase();
}

/** Whether the result carries real content rather than a bare title/heading. */
function isContentfulResult(result: SearchResult): boolean {
  if (result.abstract?.trim() || result.answer?.trim()) return true;
  return result.topics.some((t) => isContentfulTopicText(t.text ?? ""));
}

/** Whether the place appears in the content, matching its canonical alias too. */
function contentMentionsPlace(content: string, place: string, canonical: string | null): boolean {
  const raw = place.toLowerCase().replace(/^the\s+/, "").trim();
  if (raw.length >= 3 && content.includes(raw)) return true;
  if (canonical && content.includes(canonical.toLowerCase())) return true;
  return false;
}

/**
 * Query-aware relevance gate: DuckDuckGo only wins the race when its content
 * actually answers the question asked. A rank-qualified question needs the
 * office, the place and the rank to all appear; a generic result only needs
 * to be real content rather than a heading with title-only topics.
 */
function isSearchResultRelevant(result: SearchResult, cls: KnowledgeQuery): boolean {
  if (cls.kind === "rank-qualified") {
    const content = searchResultContent(result);
    if (cls.officeNoun && !content.includes(cls.officeNoun)) return false;
    if (cls.place && !contentMentionsPlace(content, cls.place, cls.canonicalPlace ?? null)) return false;
    if (cls.rank && !content.includes(cls.rank.toLowerCase())) return false;
    if (
      cls.qualifiers &&
      cls.qualifiers.length > 0 &&
      !cls.qualifiers.some((q) => content.includes(q))
    ) {
      return false;
    }
    return true;
  }
  return isContentfulResult(result);
}

export interface NewsItem {
  title: string;
  url: string;
  score: number;
  author: string | null;
  time: string;
  comments: number;
}

const newsCache = new Map<string, CacheEntry<NewsItem[]>>();
const HN_STORIES_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
const HN_ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

/** Top Hacker News stories — a live, keyless news source. */
export async function fetchNews(
  limit = 8,
  timeoutMs = 8_000,
  signal?: AbortSignal
): Promise<NewsItem[]> {
  const key = `hn:${limit}`;
  const hit = cached(newsCache, key);
  if (hit) return hit;
  const res = await fetchWithTimeout(HN_STORIES_URL, timeoutMs, signal);
  if (!res.ok) throw new ToolkitNetworkError(`News service responded with ${res.status}.`);
  const ids = (await res.json()) as number[];
  // Story bodies are independent of each other — fetch them concurrently so the
  // news path is bounded by the slowest item, not the sum of all of them.
  const fetched = await Promise.all(
    ids.slice(0, limit).map(async (id) => {
      try {
        const itemRes = await fetchWithTimeout(HN_ITEM_URL(id), timeoutMs, signal);
        if (!itemRes.ok) return null;
        const item = (await itemRes.json()) as {
          title?: string;
          url?: string;
          score?: number;
          by?: string;
          time?: number;
          descendants?: number;
        };
        if (!item.title || item.title.toLowerCase().includes("show hn")) return null;
        return {
          title: item.title,
          url: item.url ?? `https://news.ycombinator.com/item?id=${id}`,
          score: item.score ?? 0,
          author: item.by ?? null,
          time: item.time
            ? new Date(item.time * 1000).toISOString()
            : getSystemClock().iso,
          comments: item.descendants ?? 0,
        } satisfies NewsItem;
      } catch {
        return null;
      }
    })
  );
  const items = fetched.filter((item): item is NewsItem => item !== null);
  if (items.length === 0) throw new ToolkitNetworkError("No news items available right now.");
  newsCache.set(key, { value: items, at: Date.now() });
  return items;
}

/** Google Maps link builders — deterministic, no network required. */
export function mapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function directionsUrl(from: string | null, to: string): string {
  const params = new URLSearchParams({ api: "1", destination: to });
  if (from) params.set("origin", from);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Extract a maps/navigation request: "where is x", "directions to x". */
export function parseMapsRequest(input: string): { query: string; mode: "search" | "directions" } | null {
  const text = input.toLowerCase().trim();
  const where = text.match(/\bwhere\s+is\s+(.+)$/i);
  if (where) return { query: where[1].trim(), mode: "search" };
  const directions = text.match(/\b(?:directions|route|navigate|how\s+do\s+i\s+get)\s+to\s+(.+)$/i);
  if (directions) return { query: directions[1].trim(), mode: "directions" };
  const map = text.match(/\bmap\s+of\s+(.+)$/i);
  if (map) return { query: map[1].trim(), mode: "search" };
  return null;
}

function round(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}
