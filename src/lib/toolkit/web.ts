/**
 * Web-backed toolkit: currency conversion, web search and news. Every function
 * is network-facing, fails gracefully (returns `null` / throws a typed error)
 * and is cached so repeated questions never hit the network twice.
 */

import { aiLogger, type Logger } from "@/lib/ai/logger";
import { getSystemClock } from "@/lib/time/time-service";

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Wikipedia's MediaWiki API rejects requests without a descriptive
 * User-Agent with HTTP 429. Node's default `fetch` sends none, which made
 * every Wikipedia call fail with "Search service responded with 429." and
 * silently killed the knowledge fallback. The UA is scoped to the Wikipedia
 * endpoints only — unrelated services (Frankfurter, DuckDuckGo, Hacker News)
 * are left on the plain, unchanged request path.
 */
const HTTP_USER_AGENT =
  "JarvisAI/1.0 (personal assistant; knowledge retrieval; https://github.com/anomalyco/opencode)";

/** MediaWiki API request headers — sent only on en.wikipedia.org calls. */
const WIKIPEDIA_HEADERS: Record<string, string> = {
  "User-Agent": HTTP_USER_AGENT,
  Accept: "application/json",
};

const knowledgeLog = aiLogger.child("knowledge");

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
  signal?: AbortSignal,
  headers?: Record<string, string>
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await fetch(url, {
      signal: controller.signal,
      ...(headers ? { headers } : {}),
    });
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

export const searchCache = new Map<string, CacheEntry<SearchResult>>();

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
// ourselves and, for "who is the current X of Y?" officeholder questions
// (English and Hinglish alike), answer ONLY from a validated office/place
// article's infobox `incumbent` field.
//
// Invariant: officeholder -> incumbent extraction only. An officeholder query
// must never produce an article lead, a generic Wikipedia abstract, a
// RelatedTopics text, an arbitrary search result or an LLM-generated answer.
// Discovery (search hits, canonical query, canonical title) is never proof of
// relevance; every candidate passes isOfficeholderCandidate before its
// infobox is read, and no incumbent means null — never a generic lead.
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

/**
 * Core office noun of a rank-qualified question ("...first sikh prime minister of india" → "minister").
 */
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
};

