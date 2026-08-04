/**
 * Web tools — network-backed factual sources. Every tool caches aggressively,
 * times out, and throws typed errors that the executor retries. Results are
 * verified facts the reasoning model only ever naturalizes.
 */

import {
  convertCurrency,
  fetchNews,
  mapsSearchUrl,
  directionsUrl,
  parseCurrencyRequest,
  parseMapsRequest,
  webSearch,
  type SearchResult,
} from "@/lib/toolkit/web";
import { numberArg, stringArg } from "../args";
import type { Tool } from "../types";

export const searchWeb: Tool = {
  definition: {
    name: "web_search",
    description:
      "Search the web for a factual query and return a best-effort verified snippet.",
    category: "web",
    runtime: "node",
    parameters: [
      { name: "query", type: "string", description: "The search query.", required: true },
    ],
    cacheable: true,
    cacheTtlMs: 5 * 60 * 1_000,
    timeoutMs: 8_000,
    retries: 1,
  },
  run: async (args): Promise<SearchResult | null> => {
    const query = stringArg(args, "query");
    if (!query) throw new Error("The 'query' argument is required.");
    return webSearch(query);
  },
};

export const getNews: Tool = {
  definition: {
    name: "get_news",
    description: "Get the latest top stories from a live news source.",
    category: "news",
    runtime: "node",
    parameters: [
      { name: "limit", type: "number", description: "Maximum number of stories (default 8)." },
    ],
    cacheable: true,
    cacheTtlMs: 5 * 60 * 1_000,
    timeoutMs: 8_000,
    retries: 1,
  },
  run: async (args) => {
    const limit = numberArg(args, "limit", 8, { min: 1, max: 10 });
    return { stories: await fetchNews(limit) };
  },
};

export const convertCurrencyTool: Tool = {
  definition: {
    name: "convert_currency",
    description:
      "Convert money between currencies using live exchange rates (e.g. '100 USD to EUR').",
    category: "currency",
    runtime: "node",
    parameters: [
      { name: "amount", type: "number", description: "The amount to convert.", required: true },
      { name: "from", type: "string", description: "Source currency code or name (USD, EUR...).", required: true },
      { name: "to", type: "string", description: "Target currency code or name (INR, GBP...).", required: true },
    ],
    cacheable: true,
    cacheTtlMs: 5 * 60 * 1_000,
    timeoutMs: 8_000,
    retries: 1,
  },
  run: async (args) => {
    const amount = numberArg(args, "amount", NaN);
    const from = stringArg(args, "from");
    const to = stringArg(args, "to");
    if (!Number.isFinite(amount)) throw new Error("The 'amount' argument must be a number.");
    if (!from || !to) throw new Error("Both 'from' and 'to' currencies are required.");
    return convertCurrency(amount, from, to);
  },
};

export const parseCurrencyRequestTool: Tool = {
  definition: {
    name: "parse_currency_request",
    description: "Parse a free-text currency request like 'how much is 100 usd in inr'.",
    category: "currency",
    runtime: "node",
    cacheable: true,
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
  },
  run: async (args) => {
    const input = stringArg(args, "input");
    if (!input) throw new Error("The 'input' argument is required.");
    const parsed = parseCurrencyRequest(input);
    if (!parsed) throw new Error(`No currency conversion found in "${input}".`);
    return parsed;
  },
};

export const mapsLink: Tool = {
  definition: {
    name: "maps_link",
    description:
      "Build a Google Maps link for a place or for directions. Deterministic, no network.",
    category: "web",
    runtime: "any",
    parameters: [
      { name: "query", type: "string", description: "Place to search for.", required: true },
      { name: "mode", type: "string", description: "'search' or 'directions' (default search)." },
      { name: "from", type: "string", description: "Origin for directions mode." },
    ],
    cacheable: true,
    cacheTtlMs: 300_000,
    timeoutMs: 2_000,
  },
  run: async (args) => {
    const query = stringArg(args, "query");
    const mode = stringArg(args, "mode", "search");
    if (!query) throw new Error("The 'query' argument is required.");
    const from = stringArg(args, "from");
    if (mode === "directions") {
      return { url: directionsUrl(from ?? null, query), mode: "directions" };
    }
    return { url: mapsSearchUrl(query), mode: "search" };
  },
};

export const parseMapsRequestTool: Tool = {
  definition: {
    name: "parse_maps_request",
    description: "Parse a free-text maps request like 'where is the nearest coffee shop'.",
    category: "web",
    runtime: "any",
    cacheable: true,
    cacheTtlMs: 60_000,
    timeoutMs: 2_000,
  },
  run: async (args) => {
    const input = stringArg(args, "input");
    if (!input) throw new Error("The 'input' argument is required.");
    const parsed = parseMapsRequest(input);
    if (!parsed) throw new Error(`No maps request found in "${input}".`);
    return parsed;
  },
};

export const webTools: Tool[] = [
  searchWeb,
  getNews,
  convertCurrencyTool,
  parseCurrencyRequestTool,
  mapsLink,
  parseMapsRequestTool,
];
