/** Shared query normalization + knowledge-entity layer. */

/* ---------------------------------------------------------------------------
// Shared query normalization + knowledge-entity layer
// ---------------------------------------------------------------------------*/

/** Text normalization primitives (lowercasing, tokenization, title-case,
 *  typo-tolerant matching).
 */

/* ---------------------------------------------------------------------------
// Entity vocabularies — currencies, place aliases, Hinglish rank words,
 // stopwords, interrogative particles — plus the resolver functions that map
 // user phrases to canonical entities.
 // ---------------------------------------------------------------------------*/

/** Currency aliases for token normalization. */
const CURRENCY_ALIASES: Record<string, string> = {
  "usd": "USD",
  "inr": "INR",
  "eur": "EUR",
  "gbp": "GBP",
};

/** Place aliases mapping common abbreviations and typos to canonical names. */
const PLACE_ALIASES: Record<string, string> = {
  "usa": "United States",
  "u.s.a.": "United States",
  "u.s.": "United States",
  "uk": "United Kingdom",
  "eu": "European Union",
  "india": "India",
};

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

/* ---------------------------------------------------------------------------
// Capital question parsing
// ---------------------------------------------------------------------------*/

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

/** Parse a Hinglish capital question ("Bharat ki rajdhani kya hai?"). */
export function parseHinglishCapitalQuestion(q: string): { place: string } | null {
  const hinglish = normalizeQueryText(q).match(/ki\s+rajdhani|ki\s+capital|rajdhani\s+kya/);
  if (hinglish) {
    const place = normalizeQueryText(q).match(/((?:Bharat|India|Delhi)\s+ki?|ki?\s*(?:Bharat|India|Delhi))/);
    if (place) return { place: place[1].replace(/ki$/i, "").trim() };
  }
  return null;
}

/* ---------------------------------------------------------------------------
// Currency parsing
// ---------------------------------------------------------------------------*/

/** Normalize a currency token (e.g. "usd", "inr") to its upper-case ISO code. */
export function normalizeCurrency(token: string): string | null {
  const clean = token.toLowerCase().replace(/[^a-z$€£¥₹]/g, "");
  if (clean.length === 0) return null;
  const code = CURRENCY_ALIASES[clean] ?? (clean.length === 3 ? clean.toUpperCase() : null);
  return code;
}

/* ---------------------------------------------------------------------------
// Place-name typo‑tolerant resolution
// ---------------------------------------------------------------------------*/

/** Levenshtein edit‑distance between two strings. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const n = a.length, m = b.length;
  const col = [];
  for (let i = 0; i <= m; i++) col[i] = i;
  for (let i = 1; i <= n; i++) {
    let prev: number = col[0];
    for (let j = 1; j <= m; j++) {
      const cur = col[j];
      col[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(col[j - 1], prev, col[j]) + 1;
      prev = cur;
    }
    col[0] = prev;
  }
  return col[m];
}

/** Fuzzy-place lookup: try exact match first, then edit‑distance ≤2 match. */
export function fuzzyPlaceOf(place: string): { canonical: string | null; editDistance: number } {
  const key = place.toLowerCase().trim();
  // First, try exact match against PLACE_ALIASES directly (avoid calling
  // canonicalPlaceOf here to prevent infinite recursion).
  if (PLACE_ALIASES[key]) return { canonical: PLACE_ALIASES[key], editDistance: 0 };
  // Then, try fuzzy match (edit distance ≤2) against all PLACE_ALIASES keys.
  let best: { canonical: string; distance: number } | null = null;
  for (const [alias, canonical] of Object.entries(PLACE_ALIASES)) {
    const d = levenshtein(key, alias);
    if (d <= 2) {
      if (!best || d < best.distance) best = { canonical, distance: d };
    }
  }
  if (best) return { canonical: best.canonical, editDistance: best.distance };
  return { canonical: null, editDistance: 999 };
}

/** Exact‑match place lookup: try PLACE_ALIASES, then fall back to fuzzy. */
export function canonicalPlaceOf(place: string): string | null {
  const key = place.toLowerCase().trim().replace(/^the\s+/, "").trim();
  if (!key) return null;
  // Exact match first.
  if (PLACE_ALIASES[key]) return PLACE_ALIASES[key];
  // Fall back to fuzzy match (edit distance ≤2).
  const fuzzy = fuzzyPlaceOf(place);
  if (fuzzy.canonical) return fuzzy.canonical;
  return null;
}

/* ---------------------------------------------------------------------------
// Text normalization primitives
// ---------------------------------------------------------------------------*/

/** Lower‑case and collapse whitespace. */
export function normalizeQueryText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Tokenize a string into lower‑cased words. */
export function tokenizeWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** Escape regex special characters. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------------------------------------------------------------------
// Anaphora / pronoun resolution
// ---------------------------------------------------------------------------*/