/** Expand a Hinglish/Hindi office phrase to the English phrase article content uses. */
function expandHinglishOffice(office: string): string {
  for (const [hing, eng] of Object.entries(HINGLISH_OFFICE_EXPANSIONS)) {
    const re = new RegExp(`\\b${hing.replace(/\s+/g, "\\s+")}\\b`);
    if (re.test(office)) return office.replace(re, eng);
  }
  return office;
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
  const text = q.toLowerCase().trim();
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
  const text = q.toLowerCase().trim();
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

/**
 * MediaWiki search hits, lowest level. The result limit is bounded and
 * defaults to 5 for every caller; rank-qualified discovery passes a larger
 * bounded limit so candidates below the generic top-5 (e.g. Manmohan Singh
 * at ~rank 10 for "Sikh prime minister India") are still discovered.
 */
async function searchWikipedia(
  query: string,
  timeoutMs: number,
  signal?: AbortSignal,
  limit = 5
): Promise<Array<{ title: string; snippet: string; pageid: number }>> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=` +
    `${encodeURIComponent(query)}&format=json&srlimit=${limit}&utf8=1`;
  const res = await fetchWithTimeout(url, timeoutMs, signal, WIKIPEDIA_HEADERS);
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
  const res = await fetchWithTimeout(url, timeoutMs, signal, WIKIPEDIA_HEADERS);
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
  const res = await fetchWithTimeout(url, timeoutMs, signal, WIKIPEDIA_HEADERS);
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
  const res = await fetchWithTimeout(url, timeoutMs, signal, WIKIPEDIA_HEADERS);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> };
  };
  return data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? null;
}

/**
 * Parse a Hinglish capital question ("Bharat ki rajdhani kya hai?") into the
 * same shape as the English "what is the capital of <place>?" — place only.
 * Both the canonical order ("<place> ki rajdhani kya hai?") and the topicalized
 * order ("kya hai <place> ki rajdhani?") are accepted. Only the WHAT
 * interrogative ("kya hai/hain") matches — "kaun hai" (who) is a person
 * question, never a capital fact. Returns null for anything else.
 */
export function parseHinglishCapitalQuestion(q: string): { place: string } | null {
  const text = q.toLowerCase().trim();
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
  const english = q
    .toLowerCase()
    .trim()
    .match(/\bwhat\s+is\s+(?:the\s+)?capital\s+of\s+(.+?)\s*[?.]?\s*$/i);
  if (english) {
    const place = english[1].trim();
    if (place.length < 2 || /\b(?:you|this|that|it|there)\b/.test(place)) return null;
    return { place };
  }
  return parseHinglishCapitalQuestion(q);
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

export interface ValidatedOfficeholderArticle {
  title: string;
  incumbent: string;
}

/**
 * Title gate for officeholder candidates — the relevance PROOF that a search
 * hit actually represents the requested "office of place". Every office token
 * and the place (canonical alias preferred) must be covered by the title, and
 * the title must not be a list, disambiguation or administrative-body page.
 * "Palak Muchhal Sharma" shares no office token and is rejected; "Prime
 * Minister of India" validates. Wikipedia search ordering is discovery only —
 * never relevance — so no hit is read for its incumbent until it passes here.
 */
export function isOfficeholderCandidate(
  title: string,
  office: string,
  place: string,
  canonicalPlace: string | null
): boolean {
  const lower = title.toLowerCase();
  if (/^list of\b/.test(lower)) return false;
  if (/\b(?:disambiguation|index of|timeline of|office)\b/.test(lower)) return false;
  const officeTokens = office.split(/\s+/).filter((t) => t.length >= 3);
  if (officeTokens.length === 0) return false;
  const placeForTitle = canonicalPlace ?? place;
  const cover = canonicalCover(lower, officeTokens, placeForTitle);
  if (!cover.covered) return false;
  // The canonical officeholder article is exactly the office + place; leftover
  // title words ("office", "in", qualifiers, suffixes) mark an administrative
  // or derivative page that does not carry the officeholder's incumbent.
  if (cover.extraWords > 0) return false;
  return true;
}

/**
 * Structured retrieval for officeholder questions. Builds the canonical
 * English "office + place" retrieval query from the CLASSIFIED structure
 * (never the raw question), discovers candidates through Wikipedia search —
 * the raw question, the canonical query and the exact canonical article title
 * are all DISCOVERY ONLY — validates every candidate title against the
 * requested office/place relationship, and reads the infobox `incumbent` of
 * validated articles. Returns only a verified article + incumbent pair, or
 * null when no candidate is trustworthy. Never falls through to a generic
 * lead: an unvalidated candidate is no answer, period.
 */
export async function findValidatedOfficeholderArticle(
  query: string,
  office: string,
  place: string,
  canonicalPlace: string | null,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<ValidatedOfficeholderArticle | null> {
  const log = knowledgeLog.child("officeholder");
  const placeForSearch = canonicalPlace ?? place;
  const canonicalQuery = `${office} ${placeForSearch}`;
  const canonicalTitle = `${capitalizeWords(office)} of ${displayPlace(placeForSearch)}`;

  const candidates: Array<{ title: string; snippet: string; pageid: number }> = [];
  const collect = (hits: Array<{ title: string; snippet: string; pageid: number }>) => {
    for (const h of hits) {
      if (!candidates.some((c) => c.title === h.title)) candidates.push(h);
    }
  };

  log.info("officeholder retrieval start", {
    kind: "officeholder",
    query,
    office,
    place,
    canonicalPlace,
    canonicalQuery,
    canonicalTitle,
  });

  // Discovery — search ranking proves nothing about relevance; every hit below
  // must survive isOfficeholderCandidate before its infobox is read.
  collect(await searchWikipedia(query, timeoutMs, signal).catch(() => []));
  collect(await searchWikipedia(canonicalQuery, timeoutMs, signal).catch(() => []));
  collect(await searchWikipedia(canonicalTitle, timeoutMs, signal).catch(() => []));
  const rawSuggestions = await opensearchSuggest(query, timeoutMs, signal).catch(() => []);
  collect(rawSuggestions.map((title) => ({ title, snippet: "", pageid: 0 })));
  const canonicalSuggestions = await opensearchSuggest(canonicalQuery, timeoutMs, signal).catch(() => []);
  collect(canonicalSuggestions.map((title) => ({ title, snippet: "", pageid: 0 })));
  log.info("officeholder candidates", { titles: candidates.map((c) => c.title) });

  const rejected = candidates
    .filter((c) => !isOfficeholderCandidate(c.title, office, place, canonicalPlace))
    .map((c) => c.title);
  if (rejected.length > 0) {
    log.info("officeholder rejected", { rejected });
  }

  const validated = candidates
    .filter((c) => isOfficeholderCandidate(c.title, office, place, canonicalPlace))
    .sort(
      (a, b) =>
        scoreOfficeHit(b.title, office, placeForSearch) -
        scoreOfficeHit(a.title, office, placeForSearch)
    );
  if (validated.length === 0) {
    log.info("officeholder no validated candidate", {
      canonicalQuery,
      candidateTitles: candidates.map((c) => c.title),
    });
    return null;
  }
  log.info("officeholder validated candidates", { titles: validated.map((c) => c.title) });

  for (const candidate of validated) {
    const wikitext = await fetchWikipediaWikitext(candidate.title, timeoutMs, signal).catch(
      () => null
    );
    const incumbent = wikitext ? extractIncumbentName(wikitext) : null;
    if (incumbent) {
      log.info("officeholder selected", { title: candidate.title, incumbent, source: "Wikipedia" });
      return { title: candidate.title, incumbent };
    }
    log.info("officeholder rejected no incumbent", { title: candidate.title });
  }
  log.info("officeholder unverifiable", { validated: validated.map((c) => c.title) });
  return null;
}

// ---------------------------------------------------------------------------
// Rank-qualified retrieval — bounded parallel discovery, NOT ranking.
//
// The old pipeline searched the RAW question and only ran the canonical
// "office + place" discovery search when the raw question returned zero hits.
// "Who was the first Sikh Prime Minister of India?" returns unrelated hits
// (e.g. "Khalistan movement"), so hits.length > 0, the canonical discovery
// was skipped, validation correctly rejected Khalistan, and the biography
// (Manmohan Singh) was never discovered — null.
//
// Discovery now ALWAYS runs a small fixed set of queries derived from the
// classified structure (raw, office+place, rank+office+place, qualifier forms
// and the canonical article title) CONCURRENTLY, merges and deduplicates the
// candidate titles, and only then runs the existing relationship validation.
// Search ranking is discovery only — it never decides the answer.
// ---------------------------------------------------------------------------

/** Canonical article-oriented title for a rank-qualified office, e.g. "Sikh Prime Minister of India". */
function rankQualifiedCanonicalTitle(rq: KnowledgeQuery): string {
  const office = rq.office?.trim() ?? "";
  const placeForTitle = rq.canonicalPlace ?? rq.place ?? "";
  return `${capitalizeWords(office)} of ${displayPlace(placeForTitle)}`.trim();
}

/**
 * The bounded stage-1 discovery query set for a rank-qualified question,
 * derived entirely from the classified structure — never country-specific.
 * Returns at most 5 deduplicated queries.
 */
export function buildRankQualifiedDiscoveryQueries(query: string, rq: KnowledgeQuery): string[] {
  const rank = rq.rank ?? "";
  const office = rq.office?.trim() ?? "";
  const officeNoun = rq.officeNoun ?? "";
  const qualifiers = rq.qualifiers ?? [];
  const placeForSearch = rq.canonicalPlace ?? rq.place ?? "";
  const raw = query.trim();

  const queries = [
    raw,
    `${office} ${placeForSearch}`,
    `${rank} ${office} ${placeForSearch}`,
    `${qualifiers.join(" ")} ${officeNoun} ${placeForSearch}`,
    rankQualifiedCanonicalTitle(rq),
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of queries) {
    const q = candidate.replace(/\s+/g, " ").trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * The bounded stage-2 discovery queries — the strongest semantic forms,
 * used ONLY when stage-1 produced no validated candidate. Queries that are
 * byte-identical to a stage-1 query are skipped (already searched).
 */
function buildRankQualifiedStageTwoQueries(rq: KnowledgeQuery, stageOne: string[]): string[] {
  const rank = rq.rank ?? "";
  const officeNoun = rq.officeNoun ?? "";
  const qualifiers = rq.qualifiers ?? [];
  const placeForSearch = rq.canonicalPlace ?? rq.place ?? "";
  const stageOneKeys = new Set(stageOne.map((q) => q.toLowerCase()));

  const candidates = [
    `${qualifiers.join(" ")} ${officeNoun} ${placeForSearch}`,
    `${rank} ${qualifiers.join(" ")} ${officeNoun} ${placeForSearch}`,
  ];
  const out: string[] = [];
  for (const candidate of candidates) {
    const q = candidate.replace(/\s+/g, " ").trim();
    if (!q) continue;
    const key = q.toLowerCase();
    if (stageOneKeys.has(key)) continue;
    stageOneKeys.add(key);
    out.push(q);
  }
  return out;
}

/**
 * Run the bounded discovery queries CONCURRENTLY and merge their hits,
 * deduplicating by title, then cap the merged set at
 * MAX_RANK_QUALIFIED_CANDIDATES. The per-query `limit` bounds each semantic
 * search (10 for rank-qualified); the merged cap is deterministic (query
 * order) and never exceeds the total candidate bound. Failures degrade to an
 * empty contribution; the bounded query set keeps request count fixed.
 */
const MAX_RANK_QUALIFIED_CANDIDATES = 20;
const RANK_QUALIFIED_DISCOVERY_LIMIT = 10;

async function discoverySearch(
  queries: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  limit = 5
): Promise<Array<{ title: string; snippet: string; pageid: number }>> {
  const results = await Promise.all(
    queries.map((query) => searchWikipedia(query, timeoutMs, signal, limit).catch(() => []))
  );
  const seen = new Set<string>();
  const merged: Array<{ title: string; snippet: string; pageid: number }> = [];
  for (const hits of results) {
    for (const hit of hits) {
      if (!hit.title || !hit.title.trim()) continue;
      if (seen.has(hit.title)) continue;
      seen.add(hit.title);
      merged.push(hit);
      if (merged.length >= MAX_RANK_QUALIFIED_CANDIDATES) break;
    }
    if (merged.length >= MAX_RANK_QUALIFIED_CANDIDATES) break;
  }
  return merged;
}

interface RankQualifiedChosen {
  title: string;
  evidence: string;
}

/**
 * Validate + walk rank-qualified candidates. Every candidate is filtered by
 * isRankQualifiedPersonTitle, ordered by title score, then walked for the
 * first whose lead PROVES the requested relationship via
 * contentSupportsRankQualified + relationshipEvidence. `checkedTitles`
 * prevents re-fetching leads already walked by an earlier stage.
 */
async function walkRankQualifiedCandidates(
  candidates: Array<{ title: string; snippet: string; pageid: number }>,
  rq: KnowledgeQuery,
  checkedTitles: Set<string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RankQualifiedChosen | null> {
  const log = knowledgeLog.child("rank-qualified");
  const office = rq.office ?? "";
  const placeForSearch = rq.canonicalPlace ?? rq.place ?? "";

  const titleRejected = candidates
    .filter((c) => !isRankQualifiedPersonTitle(c.title))
    .map((c) => c.title);
  if (titleRejected.length > 0) {
    log.info("rank-qualified title-rejected candidates", { rejected: titleRejected });
  }

  const persons = candidates
    .filter((c) => isRankQualifiedPersonTitle(c.title))
    .sort(
      (a, b) =>
        scoreOfficeHit(b.title, office, placeForSearch) -
        scoreOfficeHit(a.title, office, placeForSearch)
    );
  if (persons.length === 0) {
    log.info("rank-qualified no person candidates", {
      candidates: candidates.map((c) => c.title),
    });
    return null;
  }

  const terms = rankQualifiedEvidenceTerms(rq);
  for (const candidate of persons) {
    if (checkedTitles.has(candidate.title)) continue;
    checkedTitles.add(candidate.title);
    const candidateLead = await fetchWikipediaLead(candidate.title, timeoutMs, signal).catch(
      () => null
    );
    const supports = contentSupportsRankQualified((candidateLead ?? "").toLowerCase(), rq);
    log.info("rank-qualified lead candidate", {
      title: candidate.title,
      relationshipSupported: supports,
    });
    if (!supports) continue;
    const evidence = relationshipEvidence(candidateLead ?? "", terms, RANK_QUALIFIED_EVIDENCE_WINDOW);
    if (evidence) {
      log.info("rank-qualified selected", { title: candidate.title, evidence });
      return { title: candidate.title, evidence };
    }
    log.info("rank-qualified relationship evidence absent", { title: candidate.title });
  }
  log.info("rank-qualified no validated candidate", { walked: [...checkedTitles] });
  return null;
}

interface RankQualifiedAnswer {
  title: string;
  evidence: string;
  candidates: Array<{ title: string; snippet: string; pageid: number }>;
}

/**
 * Structured retrieval for rank-qualified questions ("who was the FIRST x of
 * y?", "x ka pehla … kaun tha?"). Runs bounded concurrent discovery (stage 1),
 * merges + deduplicates candidates, validates and walks them. Only when stage-1
 * yields no validated relationship does a second bounded discovery (stage 2)
 * run with the strongest semantic query forms; the SAME validation applies.
 * Returns null only after every bounded discovery strategy is exhausted.
 */
async function findRankQualifiedAnswer(
  query: string,
  rq: KnowledgeQuery,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RankQualifiedAnswer | null> {
  const log = knowledgeLog.child("rank-qualified");
  log.info("rank-qualified retrieval start", {
    kind: "rank-qualified",
    query,
    rank: rq.rank,
    office: rq.office,
    officeNoun: rq.officeNoun,
    qualifiers: rq.qualifiers,
    place: rq.place,
    canonicalPlace: rq.canonicalPlace,
  });

  const stageOneQueries = buildRankQualifiedDiscoveryQueries(query, rq);
  log.info("rank-qualified discovery queries", { stageOneQueries });

  let candidates = await discoverySearch(
    stageOneQueries,
    timeoutMs,
    signal,
    RANK_QUALIFIED_DISCOVERY_LIMIT
  );
  log.info("rank-qualified discovery candidates", { titles: candidates.map((c) => c.title) });

  const checkedTitles = new Set<string>();
  let chosen = await walkRankQualifiedCandidates(candidates, rq, checkedTitles, timeoutMs, signal);

  if (!chosen) {
    const stageTwoQueries = buildRankQualifiedStageTwoQueries(rq, stageOneQueries);
    if (stageTwoQueries.length > 0) {
      log.info("rank-qualified stage-2 discovery queries", { stageTwoQueries });
      const stageTwo = await discoverySearch(
        stageTwoQueries,
        timeoutMs,
        signal,
        RANK_QUALIFIED_DISCOVERY_LIMIT
      );
      const fresh = stageTwo.filter((hit) => !candidates.some((c) => c.title === hit.title));
      log.info("rank-qualified stage-2 discovery candidates", {
        titles: fresh.map((c) => c.title),
      });
      // Keep total discovery bounded at MAX_RANK_QUALIFIED_CANDIDATES across
      // both stages. Fresh stage-2 titles are the ones not yet validated, so
      // they are preserved first; already-walked stage-1 titles are skipped by
      // the walk anyway.
      const prior = candidates;
      candidates = fresh.concat(prior).slice(0, MAX_RANK_QUALIFIED_CANDIDATES);
      chosen = await walkRankQualifiedCandidates(candidates, rq, checkedTitles, timeoutMs, signal);
    }
  }

  if (!chosen) {
    log.info("rank-qualified no trustworthy evidence", { query, exhausted: true });
    return null;
  }
  log.info("rank-qualified final result", { query, title: chosen.title });
  return { ...chosen, candidates };
}

// ---------------------------------------------------------------------------
// Capital retrieval — bounded discovery, NOT ranking.
//
// "What is the capital of X?" is about the PLACE: its own article carries the
// infobox `capital` field. The raw question's Wikipedia hits ("Capital
// punishment in India", "National Capital Region …") may not include the place
// article, or include it at an arbitrary rank — so discovery ALWAYS searches
// the raw question AND the canonical place article, merges and deduplicates
// the titles, scores them with the existing capital scoring, prefers the exact
// canonical article, and checks a bounded number of infoboxes for `capital`.
// If search never surfaced the place article, the canonical title is fetched
// directly through the existing MediaWiki API (redirects resolved). Discovery
// never decides the answer: only an infobox `capital` field is accepted, and
// null is returned honestly when no bounded strategy yields one.
// ---------------------------------------------------------------------------

/** Bounded number of candidates whose infobox may be read for a capital query. */
const MAX_CAPITAL_CANDIDATES = 8;

interface CapitalArticle {
  title: string;
  capital: string;
}

/** Read the `capital` infobox of each candidate in order; first hit wins. */
async function readCapitalCandidates(
  candidates: Array<{ title: string }>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  log: Logger
): Promise<CapitalArticle | null> {
  for (const candidate of candidates) {
    const wikitext = await fetchWikipediaWikitext(candidate.title, timeoutMs, signal).catch((err) => {
      log.warn("capital wikitext fetch failed", {
        title: candidate.title,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    const capital = wikitext ? extractCapitalName(wikitext) : null;
    log.info("capital candidate checked", {
      title: candidate.title,
      wikitextFetched: Boolean(wikitext),
      capital,
    });
    if (capital) return { title: candidate.title, capital };
  }
  return null;
}

/**
 * Bounded, rank-independent capital discovery. Searches the raw question and
 * the canonical place ("India", "United States") in parallel, merges +
 * deduplicates the hits, scores them with the existing capital scoring, moves
 * the exact canonical article to the front when present, and reads the
 * `capital` infobox of at most MAX_CAPITAL_CANDIDATES. When search never
 * surfaced the canonical article, it is fetched directly by title. Failures at
 * any stage are logged and degrade to an empty contribution; only an infobox
 * `capital` field is accepted as the answer.
 */
async function findCapitalArticle(
  query: string,
  place: string,
  canonicalPlace: string | null,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<CapitalArticle | null> {
  const log = knowledgeLog.child("capital");
  const placeForSearch = canonicalPlace ?? place;
  const canonicalTitle = displayPlace(placeForSearch);
  log.info("capital retrieval start", {
    kind: "capital",
    query,
    place,
    canonicalPlace,
    placeForSearch,
    canonicalTitle,
  });

  const rawHits = await searchWikipedia(query, timeoutMs, signal).catch((err) => {
    log.warn("capital raw-query search failed", {
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return [] as Array<{ title: string; snippet: string; pageid: number }>;
  });
  const placeHits = await searchWikipedia(placeForSearch, timeoutMs, signal).catch((err) => {
    log.warn("capital canonical-place search failed", {
      place: placeForSearch,
      error: err instanceof Error ? err.message : String(err),
    });
    return [] as Array<{ title: string; snippet: string; pageid: number }>;
  });
  log.info("capital discovery hits", {
    rawQuery: query,
    raw: rawHits.map((h) => h.title),
    canonicalQuery: placeForSearch,
    place: placeHits.map((h) => h.title),
  });

  const seen = new Set<string>();
  const merged: Array<{ title: string; snippet: string; pageid: number }> = [];
  for (const hit of [...rawHits, ...placeHits]) {
    if (!hit.title || !hit.title.trim()) continue;
    if (seen.has(hit.title)) continue;
    seen.add(hit.title);
    merged.push(hit);
  }
  const scored = [...merged].sort(
    (a, b) => scoreCapitalHit(b.title, placeForSearch) - scoreCapitalHit(a.title, placeForSearch)
  );
  // Prefer the exact canonical place article: it is the one guaranteed to
  // carry the requested place's `capital` infobox.
  const exactIndex = scored.findIndex(
    (c) => c.title.toLowerCase() === canonicalTitle.toLowerCase()
  );
  if (exactIndex > 0) {
    const [exact] = scored.splice(exactIndex, 1);
    scored.unshift(exact);
  }
  log.info("capital ranked candidates", { titles: scored.map((c) => c.title) });

  const bounded = scored.slice(0, MAX_CAPITAL_CANDIDATES);
  const found = await readCapitalCandidates(bounded, timeoutMs, signal, log);
  if (found) {
    log.info("capital selected", { title: found.title, capital: found.capital, source: "search discovery" });
    return found;
  }

  // Search never surfaced (or never validated) the canonical article — fetch
  // it directly through the existing MediaWiki API, which resolves redirects.
  const direct = await readCapitalCandidates([{ title: canonicalTitle }], timeoutMs, signal, log);
  if (direct) {
    log.info("capital selected", {
      title: direct.title,
      capital: direct.capital,
      source: "direct canonical lookup",
    });
    return direct;
  }

  log.info("capital unverifiable", {
    checked: bounded.map((c) => c.title),
    canonicalTitle,
    exhausted: true,
  });
  return null;
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
  cls: KnowledgeQuery,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SearchResult | null> {
  // Officeholder questions are answered ONLY from a validated office/place
  // article's infobox incumbent — never from an arbitrary search hit, a
  // generic lead, or a model guess. The raw question, the canonical
  // "office + place" query and the exact canonical title are all discovery;
  // every candidate must survive isOfficeholderCandidate before its infobox
  // is read, and no incumbent means null (never a generic Wikipedia answer).
  if (cls.kind === "officeholder") {
    if (!cls.office || !cls.place) return null;
    const article = await findValidatedOfficeholderArticle(
      query,
      cls.office,
      cls.place,
      cls.canonicalPlace ?? null,
      timeoutMs,
      signal
    );
    if (!article) return null;
    const officeDisplay =
      article.title.replace(/\s+of\s+.*$/i, "").trim() || capitalizeWords(cls.office);
    const placeDisplayBase = displayPlace(cls.place);
    const placeDisplay = /^[A-Z]{2,4}$/.test(placeDisplayBase)
      ? `the ${placeDisplayBase}`
      : placeDisplayBase;
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, "_"))}`;
    return {
      query,
      heading: article.title,
      abstract: null,
      answer: `The current ${officeDisplay} of ${placeDisplay} is ${article.incumbent} (per Wikipedia).`,
      source: "Wikipedia",
      url,
      topics: [{ text: article.title, url }],
      engine: "Wikipedia",
    };
  }

  // Rank-qualified questions ("who was the FIRST x of y?", "x ka pehla … kaun
  // tha?") run bounded CONCURRENT discovery — the raw question, the canonical
  // office + place query, the rank + office + place query, the qualifier forms
  // and the canonical article title are ALL searched in parallel, merged and
  // deduplicated. Discovery never decides the answer: every candidate still
  // passes isRankQualifiedPersonTitle + contentSupportsRankQualified and the
  // proving sentence becomes the evidence. Only after both bounded discovery
  // stages are exhausted may the result be null (honest unavailable).
  if (cls.kind === "rank-qualified") {
    const answer = await findRankQualifiedAnswer(query, cls, timeoutMs, signal);
    if (!answer) return null;
    const office = cls.office ?? "";
    const placeForSearch = cls.canonicalPlace ?? cls.place ?? "";
    const rankedCandidates = [...answer.candidates].sort(
      (a, b) =>
        scoreOfficeHit(b.title, office, placeForSearch) -
        scoreOfficeHit(a.title, office, placeForSearch)
    );
    const topics: SearchResult["topics"] = [];
    for (const hit of rankedCandidates) {
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
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(answer.title.replace(/ /g, "_"))}`;
    return {
      query,
      heading: answer.title,
      abstract: `${answer.title} — ${answer.evidence.slice(0, 600)}`,
      answer: null,
      source: "Wikipedia",
      url,
      topics,
      engine: "Wikipedia",
    };
  }

  // Capital questions ("what is the capital of X?", "X ki rajdhani kya hai?")
  // are answered ONLY from the place article's infobox `capital` field — never
  // from an unrelated search snippet, "Capital punishment in X", a generic
  // lead or a model guess. Bounded discovery searches the raw question AND the
  // canonical place, merges + deduplicates + scores the candidates, prefers the
  // exact canonical article and reads at most MAX_CAPITAL_CANDIDATES infoboxes;
  // when search never surfaced the place article it is fetched directly. No
  // capital field anywhere means null — honest unavailable.
  if (cls.kind === "capital") {
    if (!cls.place) return null;
    const article = await findCapitalArticle(
      query,
      cls.place,
      cls.canonicalPlace ?? null,
      timeoutMs,
      signal
    );
    if (!article) return null;
    const place = cls.canonicalPlace ?? cls.place;
    const placeDisplay =
      place.toLowerCase() === "united states" || place.toLowerCase() === "united kingdom"
        ? `the ${place}`
        : displayPlace(place);
    const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(article.title.replace(/ /g, "_"))}`;
    return {
      query,
      heading: article.title,
      abstract: null,
      answer: `The capital of ${placeDisplay} is ${article.capital} (per Wikipedia).`,
      source: "Wikipedia",
      url,
      topics: [{ text: article.title, url }],
      engine: "Wikipedia",
    };
  }

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
  const keywords = queryKeywords(query);
  const anchors = anchorOf(query) ? [anchorOf(query)!] : [];
  const nouns = properNounsOf(query);
  const ranked = [...hits].sort((a, b) => {
    if (parsed || officeLabel) {
      // Use the parse (office only, place separate) when available; the bare
      // office label is a greedy match that includes the place when present.
      const office = parsed ? parsed.office : (officeLabel ?? "");
      const place = parsed?.place ?? cls.place ?? "";
      return scoreOfficeHit(b.title, office, place) - scoreOfficeHit(a.title, office, place);
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

  // Generic questions: fetch the FULL lead of the best article — a real
  // paragraph, not a 200-char search fragment from an unrelated page. When the
  // lead is unavailable and the fragment is bibliographic noise ("ISBN …"),
  // never paste it as an answer — move to the next ranked article's lead.
  let abstractTitle = best.title;
  let resultUrl: string | null = null;
  let lead: string | null = null;
  lead = await fetchWikipediaLead(best.title, timeoutMs, signal).catch(() => null);
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
    url: resultUrl ?? topics[0]?.url ?? null,
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
  // Classify BEFORE any cache read. A cached result created under an earlier,
  // weaker implementation could otherwise bypass the current classification
  // and its semantic gates — e.g. a stale generic Wikipedia page for what is
  // now an officeholder question. Every cache hit is validated against the
  // CURRENT classification; a hit that no longer holds is dropped and the
  // fresh path is re-run (never served, never sent to the LLM).
  const cls = classifyKnowledgeQuery(query);
  const hit = cached(searchCache, key);
  if (hit) {
    if (cachedResultValidFor(hit, cls, query)) return hit;
    searchCache.delete(key);
  }
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=jarvis`;

  const isEmpty = (r: SearchResult | null): boolean =>
    !r || (!r.abstract && !r.answer && r.topics.length === 0);

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
    result = await searchKnowledgeFallback(query, cls, timeoutMs, signal).catch((err) => {
      // Never swallow the failure silently — the caller may still return an
      // honest unavailable reply, but the log must identify WHICH stage broke
      // (Wikipedia search, article fetch, parsing, extraction or validation).
      knowledgeLog.error("knowledge fallback failed", {
        kind: cls.kind,
        query,
        name: err instanceof Error ? err.name : undefined,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
  } else {
    // The Wikipedia fallback is independent of DuckDuckGo, and most factual
    // questions get no instant answer — start it concurrently so the fallback's
    // round-trips don't stack behind DuckDuckGo's. If DuckDuckGo answers, the
    // fallback is aborted and the instant answer is served immediately.
    const fallbackController = new AbortController();
    const onOuterAbort = () => fallbackController.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    const fallbackPromise = searchKnowledgeFallback(query, cls, timeoutMs, fallbackController.signal)
      .catch((err) => {
        knowledgeLog.error("knowledge fallback failed", {
          kind: cls.kind,
          query,
          name: err instanceof Error ? err.name : undefined,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

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
    // rank-qualified question needs content naming office + place + rank +
    // qualifier, and a generic result needs real content that names the
    // question's subject — never a keyword-only abstract or a bare heading
    // with title-only topics. Otherwise the Wikipedia fallback continues.
    if (result && !isEmpty(result) && isSearchResultRelevant(result, cls, query)) {
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
  // Only cache results that already passed the SAME relevance/authority
  // validation the cache reads enforce — a stale, semantically invalid result
  // must never be stored for later reuse. This also guards the DuckDuckGo
  // winner for rank-qualified/generic and the fallback lead for generic.
  if (!cachedResultValidFor(result, cls, query)) return null;
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

/** Whether a whole word appears in lowercase content (word-boundary match). */
function contentHasWord(content: string, word: string): boolean {
  const w = word.toLowerCase();
  if (w.length < 3) return content.includes(w);
  return new RegExp(`\\b${escapeRegExp(w)}\\b`).test(content);
}

/** Whether the place appears in the content, matching its canonical alias too. */
function contentMentionsPlace(content: string, place: string, canonical: string | null): boolean {
  const raw = place.toLowerCase().replace(/^the\s+/, "").trim();
  if (raw.length >= 3 && contentHasWord(content, raw)) return true;
  if (canonical && contentHasWord(content, canonical)) return true;
  return false;
}

/**
 * Whether the requested office appears in the answer content, tolerating a
 * one-character typo. The infobox answer's office label comes from the article
 * title, which resolves typos ("prime misnister" searches "Prime Minister
 * (India)"), so the exact misspelled string must not be required.
 */
function contentHasOffice(content: string, office: string): boolean {
  if (contentHasWord(content, office)) return true;
  const tokens = office.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  return tokens.every((t) => tokenInTitle(t, content));
}

interface RankQualifiedEvidence {
  rank?: string;
  officeNoun?: string;
  qualifiers?: string[];
  place?: string;
  canonicalPlace?: string | null;
}

/**
 * How tightly the rank, qualifiers, office and place must co-occur to count as
 * evidence. A genuine answer fits in one sentence ("first and remains the only
 * Sikh prime minister of India" — 9 words); the Khalistan movement lead that
 * merely scatters the words spans ~90 words. A bounded window rejects the
 * scatter while accepting every real relationship sentence.
 */
const RANK_QUALIFIED_EVIDENCE_WINDOW = 30;

/** How tightly a possessive binding ("India's … prime minister") may fit. */
const RANK_QUALIFIED_POSSESSIVE_WINDOW = 12;

/** Whether every `terms` word appears within `windowSize` consecutive words. */
function wordsCooccur(content: string, terms: string[], windowSize: number): boolean {
  const need = new Set(terms.filter((t) => t.length >= 3));
  if (need.size === 0) return true;
  const tokens = content.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 0);
  for (let start = 0; start < tokens.length; start++) {
    const found = new Set<string>();
    const end = Math.min(tokens.length, start + windowSize);
    for (let i = start; i < end; i++) {
      if (need.has(tokens[i])) found.add(tokens[i]);
      if (found.size === need.size) return true;
    }
  }
  return false;
}

/**
 * Whether the office noun is bound to the place: "prime minister OF INDIA" or
 * "INDIA'S … prime minister". A lead that only says "prime minister of
 * Pakistan" while "India" appears elsewhere does not bind the requested office
 * to the requested place.
 */
function contentBindsOfficeToPlace(
  content: string,
  officeNoun: string,
  place: string,
  canonical: string | null
): boolean {
  const lower = content.toLowerCase();
  const noun = officeNoun.toLowerCase();
  if (noun.length < 3) return false;
  const places = [place, canonical].filter((p): p is string => Boolean(p && p.trim().length > 0));
  for (const p of places) {
    const pLower = p.toLowerCase().replace(/^the\s+/, "").trim();
    if (pLower.length < 3) continue;
    if (
      new RegExp(`\\b${escapeRegExp(noun)}\\s+of\\s+(?:the\\s+)?${escapeRegExp(pLower)}\\b`).test(
        lower
      )
    ) {
      return true;
    }
    if (
      new RegExp(`\\b${escapeRegExp(pLower)}\\s*['’]\\s*s\\b`).test(lower) &&
      wordsCooccur(lower, [noun, pLower], RANK_QUALIFIED_POSSESSIVE_WINDOW)
    ) {
      return true;
    }
  }
  return false;
}

/** All distinct words the relationship proof must co-occur for this query. */
function rankQualifiedEvidenceTerms(rq: RankQualifiedEvidence): string[] {
  const office = [...(rq.qualifiers ?? []), rq.officeNoun].filter(
    (t): t is string => Boolean(t)
  );
  const placeTokens = (rq.canonicalPlace ?? rq.place ?? "")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return [...new Set([...office, rq.rank ?? "", ...placeTokens].filter((t) => t.length >= 3))];
}

/**
 * The sentence that actually establishes the requested relationship, kept in
 * the article's original casing. Used as the rank-qualified abstract so the
 * answer names the requested person instead of an unrelated first sentence.
 */
function relationshipEvidence(content: string, terms: string[], windowSize: number): string | null {
  const sentences = content.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (sentence && wordsCooccur(sentence, terms, windowSize)) return sentence.trim();
  }
  return null;
}

