/**
 * Language detection for JARVIS — the FIRST stage of the chat pipeline.
 *
 *   User → Language Detection → Planner → Tools → LLM → Language Formatter → Voice
 *
 * Pure heuristics, zero model calls, sub-5ms. Distinguishes English, Hindi
 * (Devanagari script) and Hinglish (Hindi spoken with the Latin script, e.g.
 * "kya haal hai"). The detected language is passed to the planner (for
 * vocabulary-aware intent routing), the LLM (to respond in the same language)
 * and the language formatter (localized direct answers, canned replies and TTS
 * voice selection).
 *
 * Tool execution is language independent: only presentation changes based on
 * the detected language.
 */

import { aiLogger } from "@/lib/ai/logger";

export type SpokenLanguage = "english" | "hindi" | "hinglish";
export type ScriptKind = "devanagari" | "latin";

export interface LanguageDetection {
  language: SpokenLanguage;
  script: ScriptKind;
  confidence: number;
}

const DEVANAGARI_RE = /[\u0900-\u097F]/;

/** True when the text contains any Devanagari character (Hindi script). */
export function hasDevanagari(text: string): boolean {
  return DEVANAGARI_RE.test(text);
}

/**
 * Distinctive Hindi-origin words written in Latin script (Hinglish). Includes
 * common pronouns, verbs, time words, interrogatives and greetings so a mixed
 * English sentence with two or more of these is classified as Hinglish.
 */
const HINGLISH_TOKENS = new Set([
  "hai",
  "hain",
  "kya",
  "kaise",
  "kaisa",
  "kaisi",
  "karo",
  "karte",
  "karta",
  "karti",
  "karna",
  "kijiye",
  "chahiye",
  "chahta",
  "chahti",
  "chahte",
  "nahi",
  "nahin",
  "mujhe",
  "mujh",
  "tum",
  "tumhara",
  "tumhari",
  "tumhare",
  "aap",
  "aapka",
  "aapki",
  "aapke",
  "tera",
  "teri",
  "tere",
  "mera",
  "meri",
  "mere",
  "hum",
  "ham",
  "hamara",
  "hamari",
  "kaun",
  "kisne",
  "kisse",
  "kiska",
  "kiski",
  "kab",
  "kahan",
  "kaha",
  "kyun",
  "kyon",
  "kyu",
  "kitna",
  "kitni",
  "kitne",
  "batao",
  "bata",
  "bolo",
  "bol",
  "bhai",
  "yaar",
  "dekho",
  "dekh",
  "sun",
  "suno",
  "jao",
  "jaate",
  "jata",
  "jati",
  "aao",
  "aana",
  "aata",
  "aati",
  "aate",
  "kal",
  "aaj",
  "parson",
  "parso",
  "raat",
  "subah",
  "shaam",
  "dopahar",
  "baje",
  "baj",
  "tarikh",
  "tareekh",
  "samay",
  "waqt",
  "mausam",
  "garmi",
  "sardi",
  "baarish",
  "barish",
  "dhoop",
  "badal",
  "hawa",
  "toofan",
  "kidhar",
  "idhar",
  "udhar",
  "yahan",
  "wahan",
  "hoon",
  "hoga",
  "gaya",
  "gayi",
  "gaye",
  "kiya",
  "khaana",
  "khana",
  "pina",
  "sona",
  "chalo",
  "chal",
  "ruk",
  "ruko",
  "thodi",
  "thoda",
  "bahut",
  "bohot",
  "achha",
  "acha",
  "achhi",
  "theek",
  "thik",
  "sahi",
  "galat",
  "kharab",
  "namaste",
  "pranam",
  "shukriya",
  "dhanyavad",
  "alvida",
  "madad",
  "batana",
  "dikhao",
  "dikha",
  "bhejo",
  "bhej",
  "lao",
  "lejao",
  "dekhna",
  "sunna",
  "bolna",
  "samajh",
  "samjhe",
  "samajho",
  "pata",
  "malum",
  "maloom",
  "andar",
  "bahar",
  "upar",
  "neeche",
  "niche",
  "paas",
  "dost",
  "mitra",
  "bharosa",
  "yakeen",
  "yaqeen",
  "sach",
  "jhooth",
  "aasan",
  "chalu",
  "band",
  "kholo",
  "khol",
  "hua",
  "hue",
  "hui",
  "haal",
  "billkul",
  "bilkul",
  "theek",
  "na",
  "ko",
  "se",
  "mein",
  "main",
  "ki",
  "ke",
  "ka",
  "wala",
  "wale",
  "wali",
  "kuch",
  "kuchh",
  "sab",
  "sabhi",
  "yahi",
  "wohi",
  "vahi",
]);

/**
 * Lone tokens strong enough on their own to mark a message as Hinglish
 * (e.g. just "kya" or "kya hai" already implies Hinglish).
 */
const STRONG_HINGLISH = new Set([
  "hai",
  "hain",
  "kya",
  "kaise",
  "chahiye",
  "nahi",
  "mujhe",
  "batao",
  "aaj",
  "kal",
  "baje",
  "tarikh",
  "mausam",
  "samay",
  "waqt",
  "namaste",
  "shukriya",
  "karo",
  "theek",
  "chalu",
  "hoon",
  "haal",
  "parson",
  "subah",
  "shaam",
  "raat",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Deterministic language classification. Never calls a model. */
export function detectLanguage(text: string): LanguageDetection {
  if (!text || !text.trim()) {
    return { language: "english", script: "latin", confidence: 50 };
  }

  if (hasDevanagari(text)) {
    return { language: "hindi", script: "devanagari", confidence: 95 };
  }

  const tokens = tokenize(text);
  let hits = 0;
  for (const token of tokens) {
    if (HINGLISH_TOKENS.has(token)) hits++;
  }
  if (hits >= 2) {
    return {
      language: "hinglish",
      script: "latin",
      confidence: Math.min(97, 72 + hits * 6),
    };
  }
  if (hits === 1 && STRONG_HINGLISH.has(tokens.find((t) => HINGLISH_TOKENS.has(t)) ?? "")) {
    return { language: "hinglish", script: "latin", confidence: 62 };
  }
  return { language: "english", script: "latin", confidence: 90 };
}

/** Short human label for prompt injection. */
export function describeLanguage(language: SpokenLanguage): string {
  switch (language) {
    case "hindi":
      return "Hindi (Devanagari script)";
    case "hinglish":
      return "Hinglish (casual Hindi written in Roman script)";
    default:
      return "English";
  }
}

/** Language a TTS voice should use for the given response text. */
export function detectSpeechLanguage(text: string): "hi" | "en" {
  if (hasDevanagari(text)) return "hi";
  return detectLanguage(text).language === "hinglish" ? "hi" : "en";
}

const langLog = aiLogger.child("lang");

/** Runtime trace of every detection: caller, language, confidence, latency. */
export function logLanguageDetection(
  caller: string,
  prompt: string,
  detection: LanguageDetection,
  latencyMs: number
): void {
  langLog.info("[Language]", {
    caller,
    language: detection.language,
    script: detection.script,
    confidence: detection.confidence,
    latencyMs,
    prompt: prompt.slice(0, 120),
  });
}