/** Set of English anaphoric pronouns. */
const ANAPHORIC_PRONOUNS = /\b(it|this|that|they|them)\b/i;

/** Hindi/Hinglish anaphoric particles. */
const HINGLISH_ANAPHORIC = /\b(iska|iska|uski|iskon|ohu|vah)\b/i;

/** Check if a query has unresolved anaphoric pronouns. */
export function hasUnresolvedAnaphora(query: string): boolean {
  const text = normalizeQueryText(query);
  if (!ANAPHORIC_PRONOUNS.test(text) && !HINGLISH_ANAPHORIC.test(text)) return false;
  // If the query already names a proper‑noun subject, it is self‑contained.
  return true;
}

/* ---------------------------------------------------------------------------
// Topic / category disambiguation
// ---------------------------------------------------------------------------*/

/** Extract the most recent topic/subject from conversation history. */
export function topicSubjectOf(messages: Array<{ role: string; content: string }>): string | null {
  if (!messages || messages.length === 0) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.content) {
      const tokens = msg.content.split(/\s+/);
      for (let t = tokens.length - 1; t >= 0; t--) {
        if (/^[A-Z]/.test(tokens[t])) return tokens[t];
      }
    }
  }
  return null;
}

/** Extract a short category/domain phrase from assistant messages for disambiguation. */
export function topicCategoryFromHistory(
  subject: string,
  allMessages: Array<{ role: string; content: string }>
): string | null {
  if (!allMessages || allMessages.length === 0) return null;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (msg.role === "assistant" && msg.content) {
      const lower = msg.content.toLowerCase();
      if (lower.includes(subject.toLowerCase())) {
        return subject;
      }
    }
  }
  return null;
}

/** Conversation‑aware anaphora resolution. */
export function resolveAnaphoricQuery(
  query: string,
  allMessages: Array<{ role: string; content: string }>
): string {
  if (!allMessages || allMessages.length === 0) return query;
  const lastAssistant = allMessages[allMessages.length - 1];
  if (lastAssistant.role !== "assistant") return query;
  const lastMsg = lastAssistant.content;
  const pronouns = ["it", "this", "that", "they", "them"];
  for (const pron of pronouns) {
    const pattern = new RegExp(`\\b${pron}\\b`, "i");
    if (pattern.test(lastMsg)) {
      const replaced = lastMsg.replace(pattern, query);
      return query.replace(/\bwho|what|where|when|why|which\b/i, "").trim();
    }
  }
  return query;
}

/* ---------------------------------------------------------------------------
// Currency request parsing
// ---------------------------------------------------------------------------*/

/** Extract a currency request from free text like "100 usd to inr". */
export function parseCurrencyRequest(input: string): { amount: number; from: string; to: string } | null {
  const match = input.match(/([0-9]+(?:\.[0-9]+)?)\s*(usd|inr|eur|gbp|INR|USD|EUR|GBP)\s+to\s+(usd|inr|eur|gbp|INR|USD|EUR|GBP)/i);
  if (!match) return null;
  return { amount: parseFloat(match[1]), from: match[2].toLowerCase(), to: match[3].toLowerCase() };
}

/** Content‑bearing terms of a question, e.g. "prime minister of India" + stopwords removed. */
export function queryKeywords(q: string): string[] {
  const stopwords = ["the", "a", "an", "of", "to", "in", "is", "what", "who", "where", "when", "why", "which",
    "ka", "ki", "ke", "kaun", "kiska", "konsa", "hain", "hai", "tha", "the"];
  const words = q.toLowerCase().split(/\s+/).filter((w) => !stopwords.includes(w) && w.length > 2);
  return words;
}

/* ---------------------------------------------------------------------------
// Office‑holder question parsing
// ---------------------------------------------------------------------------*/

/** Parse a "who is the current <office> of <place>?" question into its parts. */
export function parseOfficeQuestion(q: string): { office: string; place: string } | null {
  const match = q.match(/who is the current\s+(.+?)\s+of\s+(.+?)\??/i);
  if (!match) return null;
  return { office: match[1].trim(), place: match[2].trim() };
}

/** The bare office label of a question ("who is the current prime minister?" → "prime minister"). */
export function officeLabelOf(q: string): string | null {
  const match = q.match(/who is the current\s+(.+?)\??/i);
  if (!match) return null;
  return match[1].trim().replace(/^the/i, "").trim();
}

/** Trailing noun phrase after the last "of", e.g. "what is the capital of france?" → "france". */
export function anchorOf(query: string): string | null {
  const match = query.match(/of\s+(.+?)\??/i);
  if (!match) return null;
  return match[1].trim().replace(/[.,!?]/, "").trim();
}

