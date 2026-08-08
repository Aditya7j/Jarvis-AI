/**
 * Class detectors — deterministic, sub-millisecond classifiers that decide
 * which verified tool must answer a request. The LLM is the last resort and
 * must never fabricate facts that a tool can verify.
 *
 * New detectors are added here, then wired into the planner. Every detector is
 * conservative: a false negative falls back to the LLM, a false positive
 * hijacks a question that should have been answered by a tool.
 *
 * Language: detectors cover English, Hindi (Devanagari) and Hinglish (Roman
 * script Hindi). Routing stays language independent — Hindi/Hinglish inputs
 * route to the exact same tools as English. Note that JS `\b` does not work
 * around Devanagari characters, so Hindi tokens use `\p{Script=Devanagari}` guards.
 */

import {
  parseConversionRequest,
  findUnit,
} from "@/lib/toolkit/convert";
import {
  normalizeCurrency,
  parseCurrencyRequest,
} from "@/lib/toolkit/web";
import { extractDateTokens } from "@/lib/time/date-calc";

/**
 * Greetings and casual conversation. These are whole-message matches: a greeting
 * followed by a real request ("hey jarvis, what time is it?") must NOT match, so
 * the request still routes to its tool. They short-circuit BEFORE every tool
 * detector so a greeting can never invoke a tool.
 */
const GREETING_PATTERNS: RegExp[] = [
  /^\s*(?:hi|hello|hey|hiya|howdy|yo|sup)\b(?:\s+jarvis\b)?[,.!?]*\s*$/i,
  /^\s*good\s+(?:morning|afternoon|evening|night|day)\b[,.!?]*\s*$/i,
  /^\s*what'?s\s+up\b[,.!?]*\s*$/i,
  /^\s*(?:namaste|pranam|hello|hi)\s+jarvis\b[,.!?]*\s*$/i,
  /^\s*(?:नमस्ते|नमस्कार|प्रणाम|हेलो|हाय|हैलो)(?:\s+जार्विस)?[,.!?।]*\s*$/u,
];

