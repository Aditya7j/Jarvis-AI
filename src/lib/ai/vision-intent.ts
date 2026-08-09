/**
 * Fast, dependency-free intent classifier. Decides whether the user's prompt
 * needs a live camera/screen frame. Runs synchronously (sub-millisecond) so it
 * never adds latency to the request path.
 */

export type VisionIntent = "vision" | "text";

export type VisionDepth = "simple" | "complex";

/**
 * Prompts that need Gemma-level reasoning/detail. Checked BEFORE the simple
 * patterns so e.g. "describe what you see in detail" routes to Gemma instead of
 * the YOLO cache.
 */
const COMPLEX_PATTERNS: RegExp[] = [
  /\bdescribe\b/i,
  /\banalyz?e\b/i,
  /\bsummariz/i,
  /\bexplain\b/i,
  /\btell\s+me\s+about\b/i,
  /\bwhat\s+(am\s+i\s+)?doing\b/i,
  /\bwhat'?s\s+happening\b/i,
  /\bwhat\s+is\s+happening\b/i,
  /\bwhat\s+can\s+you\s+tell\s+me\b/i,
  /\bwhat\s+do\s+you\s+notice\b/i,
  /\bin\s+detail\b/i,
  /\bscene\b/i,
  /\broom\b/i,
  /\bcontext\b/i,
  /\beverything\b/i,
  /\breading\b/i,
  /\bread\s+the\s+(text|screen|page)\b/i,
  /\bwhat\s+does\s+the\s+(text|screen|page|sign|label)\s+say\b/i,
  /\btext\s+(says?|reads?)\b/i,
  /\bwhy\b/i,
  /\bhow\s+(do|can|should|would|come)\b/i,
  /\bwhat\s+should\b/i,
  /\bsuggest\b/i,
  /\brecommend\b/i,
  /\bmood\b/i,
  /\bemotion\b/i,
  /\bfeelings?\b/i,
  /\bdoing\b/i,
  /विस्तार\s+से/u,
  /क्या\s+हो\s+रहा\s+है/u,
  /क्या\s+चल\s+रहा\s+है/u,
  /\b(?:detail\s+mein\s+batao|poora\s+batao|describe\s+karo|kya\s+ho\s+raha\s+hai)\b/i,
];

/**
 * Prompts answerable directly from the YOLO vision-state cache (no Gemma).
 * Anything vision-related that is not matched here is treated as complex.
 */