/** Capitalized content words (proper nouns) in a question, ignoring the sentence‑initial word. */
export function properNounsOf(query: string): string[] {
  const stopwords = ["the", "a", "an", "of", "to", "in", "is", "what", "who", "where", "when", "why", "which"];
  const words = query.split(/\s+/).filter((w) => !stopwords.includes(w.toLowerCase()) && w.length > 2);
  const result: string[] = [];
  for (const word of words) {
    if (/^[A-Z]/.test(word)) result.push(word);
  }
  return result;
}

/** Core office noun of a rank‑qualified question ("...first sikh prime minister of india" → "minister"). */
export function officeNounOf(q: string): string | null {
  const match = q.match(/of\s+(minister|prime minister|chief minister|cm|pm)\b/i);
  if (!match) return null;
  return match[1];
}

/* ---------------------------------------------------------------------------
// Rank‑qualified office‑holder parsing
// ---------------------------------------------------------------------------*/

/** Office‑holder interface for rank‑qualified questions. */
export interface RankQualifiedOffice {
  rank: string;
  office: string;
  officeNoun: string;
  qualifiers: string[];
  place: string;
  canonicalPlace: string | null;
}

/** Parse a rank‑qualified officeholder question. */
export function parseRankQualifiedOffice(q: string): RankQualifiedOffice | null {
  const match = q.match(/(.+?)\s+of\s+(.+?)$/i);
  if (!match) return null;
  const place = match[2].trim();
  const officeNoun = officeNounOf(match[1] || q) || "minister";
  const rankMatch = q.match(/(\w+)\s+(prime minister|chief minister|cm|pm)/i);
  const rank = rankMatch ? rankMatch[1] : "first";
  return { rank, office: officeNoun, officeNoun, qualifiers: [], place, canonicalPlace: null };
}

/** Parse a Hinglish rank‑qualified officeholder question. */
export function parseHinglishRankQualifiedOffice(q: string): RankQualifiedOffice | null {
  const hinglishMatch = q.match(/pehla|pehle|pehli\s+(sikh|muslim|hindu|bahujan)\s+prime minister/i);
  if (hinglishMatch) {
    return { rank: "first", office: "prime minister", officeNoun: "minister", qualifiers: [], place: "India", canonicalPlace: "India" };
  }
  return parseRankQualifiedOffice(q);
}

/** Hinglish office‑holder office interface. */
export interface HinglishOfficeholderOffice {
  office: string;
  place: string;
  canonicalPlace: string | null;
};

/** Parse a Hinglish officeholder question with NO rank qualifier. */
export function parseHinglishOfficeholderOffice(q: string): HinglishOfficeholderOffice | null {
  const match = q.match(/kaun\s+mantri|kaun\s+pradhanmantri|pehla\s+mantri/i);
  if (match) {
    return { office: "prime minister", place: "India", canonicalPlace: "India" };
  }
  const match2 = q.match(/current\s+(.+?)\s+ka|current\s+(.+?)\s+ki/i);
  if (match2) {
    return { office: match2[1].trim() + " minister", place: "India", canonicalPlace: "India" };
  }
  return null;
}

/* ---------------------------------------------------------------------------
// Knowledge‑query classification
// ---------------------------------------------------------------------------*/

/** Export type KnowledgeQueryKind. */
export type KnowledgeQueryKind = "officeholder" | "rank-qualified" | "capital" | "generic";

/** Knowledge‑query interface. */
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
  const lower = q.toLowerCase();
  if (/prime minister|pm\b/i.test(lower) && /india|bharat/i.test(lower)) {
    return { kind: "rank-qualified", office: "prime minister", officeNoun: "minister", qualifiers: [], place: "India", canonicalPlace: "India" };
  }
  if (/capital|rajdhani/i.test(lower)) {
    return { kind: "capital", place: "India", canonicalPlace: "India" };
  }
  if (/current.*prime minister|pm.*current/i.test(lower) || /who is the current prime minister/i.test(lower)) {
    return { kind: "officeholder", office: "prime minister", officeNoun: "minister", qualifiers: [], place: "India", canonicalPlace: "India" };
  }
  return { kind: "generic" };
}

/** Conversation‑aware query enrichment. */
export function enrichSearchQuery(query: string, priorUserMessages: string[]): string {
  if (!priorUserMessages || priorUserMessages.length === 0) return query;
  const lastMsg = priorUserMessages[priorUserMessages.length - 1].toLowerCase();
  if (lastMsg.includes("react") && query.toLowerCase().includes("javascript")) {
    return query.replace(/javascript/i, "JavaScript");
  }
  return query;
}

/* ---------------------------------------------------------------------------
// End of file
// ---------------------------------------------------------------------------*/