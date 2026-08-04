import { classifyVisionIntent } from "./vision-intent";

/**
 * Intent Router — runs BEFORE the LLM. A deterministic, sub-millisecond
 * classifier that decides which verified tool must answer a request. The LLM
 * is the last resort (general conversation) and must never fabricate system
 * facts (time, date, location, battery, weather, network/system status); it
 * only naturalizes verified tool output.
 */

export type ToolIntent =
  | "ocr"
  | "vision"
  | "system-clock"
  | "geolocation"
  | "weather"
  | "battery"
  | "llm";

const TOOL_LABELS: Record<ToolIntent, string> = {
  ocr: "Vision Model",
  vision: "Vision Manager",
  "system-clock": "System Clock",
  geolocation: "Browser Geolocation API",
  weather: "Weather API",
  battery: "Battery Status API",
  llm: "LLM",
};

export function toolLabelFor(intent: ToolIntent): string {
  return TOOL_LABELS[intent];
}

export const GEOLOCATION_DENIED_REPLY =
  "I don't have access to your location. If you grant location permission, I can tell you where you are.";

export const BATTERY_DENIED_REPLY =
  "I don't have access to your device's battery information.";

export const WEATHER_NO_LOCATION_REPLY =
  "I don't have access to your location, so I can't check the weather. If you grant location permission, I can tell you the current conditions.";

export const WEATHER_FAILED_REPLY =
  "I couldn't fetch live weather data right now. Please try again in a moment.";

const OCR_PATTERNS: RegExp[] = [
  /\bocr\b/i,
  /\bread\s+(?:the\s+)?(?:text|screen|page|sign|label|letter|word|writing|note|document|card|poster|whiteboard)\b/i,
  /\bwhat\s+does\s+the\s+(?:text|screen|page|sign|label|paper|note|card|poster)\s+say\b/i,
  /\bwhat\s+does\s+it\s+say\b/i,
  /\bwhat'?s\s+(?:it\s+|this\s+|that\s+)?say(?:ing)?\b/i,
  /\btext\s+on\s+(?:this|that|the|my)\b/i,
  /\bwhat\s+is\s+written\b/i,
];

const CLOCK_PATTERNS: RegExp[] = [
  /\bwhat(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?time\b/i,
  /\bwhat\s+time\s+is\s+it\b/i,
  /\bcurrent\s+time\b/i,
  /\btime\s+now\b/i,
  /\bwhat(?:'s|\s+is)\s+(?:the\s+|today'?s\s+)?date\b/i,
  /\bwhat\s+date\s+is\s+it\b/i,
  /\btoday'?s\s+date\b/i,
  /\bcurrent\s+date\b/i,
  /\bwhat\s+day\s+is\s+(?:it|today)\b/i,
  /\bwhat\s+day\s+of\s+the\s+week\s+is\s+it\b/i,
  /\btime\s+zone\b/i,
  /\btimezone\b/i,
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
];

const WEATHER_PATTERNS: RegExp[] = [
  /\bweather\b/i,
  /\bforecast\b/i,
  /\bwhat(?:'s|\s+is)\s+the\s+(?:current\s+)?temperature\b/i,
  /\btemperatures?\s+(?:outside|today|right\s+now|out\s+there|there)\b/i,
  /\b(?:is\s+it|will\s+it|does\s+it)\s+rain(?:ing)?\b/i,
  /\braining\b/i,
  /\bsunny\b/i,
  /\bcloudy\b/i,
  /\bovercast\b/i,
  /\bhumidit/i,
  /\bwind(?:y|speed)\b/i,
  /\bclimate\b/i,
];

const BATTERY_PATTERNS: RegExp[] = [
  /\bbattery\b/i,
  /\bbattery\s+(?:level|life|percentage|charge)\b/i,
  /\bpower\s+level\b/i,
  /\bhow\s+much\s+(?:battery|power|charge)\s+(?:do\s+(?:i|we)\s+have|is\s+left|is\s+remaining|left)\b/i,
  /\b(?:battery|charge)\s+left\b/i,
  /\bcharging\s+status\b/i,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function detectOcr(text: string): boolean {
  return matchesAny(text, OCR_PATTERNS);
}

export function detectSystemClock(text: string): boolean {
  return matchesAny(text, CLOCK_PATTERNS);
}

export function detectGeolocation(text: string): boolean {
  return matchesAny(text, GEOLOCATION_PATTERNS);
}

export function detectWeather(text: string): boolean {
  return matchesAny(text, WEATHER_PATTERNS);
}

export function detectBattery(text: string): boolean {
  return matchesAny(text, BATTERY_PATTERNS);
}

/**
 * Precedence: OCR, then any camera/screen intent (reuses the vision
 * classifier), then the deterministic system tools, then the LLM. Vision wins
 * over the system tools because a live-view question must never be answered
 * from memory.
 */
export function classifyToolIntent(prompt: string): ToolIntent {
  if (!prompt) return "llm";
  const text = prompt.trim();
  if (!text) return "llm";
  if (detectOcr(text)) return "ocr";
  if (classifyVisionIntent(text) === "vision") return "vision";
  if (detectSystemClock(text)) return "system-clock";
  if (detectGeolocation(text)) return "geolocation";
  if (detectWeather(text)) return "weather";
  if (detectBattery(text)) return "battery";
  return "llm";
}

/**
 * The system block handed to the LLM alongside a verified tool output. The
 * fact is the ONLY source of truth; the model presents it naturally and never
 * claims to have measured, fetched or computed it.
 */
export function buildVerifiedFactContext(
  toolLabel: string,
  subject: string,
  fact: unknown
): string {
  return `Verified data from the ${toolLabel} tool — this is the ONLY source of truth for ${subject}:
${JSON.stringify(fact, null, 2)}
STRICT:
- ${subject[0].toUpperCase()}${subject.slice(1)} must come exclusively from the data above. Never guess, estimate, recall, infer or compute it yourself.
- Present it naturally to the user in your own words. Never claim you checked, measured, fetched, looked it up, or are "recalibrating".
- Do not invent values that are not in the data. If the data is missing something the user asked about, say you don't have access to that information.`;
}
