import { confidenceBand } from "./confidence";
import type { VisionStateSnapshot } from "./vision-state";
import { getVisionStateStore } from "./vision-state";

/**
 * Fast vision router.
 *
 * Simple questions ("can you see me?", "what am I holding?", "how many people
 * are here?", "is there a bottle on my desk?") are answered directly from the
 * continuously-refreshed YOLO vision state — no Gemma call, sub-millisecond
 * routing, well under the 700ms simple-question budget.
 *
 * Only prompts that truly need reasoning, detail, or text reading fall through
 * to `needsGemma: true` and are routed to Gemma by the caller.
 */

export interface SimpleVisionAnswer {
  text: string;
  /** 0..100 overall confidence in the answer. */
  confidence: number;
  needsGemma: boolean;
  /** True when the answer came from the vision-state cache (no LLM involved). */
  fromCache: boolean;
  /**
   * When the Scene Cache cannot answer an attribute question (held object or
   * shirt colour not established by YOLO), the caller MAY run ONE bounded,
   * focused VLM call on the newest frame. Simple questions never block on the
   * VLM for anything else.
   */
  escalation?: "holding" | "wearing";
}

const FLAG_HIGH_CONFIDENCE = 0.7;

/**
 * Apply the shared confidence-band contract to a positive detection answer
 * (see ./confidence.ts):
 *   >= 80       -> answer directly
 *   70-79       -> answer with uncertainty
 *   < 70        -> never guess, ask the user to reposition
 */
function finalize(text: string, confidence: number): SimpleVisionAnswer {
  const band = confidenceBand(confidence);
  if (band === "low") {
    return {
      text: "I can't see that clearly enough to answer — could you move into view or reposition the camera?",
      confidence,
      needsGemma: false,
      fromCache: true,
    };
  }
  if (band === "uncertain") {
    return {
      text: `${text} — I'm not completely sure, it isn't fully clear.`,
      confidence,
      needsGemma: false,
      fromCache: true,
    };
  }
  return { text, confidence, needsGemma: false, fromCache: true };
}

/**
 * Aliases that map a user's phrasing onto a COCO label. Ordered by specificity;
 * the first alias group that matches the prompt wins.
 */
const OBJECT_ALIASES: [label: string, aliases: string[]][] = [
  ["cell phone", ["phone", "cellphone", "cell phone", "mobile", "smartphone", "iphone", "android phone"]],
  ["laptop", ["laptop", "macbook", "notebook", "computer", "chromebook"]],
  ["cup", ["mug", "coffee cup", "tea cup", "glass of water"]],
  ["bottle", ["water bottle", "bottle"]],
  ["book", ["book", "books", "textbook", "notebook paper"]],
  ["keyboard", ["keyboard"]],
  ["tv", ["monitor", "display", "screen", "television", "tv"]],
  ["clock", ["clock", "watch", "wristwatch", "time"]],
  ["remote", ["remote", "remote control", "clicker"]],
  ["mouse", ["mouse", "computer mouse"]],
  ["headphones", ["headphones", "headphone", "earphones", "earbuds"]],
  ["scissors", ["scissors", "scissor"]],
  ["bottle", ["keys", "key", "keyring"]],
  ["cup", ["glass"]],
];

const personCount = (state: VisionStateSnapshot): number => state.latestPeople.length;

function objectList(state: VisionStateSnapshot): { name: string; count: number; confidence: number }[] {
  const counts = new Map<string, { count: number; confidence: number }>();
  for (const object of Object.values(state.latestObjects)) {
    // Persons are tracked separately in `latestPeople` and already listed via
    // `formatObjectList`'s person prefix — never double-list them as objects.
    if (object.label === "person") continue;
    const entry = counts.get(object.label) ?? { count: 0, confidence: 0 };
    entry.count += 1;
    entry.confidence = Math.max(entry.confidence, object.confidence);
    counts.set(object.label, entry);
  }
  return [...counts.entries()]
    .map(([name, detail]) => ({ name, ...detail }))
    .sort((a, b) => b.confidence - a.confidence);
}

function findTargetLabel(prompt: string): string | null {
  for (const [label, aliases] of OBJECT_ALIASES) {
    if (aliases.some((alias) => new RegExp(`\\b${alias}\\b`, "i").test(prompt))) {
      return label;
    }
  }
  return null;
}