/**
 * Title gate for rank-qualified candidates: the answer to a person-role
 * question ("who was the FIRST x of y?") is a person. A list, disambiguation,
 * timeline or movement/topic page can never represent that person, so it is
 * skipped before its lead is even read.
 */
function isRankQualifiedPersonTitle(title: string): boolean {
  const lower = title.toLowerCase();
  if (/^(?:list of|timeline of|index of|disambiguation|the\s+)/.test(lower)) return false;
  if (/\b(?:movement|insurgency|religion|history|party|empire|dynasty|organisation|organization|association)\b/.test(lower)) {
    return false;
  }
  return true;
}

/**
 * Semantic support check for rank-qualified questions. The content must
 * ESTABLISH the requested relationship: the office, the place, the rank AND
 * the content qualifiers ("first Sikh prime minister of India"). The word
 * checks are only a cheap pre-filter — the relationship is proven by a tight
 * co-occurrence window with the office bound to the place. A result that only
 * shares words scattered across paragraphs ("Khalistan movement": "first",
 * "sikh", "prime minister of Pakistan", "India") cannot support the question
 * and is rejected — never guessed at.
 */
function contentSupportsRankQualified(content: string, rq: RankQualifiedEvidence): boolean {
  if (rq.officeNoun && !contentHasWord(content, rq.officeNoun)) return false;
  if (rq.place && !contentMentionsPlace(content, rq.place, rq.canonicalPlace ?? null)) return false;
  if (rq.rank && !contentHasWord(content, rq.rank)) return false;
  if (
    rq.qualifiers &&
    rq.qualifiers.length > 0 &&
    !rq.qualifiers.every((q) => contentHasWord(content, q))
  ) {
    return false;
  }
  if (rq.officeNoun && rq.place) {
    const terms = rankQualifiedEvidenceTerms(rq);
    if (!contentBindsOfficeToPlace(content, rq.officeNoun, rq.place, rq.canonicalPlace ?? null)) {
      return false;
    }
    if (!wordsCooccur(content, terms, RANK_QUALIFIED_EVIDENCE_WINDOW)) return false;
  }
  return true;
}