const CASUAL_PATTERNS: RegExp[] = [
  /^\s*(?:thanks|thank\s+you|thank\s+u|thx|ty)\b[,.!?]*\s*$/i,
  /^\s*(?:ok|okay|\bk\b|got\s+it|sure|alright|fine|great|cool|nice|awesome|perfect|good)\b[,.!?]*\s*$/i,
  /^\s*(?:yes|yeah|yep|yup|no|nope|nah)\b[,.!?]*\s*$/i,
  /^\s*(?:how\s+are\s+you|how'?s\s+it\s+going|how\s+are\s+you\s+doing|how\s+have\s+you\s+been)\b[,.!?]*\s*$/i,
  /^\s*(?:kya\s+haal\s+(?:hai|hain)|kaise\s+ho|kaisi\s+ho|kaise\s+hain|aap\s+kaise\s+hain|kya\s+chal\s+raha\s+hai)\b[,.!?]*\s*$/i,
  /^\s*(?:shukriya|dhanyavad)\b[,.!?]*\s*$/i,
  /^\s*(?:haan|nahi|theek\s+hai|achha|accha|badiya|bohot\s+achha)\b[,.!?]*\s*$/i,
  /^\s*(?:क्या\s+हाल\s+है|कैसे\s+हो|आप\s+कैसे\s+हैं|क्या\s+हालचाल|कैसा\s+चल\s+रहा\s+है)[,.!?।]*\s*$/u,
  /^\s*(?:शुक्रिया|धन्यवाद)[,.!?।]*\s*$/u,
  /^\s*(?:हाँ|नहीं|ठीक\s+है|अच्छा|बढ़िया|कूल|सुपर)[,.!?।]*\s*$/u,
];

export function detectGreeting(text: string): boolean {
  if (!text) return false;
  return GREETING_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectCasualConversation(text: string): boolean {
  if (!text) return false;
  return CASUAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectConversational(text: string): boolean {
  return detectGreeting(text) || detectCasualConversation(text);
}

const CALCULATOR_EXPLICIT =
  /\b(?:calculate|compute|evaluate|work\s+out|solve|add|subtract|divide|multiply|what'?s|what\s+is|how\s+much\s+is)\b/i;
const ARITHMETIC: RegExp[] = [
  /\b\d+\s*[\+\-\*\/÷×^%]\s*\d/,
  /\b\d+\s*(?:plus|minus|times|divided\s+by|multiplied\s+by|to\s+the\s+power\s+of|percent\s+of)\b/i,
  /\b(?:divide|multiply|add|subtract)\s+\d/i,
  /\b(?:sqrt|square\s+root|cube\s+root|sin|cos|tan|ln|log)\s*(?:of\s+)?\s*\d/i,
  /\b\d+\s*\+\s*\d+\b/,
];

/** Hindi / Hinglish arithmetic vocabulary (e.g. "2 गुना 3", "2+2 क्या है"). */
const ARITHMETIC_HINDI: RegExp[] = [
  /\b\d+\s*(?:गुना|भाग|जोड़|घटा)\s*\d+/u,
  /\b\d+\s*[+\-×÷*]\s*\d+\b/u,
  /\b(?:गुना|भाग|जोड़)\s*\d+/u,
];

const CALCULATOR_HINDI_EXPLICIT =
  /कितना\s+होगा|कितना\s+हुआ|क्या\s+आएगा|गणना\s+करो/u;
const CALCULATOR_HINGLISH_EXPLICIT = /\b(?:kitna\s+hoga|kitna\s+hua|kya\s+aayega)\b/i;

/**
 * Unambiguous arithmetic phrasings that carry their own intent — no separate
 * "what is / calculate" keyword needed.
 */
const CALCULATOR_IMPLICIT: RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:percent|%)\s+of\b/i,
  /\b\d+(?:\.\d+)?\s*(?:mod|modulo)\s+\d+\b/i,
  /\b(?:sqrt|square\s+root|cube\s+root|cbrt|sin|cos|tan|ln|log)\s*(?:of\s+)?\s*\d/i,
  /\b(?:divide|multiply)\s+\d+(?:\.\d+)?\s+by\s+\d+\b/i,
  /\b\d+\s+to\s+the\s+power\s+of\s+\d+\b/i,
];

export function detectCalculator(text: string): boolean {
  if (!text) return false;
  if (/^\s*\d[\d\s.,+\-*/÷×^%()]*\d?\s*[?]?\s*$/.test(text)) return true;
  if (CALCULATOR_IMPLICIT.some((pattern) => pattern.test(text))) return true;
  if (ARITHMETIC_HINDI.some((pattern) => pattern.test(text))) return true;
  if (
    CALCULATOR_HINDI_EXPLICIT.test(text) ||
    CALCULATOR_HINGLISH_EXPLICIT.test(text)
  ) {
    return (
      ARITHMETIC.some((pattern) => pattern.test(text)) ||
      ARITHMETIC_HINDI.some((pattern) => pattern.test(text))
    );
  }
  if (!CALCULATOR_EXPLICIT.test(text)) return false;
  return ARITHMETIC.some((pattern) => pattern.test(text));
}

export function detectUnitConversion(text: string): boolean {
  if (!text) return false;
  const parsed = parseConversionRequest(text);
  if (!parsed) return false;
  const from = findUnit(parsed.from);
  const to = findUnit(parsed.to);
  if (!from || !to) return false;
  return from.category === to.category;
}

export function detectCurrency(text: string): boolean {
  if (!text) return false;
  const parsed = parseCurrencyRequest(text);
  if (!parsed) return false;
  return normalizeCurrency(parsed.from) !== null && normalizeCurrency(parsed.to) !== null;
}

const MAPS_EXPLICIT: RegExp[] = [
  /\b(?:directions|route|navigate)\s+to\b/i,
  /\bmap\s+of\b/i,
  /\bhow\s+do\s+i\s+get\s+to\b/i,
];
const MAPS_NEAREST = /\bwhere\s+is\s+the\s+(?:nearest|closest|best)\b/i;

export function detectMaps(text: string): boolean {
  if (!text) return false;
  return MAPS_EXPLICIT.some((pattern) => pattern.test(text)) || MAPS_NEAREST.test(text);
}

const NEWS_PATTERNS =
  /\b(?:news|headlines?|top\s+stories?|what'?s\s+happening\s+in\s+the\s+world|tech\s+news|today'?s\s+news)\b/i;
const NEWS_HINDI = /(?<!\p{Script=Devanagari})(?:खबर|समाचार|ताज़ा\s+खबर)(?!\p{Script=Devanagari})/u;
const NEWS_HINGLISH = /\b(?:khabar|news)\b/i;

export function detectNews(text: string): boolean {
  if (!text) return false;
  return (
    NEWS_PATTERNS.test(text) ||
    NEWS_HINDI.test(text) ||
    NEWS_HINGLISH.test(text)
  );
}

const SEARCH_PATTERNS =
  /\b(?:search\s+(?:the\s+web\s+)?(?:for\s+)?|look\s+it?\s+up|look\s+up|google\s+|web\s+search\s+(?:for\s+)?|find\s+out)\b/i;
const SEARCH_HINDI = /(?:सर्च\s+करो|ढूँढो|खोजो|इंटरनेट\s+पर\s+देखो)/u;
const SEARCH_HINGLISH = /\b(?:search\s+karo|google\s+karo|internet\s+par\s+dekho)\b/i;

export function detectWebSearch(text: string): boolean {
  if (!text) return false;
  return (
    SEARCH_PATTERNS.test(text) ||
    SEARCH_HINDI.test(text) ||
    SEARCH_HINGLISH.test(text)
  );
}

/**
 * Factual-knowledge phrasing ("Who is the prime minister of India now?",
 * "What is the capital of France?"). A wh-word directly followed by a
 * knowledge verb signals a question that needs a real source — the reasoning
 * model has no live knowledge and would hallucinate it. Routed to web_search.
 * Identity/meta questions about JARVIS itself are excluded so they stay on the
 * reasoning model.
 */
const KNOWLEDGE_PHRASING: RegExp[] = [
  /\b(?:who|what|when|where|which|whom)\b\s+(?:is|are|was|were|did|does|do|has|have|became|happened|invented|founded|discovered|won|wrote|made|created|killed|died|born|elected|nominated|appointed)\b/i,
  /\bwhich\s+[\w-]+\s+(?:is|are|was|were|has|have|won|had|did|does|do|became)\b/i,
  /\bwho\s+won\b/i,
];

const KNOWLEDGE_EXCLUSIONS: RegExp[] = [
  /\bwho\s+are\s+you\b/i,
  /\bwho\s+am\s+i\b/i,
  /\bwhere\s+are\s+you\b/i,
  /\bwhat\s+are\s+you\b/i,
  /\bwhat\s+can\s+you\s+do\b/i,
  /\bwhat(?:'?s|\s+is)\s+(?:your|ur)\s+(?:name|age|problem|issue|favourite|favorite|name\s*\.?)\b/i,
  /\bwhat(?:'?s|\s+is)\s+(?:the\s+|today(?:'?s)?\s+)?(?:time|date|weather|news|forecast)\b/i,
  /\bwhat(?:'?s|\s+is)\s+(?:up|new|going\s+on|cooking|happening|next)\b/i,
  /\bwhat(?:'?s|\s+is)\s+\d[\d,.\s]*\b/i,
  /\bwhat\s+time\s+(?:does|do|is|are|was|were|will|should)\s+(?:my|our|your)\b/i,
  /\bwhat\s+do\s+you\s+(?:think|mean|want|need)\b/i,
  /\bwhat\s+about\s+(?:you|u)\b/i,
  /\bwhat\s+happened\s+to\s+you\b/i,
];

export function detectKnowledge(text: string): boolean {
  if (!text) return false;
  if (KNOWLEDGE_EXCLUSIONS.some((pattern) => pattern.test(text))) return false;
  return KNOWLEDGE_PHRASING.some((pattern) => pattern.test(text));
}

const SYSTEM_STATUS_PATTERNS: RegExp[] = [
  /\b(?:cpu|processor)\s+(?:usage|load|percent|percentage|utilization|speed|model|cores)\b/i,
  /\b(?:ram|memory)\s+(?:usage|used|available|free|left|remaining|percent)\b/i,
  /\bhow\s+much\s+(?:ram|memory|disk|storage|space)\b/i,
  /\b(?:disk|storage|hard\s+drive|ssd|drive)\s+(?:usage|space|free|left|available|full)\b/i,
  /\bhow\s+is\s+the\s+(?:cpu|memory|disk|storage|system)\b/i,
  /\bsystem\s+status\b/i,
  /\b(?:network|wifi|internet)\s+(?:status|connection|connected|speed|down|up)\b/i,
  /\bhow\s+fast\s+is\s+the\s+(?:cpu|processor)\b/i,
  /(?:सीपीयू|रैम|मेमोरी|स्टोरेज|डिस्क|नेटवर्क|वाई-फाई|सिस्टम)\s+(?:कितना|कितनी|कैसा|कैसी|उपयोग|स्थिति)/u,
  /कितना\s+(?:रैम|मेमोरी|स्टोरेज|डिस्क)\s+खाली\s+है/u,
  /\bcpu\s+(?:kitna|kitni)\b/i,
  /\bram\s+(?:kitni|kitna)\b/i,
];

export function detectSystemStatus(text: string): boolean {
  if (!text) return false;
  return SYSTEM_STATUS_PATTERNS.some((pattern) => pattern.test(text));
}

const MEMORY_STORE_PATTERNS =
  /\b(?:remember|note\s+down|note\s+that|don'?t\s+forget|do\s+not\s+forget|store\s+in\s+memory)\s+(?:that|this|to|the|my|i|we)?/i;
const MEMORY_RECALL_PATTERNS =
  /\b(?:what\s+do\s+you\s+remember|search\s+(?:your\s+)?memory|recall|my\s+(?:preferences?|favorite|favourites?|goals?|routine|name)\b)/i;
const MEMORY_STORE_HINDI =
  /(?:याद\s+रखना|याद\s+रखो|याद\s+रख|नोट\s+कर\s+लो|नोट\s+कर|मुझे\s+याद\s+रख|याद\s+रहे|भूलना\s+नहीं)/u;
const MEMORY_RECALL_HINDI =
  /(?:क्या\s+याद\s+है|याद\s+करके\s+बताओ|मेरी\s+पसंद\s+क्या\s+है|मेरी\s+पसंद\s+क्या|तुम्हें\s+क्या\s+याद\s+है|मेरे\s+बारे\s+में\s+क्या\s+जानते|क्या\s+जानते\s+हो\s+मेरे)/u;
const MEMORY_STORE_HINGLISH =
  /\b(?:yaad\s+(?:rakhna|rakho|rakh)|note\s+kar\s+lo|note\s+kar|mujhe\s+yaad)\b/i;
const MEMORY_RECALL_HINGLISH =
  /\b(?:kya\s+yaad\s+hai|yaad\s+karke\s+batao|meri\s+pasand\s+kya\s+hai|tumhe\s+kya\s+yaad\s+hai|mere\s+bare\s+mein\s+kya\s+jaante)\b/i;

export function detectMemoryStore(text: string): boolean {
  if (!text) return false;
  return (
    MEMORY_STORE_PATTERNS.test(text) ||
    MEMORY_STORE_HINDI.test(text) ||
    MEMORY_STORE_HINGLISH.test(text)
  );
}

export function detectMemoryRecall(text: string): boolean {
  if (!text) return false;
  return (
    MEMORY_RECALL_PATTERNS.test(text) ||
    MEMORY_RECALL_HINDI.test(text) ||
    MEMORY_RECALL_HINGLISH.test(text)
  );
}

export function detectMemory(text: string): boolean {
  return detectMemoryStore(text) || detectMemoryRecall(text);
}

const TASK_CREATE_PATTERNS: RegExp[] = [
  /\b(?:remind\s+me|remind\s+us)\b/i,
  /\b(?:create|add|make|schedule|set)\s+(?:a|an|the)?\s*(?:task|reminder|todo|to-do|alarm|event)\b/i,
  /(?:याद\s+दिलाना|रिमाइंडर\s+(?:बनाओ|सेट\s+करो)|अलार्म\s+(?:लगाओ|सेट\s+करो)|काम\s+(?:बनाओ|जोड़ो)|टास्क\s+(?:बनाओ|जोड़ो)|कार्य\s+जोड़ो)/u,
  /\b(?:yaad\s+dilana|reminder\s+(?:banao|set\s+karo)|alarm\s+(?:laga\s+do|set\s+karo)|task\s+(?:banao|add\s+karo)|kaam\s+yaad\s+dilana)\b/i,
];
const TASK_LIST_PATTERNS: RegExp[] = [
  /\b(?:what\s+(?:tasks|reminders|todos|to-dos)\s+do\s+i\s+have|list\s+(?:my\s+)?(?:tasks|reminders|todos)|show\s+(?:my\s+)?(?:tasks|reminders))\b/i,
  /(?:क्या\s+काम\s+है|मेरे\s+काम\s+क्या\s+हैं|टास्क\s+क्या\s+है|रिमाइंडर\s+दिखाओ|काम\s+की\s+लिस्ट)/u,
  /\b(?:kya\s+kaam\s+hai|mere\s+kaam|task\s+kya\s+hai|reminder\s+dikhao|kaam\s+ki\s+list)\b/i,
];
const TASK_ACTION_PATTERNS: RegExp[] = [
  /\b(?:run|cancel|delete|remove|retry|complete)\s+(?:the\s+)?(?:task|reminder)\b/i,
  /\btask\s+(?:engine|manager|status)\b/i,
  /(?:काम\s+रद्द|टास्क\s+रद्द|टास्क\s+खत्म|काम\s+खत्म)/u,
  /\b(?:kaam\s+cancel|task\s+cancel|task\s+complete|kaam\s+khatam)\b/i,
];

export function detectTaskCreate(text: string): boolean {
  if (!text) return false;
  return TASK_CREATE_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTaskList(text: string): boolean {
  if (!text) return false;
  return TASK_LIST_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTaskAction(text: string): boolean {
  if (!text) return false;
  return TASK_ACTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTasks(text: string): boolean {
  return detectTaskCreate(text) || detectTaskList(text) || detectTaskAction(text);
}

/**
 * System-tool detectors — folded in from the legacy intent router. They gate
 * the four client-gated facts (system clock, geolocation, weather, battery)
 * plus OCR, all still resolved deterministically before any model call.
 */

const OCR_PATTERNS: RegExp[] = [
  /\bocr\b/i,
  /\bread\s+(?:the\s+)?(?:text|screen|page|sign|label|letter|word|writing|note|document|card|poster|whiteboard)\b/i,
  /\bwhat\s+does\s+the\s+(?:text|screen|page|sign|label|paper|note|card|poster)\s+say\b/i,
  /\bwhat\s+does\s+it\s+say\b/i,
  /\bwhat'?s\s+(?:it\s+|this\s+|that\s+)?say(?:ing)?\b/i,
  /\btext\s+on\s+(?:this|that|the|my)\b/i,
  /\bwhat\s+is\s+written\b/i,
  /(?:स्क्रीन|पेज|कागज़|पेपर)\s+पर\s+क्या\s+लिखा\s+है/u,
  /पढ़कर\s+बताओ/u,
  /\b(?:screen|page|paper)\s+par\s+kya\s+likha\s+hai\b/i,
];

const TIME_PATTERNS: RegExp[] = [
  /\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?time\b/i,
  /\bwhat\s+time\s+is\s+it\b/i,
  /\bwhat'?s\s+the\s+time\b/i,
  /\bcurrent\s+time\b/i,
  /\btime\s+now\b/i,
  /\btell\s+me\s+(?:the\s+)?(?:current\s+)?time\b/i,
  /\bgive\s+me\s+(?:the\s+)?(?:current\s+)?time\b/i,
  /\btime\s+zone\b/i,
  /\btimezone\b/i,
  /(?:कितने\s+बजे|समय\s+क्या|टाइम\s+क्या|अभी\s+कितने\s+बजे|क्या\s+समय|क्या\s+टाइम)/u,
  /(?:समय|टाइम)\s+बताओ/u,
  /(?:समय\s+क्या\s+हुआ|टाइम\s+क्या\s+हुआ)/u,
  /कितने\s+बजे\s+रहे\s+हैं/u,
  /\b(?:kya\s+time\s+(?:hua|hai|h)|time\s+kya\s+(?:hua|hai|h)|kitne\s+baje\s+(?:hain|hue|hai)|samay\s+batao|abhi\s+time)\b/i,
];

const DATE_PATTERNS: RegExp[] = [
  /\bwhat(?:'s|\s+is)\s+(?:the\s+|today'?s\s+)?date\b/i,
  /\bwhat\s+date\s+is\s+(?:it\s+)?today\b/i,
  /\bwhat\s+date\s+is\s+it\b/i,
  /\btoday'?s\s+date\b/i,
  /\bcurrent\s+date\b/i,
  /\bwhat\s+day\s+is\s+(?:it|today)\b/i,
  /\bwhat\s+day\s+of\s+the\s+week\s+is\s+it\b/i,
  /\btell\s+me\s+(?:the\s+)?(?:current\s+)?date\b/i,
  /\bgive\s+me\s+(?:the\s+)?(?:current\s+)?date\b/i,
  /(?:आज\s+कौन\s+सी\s+तारीख|आज\s+की\s+तारीख|आज\s+तारीख\s+क्या|तारीख\s+क्या\s+है|कौन\s+सी\s+तारीख|कौन\s+सा\s+दिन)/u,
  /आज\s+क्या\s+(?:तारीख|दिन)\s+है/u,
  /\b(?:aaj\s+ki\s+tarikh|aaj\s+kya\s+tarikh|tarikh\s+kya\s+(?:hai|h)|kaun\s+si\s+tarikh|kaun\s+sa\s+din)\b/i,
];

const GEOLOCATION_PATTERNS: RegExp[] = [
  /\bwhere\s+am\s+i\b/i,
  /\bwhere\s+are\s+(?:we|you)\b/i,
  /\bwhere\s+am\s+i\s+located\b/i,
  /\bwhere\s+is\s+my\s+location\b/i,
  /\bmy\s+location\b/i,
  /\bcurrent\s+location\b/i,
  /\bwhat\s+(?:city|town|state|region|country|area)\s+(?:am\s+i|are\s+we)\s+in\b/i,
  /\bwhich\s+(?:city|town|state|region|country)\s+(?:am\s+i|are\s+we)\s+in\b/i,
  /\bwhat\s+(?:city|state|country)\s+is\s+this\b/i,
  /\bgeolocat/i,
  /\blocate\s+me\b/i,
  /(?:मैं\s+कहाँ\s+हूँ|हम\s+कहाँ\s+हैं|मेरा\s+लोकेशन|कौन\s+से\s+शहर\s+में\s+हूँ)/u,
  /\b(?:main\s+kahan\s+hoon|hum\s+kahan\s+hain|mera\s+location|kis\s+sheher\s+mein\s+hoon)\b/i,
];

const WEATHER_PATTERNS: RegExp[] = [
  /\bweather\b/i,
  /\bforecast\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?(?:temperature|temp|weather|forecast)\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:high|low)\b.*\b(?:today|tomorrow|outside|right\s+now)\b/i,
  /\btemperatures?\s+(?:outside|today|right\s+now|out\s+there|there)\b/i,
  /\b(?:is\s+it|will\s+it|does\s+it|is\s+there)\s+(?:rain(?:ing)?|snow(?:ing)?|hot|cold|warm|cool|sunny|cloudy|overcast|windy|foggy|stormy|humid)\b/i,
  /\bhow\s+(?:hot|cold|warm|cool|rainy|sunny|cloudy|windy|foggy)\s+is\s+it(?:\s+(?:outside|today|right\s+now))?\b/i,
  /\bhow'?s\s+(?:the\s+)?(?:weather|temperature|forecast)\b/i,
  /\braining\b/i,
  /\bsunny\b/i,
  /\bcloudy\b/i,
  /\bovercast\b/i,
  /(?<!\p{Script=Devanagari})मौसम(?!\p{Script=Devanagari})/u,
  /(?<!\p{Script=Devanagari})तापमान(?!\p{Script=Devanagari})/u,
  /(?<!\p{Script=Devanagari})बारिश(?!\p{Script=Devanagari})/u,
  /(?<!\p{Script=Devanagari})(?:धूप|बादल|गर्मी|सर्दी|हवा|तूफान)(?!\p{Script=Devanagari})/u,
  /(?:मौसम\s+कैसा\s+है|आज\s+बारिश\s+होगी)/u,
  /(?:कितना\s+गर्म\s+है|कितनी\s+सर्दी\s+है|गर्मी\s+है|सर्दी\s+है)/u,
  /\b(?:mausam|baarish|garmi|sardi|dhoop|tapman)\b/i,
  /\b(?:kaisa\s+mausam|weather\s+kaisa)\b/i,
];

const BATTERY_PATTERNS: RegExp[] = [
  /\bbattery\s+(?:level|life|percentage|charge|status|left|remaining|health)\b/i,
  /\bbattery\s+is\s+(?:low|full|draining|dying|dead|charged|at)\b/i,
  /\bbattery\s+at\b/i,
  /\bpower\s+level\b/i,
  /\bhow\s+much\s+(?:battery|power|charge)\s+(?:do\s+(?:i|we)\s+have|is\s+left|is\s+remaining|left|do\s+i\s+have)\b/i,
  /\b(?:battery|charge)\s+left\b/i,
  /\bcharging\s+status\b/i,
  /\bcheck\s+(?:the\s+|my\s+)?battery\b/i,
  /\bhow\s+(?:is|does)\s+(?:my|the)\s+battery\b/i,
  /(?<!\p{Script=Devanagari})बैटरी(?!\p{Script=Devanagari})/u,
  /(?:बैटरी\s+कितनी|बैटरी\s+कैसी|बैटरी\s+कितना)/u,
  /\bbattery\s+(?:kitni|kya|kaisa)\b/i,
];

/** Calendar/schedule — what is on the user's calendar. */
const CALENDAR_PATTERNS: RegExp[] = [
  /\bwhat(?:'s|\s+is)\s+(?:on\s+my\s+|in\s+my\s+|my\s+)?(?:calendar|schedule)\b/i,
  /\b(?:calendar|schedule)\s+(?:today|tomorrow|this\s+week|this\s+weekend|this\s+month)\b/i,
  /\b(?:any|what|do\s+i\s+have\s+any)\s+(?:appointments?|meetings?|events?)\s+(?:today|tomorrow|this\s+week|coming\s+up|scheduled|on\s+my\s+(?:calendar|schedule))\b/i,
  /\bwhat\s+do\s+i\s+have\s+(?:coming\s+up|on\s+my\s+(?:calendar|schedule)|scheduled|planned)\b/i,
  /\bwhat\s+(?:am\s+i\s+doing|do\s+i\s+have)\s+(?:today|tomorrow|this\s+week)\b/i,
  /\bwhat\s+(?:appointments?|meetings?|events?)\s+do\s+i\s+have(?:\s+(?:today|tomorrow|this\s+week|this\s+weekend|scheduled|planned|coming\s+up))?\b/i,
  /\b(?:show|list)\s+(?:me\s+)?my\s+(?:appointments?|meetings?|events?|calendar|schedule)\b/i,
  /(?:आज\s+मेरा\s+शेड्यूल|आज\s+का\s+शेड्यूल|कल\s+का\s+शेड्यूल|कल\s+क्या\s+करना\s+है|अगले\s+सोमवार|परसों|कल\s+सुबह|आज\s+शाम)/u,
  /(?<!\p{Script=Devanagari})शेड्यूल(?!\p{Script=Devanagari})/u,
  /(?<!\p{Script=Devanagari})कैलेंडर(?!\p{Script=Devanagari})/u,
  /(?<!\p{Script=Devanagari})(?:मीटिंग|अपॉइंटमेंट)(?!\p{Script=Devanagari})/u,
  /क्या\s+करना\s+है/u,
  /\b(?:aaj\s+ka\s+schedule|kal\s+ka\s+schedule|schedule\s+kya|aaj\s+mera\s+schedule|kal\s+subah|aaj\s+shaam|parson)\b/i,
  /\b(?:aaj|kal)\s+kya\s+karna\s+hai\b/i,
];

/** Owner profile — verified facts stored about the user. */
const PROFILE_PATTERNS: RegExp[] = [
  /\bwhat\s+do\s+you\s+know\s+about\s+me\b/i,
  /\btell\s+me\s+about\s+(?:myself|me)\b/i,
  /\bwho\s+am\s+i\b/i,
  /\bwhat\s+is\s+my\s+(?:name|nickname|email|occupation|job|work|birthday|address|phone|number|skills?|interests?|goals?|profession)\b/i,
  /\bwhat'?s\s+my\s+(?:name|nickname|email|occupation|job|work|birthday|address|phone|skills?|interests?|goals?|profession)\b/i,
  /\bwhat\s+are\s+my\s+(?:preferences?|interests?|hobbies?|goals?)\b/i,
  /(?:मेरा\s+नाम\s+क्या\s+है|मैं\s+कौन\s+हूँ|मेरे\s+बारे\s+में\s+क्या\s+जानते\s+हो|मेरा\s+पेशा\s+क्या\s+है|मेरा\s+काम\s+क्या\s+है)/u,
  /\b(?:mera\s+naam\s+kya\s+hai|main\s+kaun\s+hoon|mere\s+bare\s+mein\s+kya\s+jaante\s+ho|mera\s+pesha\s+kya\s+hai)\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectOcr(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, OCR_PATTERNS);
}

/**
 * Date-calculation phrasing — a question about the WEEKDAY (or day count) of a
 * SPECIFIC date ("What day is 15 Aug 2026?", "How many days until 15 Aug
 * 2026?"). Only matches when a concrete date token is present, so it can never
 * hijack current-date questions ("what day is it today?") — those have no date
 * token and are handled by detectDate.
 */
const DATE_CALC_PHRASING: RegExp[] = [
  /\bwhat\s+day\b/i,
  /\bwhat\s+weekday\b/i,
  /\bwhich\s+day\b/i,
  /\bday\s+of\s+the\s+week\b/i,
  /\b(?:days?|din)\s+(?:until|till|since|between)\b/i,
  /\bhow\s+many\s+days\b/i,
  /\b(?:kitne\s+din|kaun\s+sa\s+din|kis\s+din)\b/i,
  /(?:कौन\s+सा\s+दिन|किस\s+दिन|कितने\s+दिन)/u,
];

export function detectDateCalc(text: string): boolean {
  if (!text) return false;
  if (extractDateTokens(text).length === 0) return false;
  return DATE_CALC_PHRASING.some((pattern) => pattern.test(text));
}

/**
 * Follow-up corrections ("No, check again.", "that's wrong", "verify"). A date
 * correction must re-run the deterministic date tool — never an LLM guess. The
 * pipeline only honors this when a prior user message contains a date question.
 */
const DATE_CORRECTION_PATTERNS: RegExp[] = [
  /\bno\b[^.,!?]{0,40}\b(?:check|verify|recheck|right|sure|wrong)\b/i,
  /\b(?:check\s+(?:it\s+)?again|recheck|re-check|double\s+check|verify|are\s+you\s+sure|that'?s\s+wrong|that'?s\s+not\s+right)\b/i,
  /\bwrong\b/i,
  /\b(?:galat\s+(?:hai|h)|phir\s+(?:se\s+)?check\s+karo|phir\s+se\s+dekho|sach\s+mein)\b/i,
  /(?:फिर\s+(?:से\s+)?चेक\s+करो|गलत\s+है|फिर\s+से\s+देखो|पक्का\s+नहीं|सच\s+में)/u,
];

export function detectDateCorrection(text: string): boolean {
  if (!text) return false;
  return DATE_CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function detectTime(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, TIME_PATTERNS);
}

export function detectDate(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, DATE_PATTERNS);
}

/** Combined clock detector (time or date) — kept for compatibility. */
export function detectSystemClock(text: string): boolean {
  return detectTime(text) || detectDate(text);
}

export function detectGeolocation(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, GEOLOCATION_PATTERNS);
}

export function detectWeather(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, WEATHER_PATTERNS);
}

export function detectBattery(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, BATTERY_PATTERNS);
}

export function detectCalendar(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, CALENDAR_PATTERNS);
}

export function detectProfile(text: string): boolean {
  if (!text) return false;
  return matchesAny(text, PROFILE_PATTERNS);
}