function formatObjectList(visible: { name: string; count: number }[], personCount: number): string {
  const parts: string[] = [];
  if (personCount > 0) {
    parts.push(personCount === 1 ? "1 person" : `${personCount} people`);
  }
  for (const item of visible) {
    parts.push(item.count > 1 ? `${item.count} ${item.name}s` : `a ${item.name}`);
  }
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function clothingSentence(state: VisionStateSnapshot): string | null {
  const person = state.latestPeople[0];
  if (!person) return null;
  const shirt = person.shirtColor;
  if (!shirt) return null;
  return `You're wearing a ${shirt.name} top.`;
}

/**
 * Answer a simple vision question purely from the vision-state cache.
 *
 * Returns `needsGemma: true` when the question needs reasoning/detail that the
 * detector cannot answer, or when the cache has no usable data at all.
 */
export function answerFromVisionCache(prompt: string): SimpleVisionAnswer {
  const state = getVisionStateStore().getState();
  const people = personCount(state);
  const visible = objectList(state);
  const p = prompt.toLowerCase();
  const target = findTargetLabel(p);
  const held = state.heldObject;

  // --- Flags (national flag anti-hallucination) ---
  if (/\bflag\b|\bcountry'?s\b|\bwhich\s+country\b|\bindian\s+flag\b/i.test(p)) {
    const flag = state.flag;
    if (flag && flag.confidence >= FLAG_HIGH_CONFIDENCE) {
      return finalize(
        "I can see a tricolor flag — it looks like the Indian flag.",
        Math.round(flag.confidence * 100)
      );
    }
    if (flag) {
      return {
        text: "I can see a tricolor flag, but I'm not fully certain which country's flag it is.",
        confidence: 40,
        needsGemma: false,
        fromCache: true,
      };
    }
    return {
      text: "I don't see any flag right now.",
      confidence: 70,
      needsGemma: false,
      fromCache: true,
    };
  }

  // --- "Can you see me?" / presence of any person ---
  if (/\b(do|can|could|did|are|will)\s+(you|u)\s+see\s+(me|us|anyone|anybody|someone)\b/.test(p)) {
    if (people > 0) {
      return finalize(
        "Yes, I can see you.",
        Math.round(Math.max(...state.latestPeople.map((person) => person.confidence)) * 100)
      );
    }
    return {
      text: "I don't see anyone right now.",
      confidence: 65,
      needsGemma: false,
      fromCache: true,
    };
  }

  // --- Count questions ---
  if (/\bhow\s+many\s+(people|person|persons|men|women|students|of\s+us|objects|things|items)\b/.test(p)) {
    // A "how many people" question must NEVER be answered with an object count.
    // The noun decides the counting domain: persons come from latestPeople,
    // objects from the (person-filtered) visible list.
    const noun = /\bpeople\b|\bpersons\b|\bmen\b|\bwomen\b|\bstudents\b|\bof\s+us\b/.test(p) ? "person" : "object";
    const count = noun === "person" ? people : visible.reduce((sum, item) => sum + item.count, 0);
    if (count === 0) {
      return {
        text: noun === "person" ? "I don't see any people right now." : "I don't see any objects right now.",
        confidence: 65,
        needsGemma: false,
        fromCache: true,
      };
    }
    const plural = noun === "person" ? (count === 1 ? "person" : "people") : count === 1 ? "object" : "objects";
    return finalize(`I can see ${count} ${plural}.`, 85);
  }

  // --- Alone / anyone else ---
  if (/\b(am\s+i\s+alone|anyone\s+(else|there|here)|anybody\s+(else|there|here))\b/.test(p)) {
    if (people === 0) {
      return { text: "Yes, you're alone — I don't see anyone else.", confidence: 75, needsGemma: false, fromCache: true };
    }
    return {
      text: people === 1
        ? "I can see you, but no one else."
        : `I can see ${people} people.`,
      confidence: 80,
      needsGemma: false,
      fromCache: true,
    };
  }

  // --- Holding ---
  if (/\bwhat\s+am\s+i\s+holding\b|\bholding\b|\bin\s+my\s+(hand|hands|lap)\b/.test(p)) {
    if (held && confidenceBand(held.confidence * 100) === "high") {
      const confidence = Math.round(held.confidence * 100);
      return finalize(
        `You're holding ${/^[aeiou]/i.test(held.label) ? "an" : "a"} ${held.label}.`,
        confidence
      );
    }
    // A weak or uncertain detector guess — e.g. earphones misdetected as
    // "remote" at 0.72 after 2-of-3 consensus — is NOT trustworthy enough to
    // report directly (it may be a false positive), and neither is having no
    // held-object at all. Escalate to ONE bounded, focused VLM call on the
    // newest frame so "what am I holding?" is actually answered instead of
    // instantly shipping a likely-false guess. The caller degrades to this
    // honest text if the VLM cannot answer within the interactive budget — it
    // never invents a held object from generic scene detections.
    return {
      text: "I can't identify the object clearly from the current frame.",
      confidence: 55,
      needsGemma: true,
      escalation: "holding",
      fromCache: false,
    };
  }

  // --- Wearing / clothing colour ---
  if (/\bwhat\s+am\s+i\s+wearing\b|\bwearing\b|\bshirt\b|\bhoodie\b|\bjacket\b|\bwhat\s+color\b|\bcolor\s+of\b|\bclothes\b|\boutfit\b|\bclothing\b/.test(p)) {
    const person = state.latestPeople[0];
    if (!person) {
      return {
        text: "I can't see you right now.",
        confidence: 50,
        needsGemma: false,
        fromCache: true,
      };
    }
    const sentence = clothingSentence(state);
    if (!sentence) {
      // A person is visible but YOLO hasn't established a shirt colour. YOLO
      // must never guess an attribute it didn't detect — one bounded, focused
      // VLM call on the newest frame is the only allowed escalation, and it
      // degrades to this honest text when the VLM cannot answer in time.
      return {
        text: "I can see you, but I can't make out what you're wearing clearly yet.",
        confidence: 40,
        needsGemma: true,
        escalation: "wearing",
        fromCache: false,
      };
    }
    return finalize(sentence, 85);
  }

  // --- Generic "what do you see / what's on my desk" list ---
  if (/\bwhat\s+do\s+you\s+see\b|\bwhat\s+can\s+you\s+see\b|\bwhat('s|s|\s+is)\s+on\s+(my\s+)?(desk|table|screen|monitor)\b|\bwhat\s+is\s+(in\s+)?front\s+of\s+(me|you)\b/.test(p)) {
    const listed = formatObjectList(
      visible.map((item) => ({ name: item.name, count: item.count })),
      people
    );
    if (!listed) {
      return { text: "I can't see anything clearly right now.", confidence: 40, needsGemma: false, fromCache: true };
    }
    return {
      text: `I can see ${listed}.`,
      confidence: 80,
      needsGemma: false,
      fromCache: true,
    };
  }

  // --- Specific object presence ("do you see my phone", "is there a bottle") ---
  if (target && /\b(see|there|found|any)\b/.test(p)) {
    const found = visible.find((item) => item.name === target);
    if (found) {
      const plural = found.count > 1 ? "s" : "";
      const confidence = Math.round(found.confidence * 100);
      return finalize(
        `Yes, I can see ${found.count > 1 ? `${found.count} ${found.name}s` : `a ${found.name}`}.`,
        confidence
      );
    }
    return {
      text: `No, I don't see any ${target} right now.`,
      confidence: 60,
      needsGemma: false,
      fromCache: true,
    };
  }

  // --- Anything else with a target object just named ("do you see my keys?") ---
  if (target) {
    const found = visible.find((item) => item.name === target);
    if (found) {
      return finalize(
        `Yes, I can see ${found.count > 1 ? `${found.count} ${found.name}s` : `a ${found.name}`}.`,
        Math.round(found.confidence * 100)
      );
    }
  }

  // Fall through: the cache always has something grounded to say for a simple
  // question — a scene list. Simple questions NEVER block on the VLM for gaps
  // the detector cannot answer; the Scene Cache is the single source of truth.
  const listed = formatObjectList(
    visible.map((item) => ({ name: item.name, count: item.count })),
    people
  );
  if (!listed) {
    return {
      text: "I can't see anything clearly right now.",
      confidence: 40,
      needsGemma: false,
      fromCache: true,
    };
  }
  return {
    text: `I can see ${listed}.`,
    confidence: 75,
    needsGemma: false,
    fromCache: true,
  };
}

/** Whether the vision-state cache currently has usable data (frame analyzed recently). */
export function isVisionCacheUsable(maxAgeMs = 3000): boolean {
  return getVisionStateStore().isFresh(maxAgeMs);
}
