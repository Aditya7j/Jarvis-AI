/**
 * Localized canned replies — the "Language Formatter" for fallback paths that
 * never reach the LLM. These replies are emitted directly as tokens by the
 * pipeline (tool failures, denied permissions, unverifiable facts), so they are
 * rendered in the user's detected language instead of always English.
 *
 * LLM-produced answers are localized by the language instruction in the prompt;
 * these are only the deterministic, pre-model fallbacks.
 */

import type { SpokenLanguage } from "./detect";

export type CannedReplyKey =
  | "emptyPrompt"
  | "unverifiedFact"
  | "geolocationDenied"
  | "batteryDenied"
  | "weatherNoLocation"
  | "weatherFailed"
  | "toolUnavailable"
  | "visionCancelled"
  | "visionFailed"
  | "noCamera"
  | "noFrame"
  | "visionWarming"
  | "greeting"
  | "casual"
  | "howAreYou";

type ReplyTable = Record<CannedReplyKey, string>;

const ENGLISH: ReplyTable = {
  emptyPrompt: "I didn't catch what you asked.",
  unverifiedFact:
    "I can't verify that right now — I only answer live facts (time, date, weather, and similar) from verified data, and the source isn't available at the moment.",
  geolocationDenied:
    "I can't verify your location — location permission isn't granted. Grant it and I'll tell you where you are.",
  batteryDenied:
    "I can't verify the battery — the battery status API isn't available.",
  weatherNoLocation:
    "I can't verify the weather — I have no location data. Grant location permission and I'll check the current conditions.",
  weatherFailed:
    "I couldn't verify the weather — the weather source is unavailable right now.",
  toolUnavailable:
    "I couldn't verify that — the required source is unavailable right now. Try again in a moment.",
  visionCancelled: "I stopped that request before it finished.",
  visionFailed: "I couldn't verify the visual — the vision source failed.",
  noCamera:
    "I can't see your camera feed — no camera or screen source is connected. Turn one on and ask me again.",
  noFrame:
    "I don't have a frame to look at right now — your camera is on but no video is coming through. Give it a moment and try again.",
  visionWarming:
    "I just started looking — give me a second for the camera feed to come through, then ask me again.",
  greeting: "Hello! How can I help you today?",
  casual: "Got it! Let me know if you need anything else.",
  howAreYou: "I'm doing well, thank you! What can I help you with?",
};

const HINGLISH: ReplyTable = {
  emptyPrompt: "Mujhe samajh nahi aaya ki aapne kya kaha.",
  unverifiedFact:
    "Main abhi iski verify nahi kar sakta — live facts (time, date, weather) main verified data se hi batata hoon, aur abhi source available nahi hai.",
  geolocationDenied:
    "Main aapki location verify nahi kar sakta — location permission granted nahi hai. Grant karo, phir main bata dunga ki aap kahan ho.",
  batteryDenied:
    "Main battery verify nahi kar sakta — battery status API available nahi hai.",
  weatherNoLocation:
    "Main weather verify nahi kar sakta — mere paas location data nahi hai. Location permission de do, main current conditions check kar lunga.",
  weatherFailed:
    "Main weather verify nahi kar paya — weather source abhi available nahi hai.",
  toolUnavailable:
    "Main ye verify nahi kar paya — required source abhi available nahi hai. Thodi der baad try karo.",
  visionCancelled: "Maine wo request finish hone se pehle rok di.",
  visionFailed: "Main visual verify nahi kar paya — vision source fail ho gaya.",
  noCamera:
    "Main aapka camera feed nahi dekh sakta — koi camera ya screen source connected nahi hai. On karo aur dobara poochho.",
  noFrame:
    "Mere paas abhi frame nahi hai — camera on hai par video aa nahi raha. Ek second rukkar dobara try karo.",
  visionWarming:
    "Main abhi dekhna shuru kiya hoon — camera feed aane ke liye ek second do, phir dobara poochh lena.",
  greeting: "Hello! Aaj main aapki kya help kar sakta hoon?",
  casual: "Theek hai! Aur kuch chahiye to batao.",
  howAreYou: "Main theek hoon, shukriya! Aapko kya chahiye?",
};

