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
  const res = await fetchWithTimeout(url, timeoutMs, signal);
  if (!res.ok) throw new ToolkitNetworkError(`Search service responded with ${res.status}.`);
  const data = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    Answer?: string;
    AbstractSource?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };
  const topics: SearchResult["topics"] = [];
  for (const topic of data.RelatedTopics ?? []) {
    if (topic.Text && topic.FirstURL) {
      topics.push({ text: topic.Text.slice(0, 200), url: topic.FirstURL });
      if (topics.length >= 5) break;
    } else if (Array.isArray(topic.Topics)) {
      for (const sub of topic.Topics.slice(0, 5)) {
        if (sub.Text && sub.FirstURL) topics.push({ text: sub.Text.slice(0, 200), url: sub.FirstURL });
      }
    }
  }
  const result: SearchResult = {
    query,
    heading: data.Heading || null,
    abstract: data.AbstractText || null,
    answer: data.Answer || null,
    source: data.AbstractSource || null,
    url: data.AbstractURL || null,
    topics,
    engine: "DuckDuckGo",
  };
  searchCache.set(key, { value: result, at: Date.now() });
  return result;
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
  const items: NewsItem[] = [];
  for (const id of ids.slice(0, limit)) {
    try {
      const itemRes = await fetchWithTimeout(HN_ITEM_URL(id), timeoutMs, signal);
      if (!itemRes.ok) continue;
      const item = (await itemRes.json()) as {
        title?: string;
        url?: string;
        score?: number;
        by?: string;
        time?: number;
        descendants?: number;
      };
      if (!item.title || item.title.toLowerCase().includes("show hn")) continue;
      items.push({
        title: item.title,
        url: item.url ?? `https://news.ycombinator.com/item?id=${id}`,
        score: item.score ?? 0,
        author: item.by ?? null,
        time: item.time
          ? new Date(item.time * 1000).toISOString()
          : getSystemClock().iso,
        comments: item.descendants ?? 0,
      });
      if (items.length >= limit) break;
    } catch {
      continue;
    }
  }
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