const SIMPLE_PATTERNS: RegExp[] = [
  /\b(do|can|could|did|are|will)\s+(you|u)\s+see\s+(me|us|anyone|anybody|someone)\b/i,
  /\bwhat\s+am\s+i\s+holding\b/i,
  /\bwhat\s+am\s+i\s+wearing\b/i,
  /\b(?:i'?m|i\s+am|you'?re|you\s+are|am\s+i|are\s+you|we'?re)\s+holding\b/i,
  /\bin\s+my\s+(hand|hands|lap)\b/i,
  /\bwearing\b/i,
  /\bshirt\b/i,
  /\bhoodie\b/i,
  /\bjacket\b/i,
  /\bclothes\b/i,
  /\bclothing\b/i,
  /\boutfit\b/i,
  /\bwhat\s+color\b/i,
  /\bcolor\s+of\b/i,
  /\bhow\s+many\s+(people|person|persons|men|women|students|of\s+us|objects|things|items)\b/i,
  /\b(am\s+i|are\s+you)\s+alone\b/i,
  /\banyone\s+(else|there|here)\b/i,
  /\banybody\s+(else|there|here)\b/i,
  /\bwhat('s|s|\s+is)\s+on\s+(my\s+)?(desk|table|screen|monitor)\b/i,
  /\bwhat\s+do\s+you\s+see\b/i,
  /\bwhat\s+can\s+you\s+see\b/i,
  /\bwhat\s+is\s+(in\s+)?front\s+of\s+(me|you)\b/i,
  /\b(do\s+you\s+see|can\s+you\s+see|see\s+my)\s+(phone|cell|mobile|laptop|keys|bottle|cup|mug|book|watch|glasses|headphones|remote|mouse|keyboard)\b/i,
  /\b(is|are)\s+there\s+(a|an|any)\s+(phone|bottle|cup|mug|laptop|book|keyboard|mouse|remote|person|people)\b/i,
  /\b(phone|bottle|cup|mug|laptop|book|keyboard|mouse|remote)\s+(on\s+my\s+desk|on\s+the\s+desk|in\s+front)\b/i,
  /\bflag\b/i,
  /\bindian\s+flag\b/i,
  /क्या\s+तुम\s+मुझे\s+देख\s+(?:सकते\s+हो|सकती\s+हो|रहे\s+हो|रही\s+हो)/u,
  /मैं\s+क्या\s+पहन\s+(?:रखा\s+हूँ|रहा\s+हूँ|रही\s+हूँ)/u,
  /मैंने\s+क्या\s+पहन\s+रखा\s+है/u,
  /मेरे\s+हाथ\s+में\s+क्या\s+है/u,
  /हाथ\s+में\s+क्या\s+(?:है|पकड़ा\s+है)/u,
  /स्क्रीन\s+पर\s+क्या\s+(?:दिख\s+रहा|चल\s+रहा)\s+है/u,
  /क्या\s+दिख\s+रहा\s+है/u,
  /मेरे\s+सामने\s+क्या\s+है/u,
  /\b(?:kya\s+tum\s+mujhe\s+dekh\s+(?:sakte|sakti|rahe|rahi)\s+ho)\b/i,
  /\b(?:main\s+kya\s+pehna\s+hoon|maine\s+kya\s+pehena\s+hai)\b/i,
  /\b(?:mere\s+haath\s+mein\s+kya\s+hai|haath\s+mein\s+kya\s+hai)\b/i,
  /\b(?:screen\s+par\s+kya\s+(?:dikh\s+raha|chal\s+raha)\s+hai|kya\s+dikh\s+raha\s+hai|mere\s+saamne\s+kya\s+hai)\b/i,
];

/** Classify how a vision prompt should be served: cache or Gemma. */
export function classifyVisionDepth(prompt: string): VisionDepth {
  if (!prompt) return "complex";
  if (COMPLEX_PATTERNS.some((pattern) => pattern.test(prompt))) return "complex";
  if (SIMPLE_PATTERNS.some((pattern) => pattern.test(prompt))) return "simple";
  return "complex";
}

/**
 * Unambiguous vision phrases. These win even when the sentence contains a
 * negation ("Don't you see the cat?" is still a vision question).
 */
const STRONG_PATTERNS: RegExp[] = [
  /\b(can|could|do|did|would|will)\s+(you|u)\s+see\b/i,
  /\b(?:don'?t|can'?t|couldn'?t|wouldn'?t)\s+you\s+see\b/i,
  /\bwhat\s+do\s+you\s+see\b/i,
  /\bwhat\s+can\s+you\s+see\b/i,
  /\bwhat\s+am\s+i\s+(wearing|holding)\b/i,
  /\bwhat\s+(am\s+i|are\s+you)\s+(wearing|holding)\b/i,
  /\bwhat\s+(is|was)\s+on\s+(my\s+)?(screen|display|monitor)\b/i,
  /\bon\s+(my\s+)?(screen|display|monitor)\b/i,
  // "what is this/that" is only a pointing question when it is terminal or
  // points at a visible object — "what is that movie" is a reference question,
  // not a camera request.
  /\bwhat(?:'s|s|\s+is)\s+(?:this|that)\b(?:\s+(?:on|in|at|near)\s+(?:the\s+|my\s+)?(?:screen|desk|table|hand|room|wall|floor|shelf|monitor|phone|paper|bottle|cup|box))?[?.!,]*\s*$/i,
  /\bwhat\s+(is|was)\s+visible\b/i,
  /\btell\s+me\s+what\s+you\s+see\b/i,
  /\bcan\s+you\s+(?:tell\s+me\s+what\s+you\s+see|describe\s+(?:what\s+you\s+see|this\s+(?:image|picture|photo|view|frame)|the\s+(?:scene|room|camera|screen|view|desk|table)))\b/i,
  /क्या\s+तुम\s+मुझे\s+देख\s+(?:सकते\s+हो|सकती\s+हो|रहे\s+हो|रही\s+हो)/u,
  /तुम\s+मुझे\s+देख\s+रहे\s+हो/u,
  /मैं\s+क्या\s+पहन\s+(?:रखा\s+हूँ|रहा\s+हूँ|रही\s+हूँ)/u,
  /मैंने\s+क्या\s+पहन\s+रखा\s+है/u,
  /मेरे\s+हाथ\s+में\s+क्या\s+है/u,
  /हाथ\s+में\s+क्या\s+(?:है|पकड़ा\s+है)/u,
  /स्क्रीन\s+पर\s+क्या\s+(?:दिख\s+रहा|चल\s+रहा)\s+है/u,
  /क्या\s+दिख\s+रहा\s+है/u,
  /मेरे\s+सामने\s+क्या\s+है/u,
  /\b(?:kya\s+tum\s+mujhe\s+dekh\s+(?:sakte\s+ho|sakti\s+ho|rahe\s+ho|rahi\s+ho)|tum\s+mujhe\s+dekh\s+rahe\s+ho)\b/i,
  /\b(?:main\s+kya\s+pehna\s+hoon|maine\s+kya\s+pehena\s+hai)\b/i,
  /\b(?:mere\s+haath\s+mein\s+kya\s+hai|haath\s+mein\s+kya\s+hai)\b/i,
  /\b(?:screen\s+par\s+kya\s+(?:dikh\s+raha|chal\s+raha)\s+hai|kya\s+dikh\s+raha\s+hai|mere\s+saamne\s+kya\s+hai)\b/i,
];

/**
 * Instruction-like phrases that are gated by negation ("Don't look at the
 * screen" must NOT trigger vision).
 */
const CONDITIONAL_PATTERNS: RegExp[] = [
  /\bdescribe\s+(this\s+(image|picture|photo|view|frame)|what\s+you\s+see|the\s+(camera|screen|room|scene))\b/i,
  /\btake\s+a\s+look\b/i,
  /\blook\s+at\s+(this|that|my|the\s+(camera|screen))\b/i,
  // OCR / text-on-camera and national-flag questions are unambiguous visual
  // requests, but remain negation-gated ("don't read the screen" is text).
  /\bread\s+(?:the\s+)?(?:text|paper|screen|page|sign|label|letter|word|writing|note|document|card|poster|whiteboard|board)s?\b/i,
  /\bwhat\s+does\s+the\s+(?:text|screen|page|sign|label|paper|note|card|poster)\s+say\b/i,
  /\bwhat\s+does\s+it\s+say\b(?!\s+(?:about|regarding|on)\b)/i,
  /\bwhat('s|s)\s+(?:it\s+|this\s+|that\s+)?say\b/i,
  /\btext\s+on\s+(?:this|that|the|my)\b/i,
  /\bwhat\s+is\s+written\b/i,
  /\bocr\b/i,
  /\bflag\b/i,
  /\bindian\s+flag\b/i,
  /क्या\s+पहना\s+है/u,
  /मेरे\s+आसपास\s+क्या\s+है/u,
  /कमरे\s+में\s+क्या\s+है/u,
  /मुझे\s+देखो/u,
  /मेरी\s+तरफ\s+देखो/u,
  /मेरा\s+कैमरा\s+देखो/u,
  /स्क्रीन\s+पर\s+क्या\s+लिखा\s+है/u,
  /पढ़कर\s+बताओ/u,
  /\b(?:mujhe\s+dekh|meri\s+taraf\s+dekh|mera\s+camera\s+dekh)\b/i,
  /\b(?:screen\s+par\s+kya\s+likha\s+hai|padhkar\s+batao)\b/i,
  /\b(?:mere\s+aaspaas\s+kya\s+hai|kamre\s+mein\s+kya\s+hai)\b/i,
];

const WEAK_PATTERNS: RegExp[] = [
  /\bwearing\b/i,
  /\b(?:i'?m|i\s+am|you'?re|you\s+are|am\s+i|are\s+you|we'?re)\s+holding\b/i,
  /\bshirt\b/i,
  /\bjacket\b/i,
  /\bhoodie\b/i,
  /\bclothes\b/i,
  /\bclothing\b/i,
  /\boutfit\b/i,
  /\bwhat\s+color\b/i,
  /\bcolor\s+of\b/i,
  /\beyes\b/i,
  /\bglasses\b/i,
  /\bhairstyle\b/i,
  /\bbackground\b/i,
  /\bobjects?\b/i,
  /\bvisible\b/i,
  /\bsee\s+me\b/i,
  /\bwhat\s+do\s+you\s+notice\b/i,
  /\bwhat\s+(is|are)\s+you\s+(looking|staring)\s+at\b/i,
  /\bwhat\s+is\s+(in\s+)?front\s+of\s+(me|you)\b/i,
  /\bhow\s+many\s+(people|person|persons|men|women|students|of\s+us|objects|things|items)\b/i,
  /\b(am\s+i|are\s+(you|we))\s+alone\b/i,
  /\banyone\s+(else|there|here)\b/i,
  /\banybody\s+(else|there|here)\b/i,
  /\b(is|are)\s+there\s+(a|an|any)\s+(phone|bottle|cup|mug|laptop|book|keyboard|mouse|remote|person|people)\b/i,
  /\b(phone|bottle|cup|mug|laptop|book|keyboard|mouse|remote)\s+(on\s+(my\s+)?(desk|table|monitor)|in\s+front)\b/i,
  /देख\s+सकते\s+हो/u,
  /देख\s+रहे\s+हो/u,
  /\bdekh\s+sakte\s+ho\b/i,
  /\bdekh\s+rahe\s+ho\b/i,
];

const NEGATION: RegExp =
  /\b(don'?t|do\s+not|can'?t|cannot|shouldn'?t|ignore|stop|never|donot)\b/i;

/**
 * Classify whether a prompt requires visual input.
 * - Strong, unambiguous vision phrases always win.
 * - Negated instructions ("don't look at the screen") never trigger vision.
 * - Weak vision vocabulary triggers only when not negated.
 */
export function classifyVisionIntent(prompt: string): VisionIntent {
  if (!prompt) return "text";
  const text = prompt.trim();
  if (!text) return "text";
  if (STRONG_PATTERNS.some((pattern) => pattern.test(text))) return "vision";
  if (NEGATION.test(text)) return "text";
  if (CONDITIONAL_PATTERNS.some((pattern) => pattern.test(text))) return "vision";
  if (WEAK_PATTERNS.some((pattern) => pattern.test(text))) return "vision";
  return "text";
}