const HINDI: ReplyTable = {
  emptyPrompt: "मुझे समझ नहीं आया कि आपने क्या कहा।",
  unverifiedFact:
    "मैं अभी इसकी पुष्टि नहीं कर सकता — लाइव जानकारी (समय, तारीख, मौसम) मैं केवल सत्यापित डेटा से ही बताता हूँ, और अभी स्रोत उपलब्ध नहीं है।",
  geolocationDenied:
    "मैं आपका स्थान सत्यापित नहीं कर सकता — स्थान की अनुमति नहीं दी गई है। अनुमति दें, फिर मैं बता दूँगा कि आप कहाँ हैं।",
  batteryDenied:
    "मैं बैटरी सत्यापित नहीं कर सकता — बैटरी स्टेटस एपीआई उपलब्ध नहीं है।",
  weatherNoLocation:
    "मैं मौसम सत्यापित नहीं कर सकता — मेरे पास स्थान डेटा नहीं है। स्थान की अनुमति दें और मैं मौजूदा स्थिति देख लूँगा।",
  weatherFailed:
    "मैं मौसम सत्यापित नहीं कर पाया — मौसम स्रोत अभी उपलब्ध नहीं है।",
  toolUnavailable:
    "मैं यह सत्यापित नहीं कर पाया — आवश्यक स्रोत अभी उपलब्ध नहीं है। थोड़ी देर बाद प्रयास करें।",
  visionCancelled: "मैंने वह अनुरोध पूरा होने से पहले रोक दिया।",
  visionFailed: "मैं दृश्य सत्यापित नहीं कर पाया — विज़न स्रोत विफल हो गया।",
  noCamera:
    "मैं आपका कैमरा फ़ीड नहीं देख सकता — कोई कैमरा या स्क्रीन स्रोत कनेक्ट नहीं है। इसे चालू करें और फिर से पूछें।",
  noFrame:
    "मेरे पास अभी कोई फ्रेम नहीं है — आपका कैमरा चालू है पर वीडियो आ नहीं रही। एक क्षण रुककर फिर प्रयास करें।",
  visionWarming:
    "मैंने अभी देखना शुरू किया है — कैमरा फ़ीड आने तक एक क्षण दीजिए, फिर दोबारा पूछिए।",
  greeting: "नमस्ते! आज मैं आपकी क्या मदद कर सकता हूँ?",
  casual: "ठीक है! और कुछ चाहिए तो बताइए।",
  howAreYou: "मैं ठीक हूँ, धन्यवाद! आपको क्या चाहिए?",
};

const TABLES: Record<SpokenLanguage, ReplyTable> = {
  english: ENGLISH,
  hinglish: HINGLISH,
  hindi: HINDI,
};

export function localizeReply(
  language: SpokenLanguage,
  key: CannedReplyKey
): string {
  return TABLES[language][key];
}

/** Detects a "how are you"-style warmer check-in (deterministic, no LLM). */
const HOW_ARE_YOU_PATTERNS: RegExp[] = [
  /^\s*(?:how\s+are\s+you|how'?s\s+it\s+going|how\s+are\s+you\s+doing|how\s+have\s+you\s+been)\b/i,
  /^\s*(?:kya\s+haal\s+(?:hai|hain)|kaise\s+ho|kaisi\s+ho|kaise\s+hain|aap\s+kaise\s+hain|kya\s+chal\s+raha\s+hai)\b/i,
  /^\s*(?:क्या\s+हाल\s+है|कैसे\s+हो|आप\s+कैसे\s+हैं|क्या\s+हालचाल|कैसा\s+चल\s+रहा\s+है)/u,
];

/**
 * Localized canned reply for greetings and casual conversation — the
 * conversational fast path never reaches the LLM (< 100 ms). Callers pass
 * `isGreeting` (from the planner's deterministic greeting detector).
 */
export function localizeConversationalReply(
  language: SpokenLanguage,
  prompt: string,
  isGreeting: boolean
): string {
  if (HOW_ARE_YOU_PATTERNS.some((pattern) => pattern.test(prompt.trim()))) {
    return localizeReply(language, "howAreYou");
  }
  if (isGreeting) return localizeReply(language, "greeting");
  return localizeReply(language, "casual");
}