/** Hinglish interrogative particles — never content, never a search subject. */
const HINGLISH_PARTICLES = new Set([
  "kya", "hai", "tha", "thi", "hain", "the", "hota", "hoti", "kaun", "kis",
  "konsa", "kiska", "kiski", "ho", "hue", "hoga",
]);

/**
 * Whether a generic DuckDuckGo result actually addresses the question's
 * subject. "What is a JavaScript closure?" is about "closure" — a result that
 * only talks about "JavaScript is a programming language…" shares a keyword
 * but not the subject and must not win the race over the Wikipedia fallback.
 * The subject is the trailing content keyword (the head noun); a query with no
 * usable subject accepts any contentful result.
 */
function genericResultMatchesTopic(result: SearchResult, query: string): boolean {
  const keywords = queryKeywords(query);
  if (keywords.length === 0) return true;
  let head = keywords[keywords.length - 1];
  while (keywords.length > 1 && HINGLISH_PARTICLES.has(head)) {
    keywords.pop();
    head = keywords[keywords.length - 1];
  }
  if (!head || head.length < 3) return true;
  return contentHasWord(searchResultContent(result), head);
}

/**
 * Query-aware relevance gate: DuckDuckGo only wins the race when its content
 * actually answers the question asked. A rank-qualified question needs the
 * office, the place, the rank and the qualifiers to all appear; a generic
 * result needs real content that names the question's subject — never a
 * keyword-only abstract ("JavaScript is a programming language…" for a
 * "closure" question) or a heading with title-only topics.
 */
function isSearchResultRelevant(result: SearchResult, cls: KnowledgeQuery, query: string): boolean {
  if (cls.kind === "rank-qualified") {
    return contentSupportsRankQualified(searchResultContent(result), cls);
  }
  if (cls.kind === "generic") {
    return isContentfulResult(result) && genericResultMatchesTopic(result, query);
  }
  return isContentfulResult(result);
}

/**
 * Whether a SearchResult is valid for the CURRENT query classification —
 * enforced on every cache READ and, symmetrically, before every cache WRITE.
 *
 * A cached result created under an earlier, weaker implementation can bypass
 * the current classification entirely: the old code stored a generic
 * Wikipedia/DDG result for "India ka pradhan mantri kaun hai?" (an unrelated
 * person's page) before the Hinglish officeholder parser existed, and served
 * it forever. Classification now runs BEFORE any cache read, and a hit is
 * only served when it satisfies the same semantic gate the fresh path uses:
 *
 * - officeholder: only an authoritative structured answer naming the office
 *   and place is valid — a generic abstract, random person, DDG definition,
 *   title-only topic or unrelated article is rejected.
 * - capital: only an authoritative answer naming the requested place is valid.
 * - rank-qualified: the result must semantically support the requested
 *   relationship (existing contentSupportsRankQualified gate) — cached results
 *   must not bypass it.
 * - generic: the existing query-aware relevance gate.
 */
function cachedResultValidFor(
  result: SearchResult,
  cls: KnowledgeQuery,
  query: string
): boolean {
  if (cls.kind === "rank-qualified") {
    return contentSupportsRankQualified(searchResultContent(result), cls);
  }
  if (cls.kind === "generic") {
    return isSearchResultRelevant(result, cls, query);
  }
  // officeholder / capital: the answer must be the authoritative structured
  // infobox answer ("The current X of Y is …"), carrying the requested office
  // and place. Anything else — a definition, an unrelated person, a title-only
  // topic — is not a valid cached answer.
  const answer = (result.answer ?? "").trim();
  if (!answer) return false;
  const content = answer.toLowerCase();
  if (cls.place && !contentMentionsPlace(content, cls.place, cls.canonicalPlace ?? null)) {
    return false;
  }
  if (cls.office && !contentHasOffice(content, cls.office)) return false;
  return true;
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
