export const DEFAULT_SYSTEM_PROMPT = `You are JARVIS, a highly capable AI assistant. You are helpful, concise, and proactive.

Response format:
- Use Markdown: short headings, bullet points, numbered steps, and code blocks (with a language tag) for anything technical.
- Put the most important point first, then the details.
- For short answers (under ~40 words), reply in a plain sentence or two — do not add headings or structure for its own sake.
- For step-by-step instructions use numbered lists; for lists or comparisons use bullets.
- If the answer is longer than a paragraph, finish with a one-line summary.

Conversation style:
- Read the full conversation history before answering. Treat follow-ups as continuations of earlier answers and build on them.
- NEVER repeat information you already gave in an earlier turn. If the user asks about something you already answered, acknowledge it briefly and only add anything new.
- If the request is ambiguous, ask one short clarifying question instead of guessing.
- Keep the tone natural and conversational, as if spoken aloud. Avoid filler like "Certainly!", "Great question!", or "As an AI, ...".
- If the user just says "thanks" or "okay", reply in a single short line.

Length:
- Prefer concise answers. Aim for under 150 words unless the user explicitly asks for detail, a full explanation, or code.

Fact policy (STRICT):
- You only know system facts — current time, current date, timezone, location, battery level, weather, network status or system status — when they are given to you in a "Verified data" block in this conversation. Never guess, estimate, recall, infer or compute them yourself.
- When a verified fact is provided, present it naturally and concisely in your own words. Never claim you checked, measured, fetched, looked it up, or are "recalibrating" anything — just state the fact.
- If you are asked for a system fact that was not provided, say you don't have access to that information and, where relevant, mention how it could be enabled.`;

export const VISION_CONTEXT_PROMPT = `You are the vision system for JARVIS, an AI assistant. Describe the current live view concisely (under 120 words). Note people, their appearance and mood, objects, text, and any screen content or app the user has open. Focus on what is most useful for answering the user's questions about what they see.`;

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionPersonDetails {
  shirt_color: string | null;
  shirt_type: string | null;
  pants_visible: boolean;
  pants_description: string | null;
  confidence: number;
}

export interface VisionObjectDetail {
  name: string;
  color: string | null;
  confidence: number;
  bbox: BoundingBox | null;
}

export interface VisionStructuredAnalysis {
  visible_objects: VisionObjectDetail[];
  person: VisionPersonDetails;
  uncertain: boolean;
  reasoning: string;
}

import { CONFIDENCE_HIGH } from "../vision/confidence";

/** Minimum object/person confidence (0-100) before the LLM may reference it. */
export const MIN_CONFIDENCE = CONFIDENCE_HIGH;
export const VISION_UNCERTAIN_REPLY = "Not visible";

export const VISION_STRUCTURED_PROMPT = `You are the vision system for JARVIS. Analyze the camera frame and respond with ONLY a single valid JSON object — no markdown, no code fences, no extra text.

Output exactly this shape:
{
  "visible_objects": [
    {
      "name": "object name",
      "color": "primary color or null",
      "confidence": 0-100,
      "bbox": { "x": 0, "y": 0, "width": 0, "height": 0 }
    }
  ],
  "person": {
    "shirt_color": "color or null",
    "shirt_type": "e.g. t-shirt, hoodie, jacket, button-up, polo, or null",
    "pants_visible": true or false,
    "pants_description": "e.g. dark blue jeans, black trousers, or null",
    "confidence": 0-100
  },
  "uncertain": true or false,
  "reasoning": "one short sentence stating exactly what was observed"
}

"bbox" is the bounding box in pixel coordinates relative to the frame: x (left edge), y (top edge), width, height. All values are numbers.

Anti-hallucination rules (STRICT):
- Base everything ONLY on what is clearly visible in the frame. NEVER guess, infer, or imagine details you cannot clearly see.
- List only objects that are clearly present, up to 8. Omit anything you cannot identify with reasonable confidence.
- If an object is entirely OUTSIDE the frame, out of view, cut off, or blocked so its identity cannot be determined, do NOT list it. State that in "reasoning" and set "uncertain" to true.
- If an object's color cannot be clearly determined, set "color" to null. Never invent a color.
- If no person is clearly visible: person.shirt_color = null, person.shirt_type = null, person.pants_visible = false, person.pants_description = null, person.confidence = 0, uncertain = true.
- If a garment is only partially in frame, cut off, blocked, blurred, or out of view, set that field to null (or pants_visible = false). Never guess a color or type for a partially visible garment.
- confidence reflects how clearly the object or person is visible: 100 = perfectly clear. Keep it below 85 whenever any detail is uncertain or the subject is only partially framed.
- If nothing meaningful is visible, return "visible_objects": [] and "uncertain": true.`;

function clampConfidence(value: unknown): number {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
}

function parseObjectDetails(raw: unknown): VisionObjectDetail[] {
  if (!Array.isArray(raw)) return [];
  const objects: VisionObjectDetail[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) {
        objects.push({ name: item.trim(), color: null, confidence: 0, bbox: null });
      }
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
    if (!name) continue;
    let bbox: BoundingBox | null = null;
    const rawBbox = (entry.bbox ?? {}) as Record<string, unknown>;
    const x = Number(rawBbox.x);
    const y = Number(rawBbox.y);
    const width = Number(rawBbox.width);
    const height = Number(rawBbox.height);
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height)
    ) {
      bbox = { x, y, width, height };
    }
    objects.push({
      name,
      color:
        typeof entry.color === "string" && entry.color.trim()
          ? entry.color.trim()
          : null,
      confidence: clampConfidence(entry.confidence),
      bbox,
    });
  }
  return objects;
}

export function parseVisionAnalysis(raw: string): VisionStructuredAnalysis | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const personRaw = (obj.person ?? {}) as Record<string, unknown>;
  const person: VisionPersonDetails = {
    shirt_color:
      typeof personRaw.shirt_color === "string" && personRaw.shirt_color.trim()
        ? personRaw.shirt_color.trim()
        : null,
    shirt_type:
      typeof personRaw.shirt_type === "string" && personRaw.shirt_type.trim()
        ? personRaw.shirt_type.trim()
        : null,
    pants_visible: personRaw.pants_visible === true,
    pants_description:
      typeof personRaw.pants_description === "string" && personRaw.pants_description.trim()
        ? personRaw.pants_description.trim()
        : null,
    confidence: clampConfidence(personRaw.confidence),
  };
  return {
    visible_objects: parseObjectDetails(obj.visible_objects),
    person,
    uncertain: obj.uncertain === true,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

export function describeVisionAnalysis(
  analysis: VisionStructuredAnalysis | null
): string | null {
  if (!analysis) return null;
  const person = analysis.person;
  const objects = analysis.visible_objects.length
    ? analysis.visible_objects
        .map(
          (object) =>
            `${object.name}${object.color ? ` (${object.color})` : ""} [${object.confidence}%]`
        )
        .join(", ")
    : "none clearly visible";
  const lines: string[] = [
    `Visible objects: ${objects}`,
    analysis.reasoning ? `Observation: ${analysis.reasoning}` : null,
  ].filter((line): line is string => line !== null);

  if (person.confidence >= MIN_CONFIDENCE) {
    const details = [
      person.shirt_color ? `shirt color ${person.shirt_color}` : null,
      person.shirt_type ? `shirt type ${person.shirt_type}` : null,
    ]
      .filter((detail): detail is string => detail !== null)
      .join(", ");
    const pants = person.pants_visible
      ? `pants: ${person.pants_description ?? "visible"}`
      : "pants: not visible";
    lines.push(
      `Person: ${details || "person present but clothing details not clearly visible"} (${pants}). Confidence ${person.confidence}/100.`
    );
    return lines.join("\n");
  }

  if (person.confidence > 0) {
    lines.push(
      `Person detected but appearance cannot be determined accurately (confidence ${person.confidence}/100). Do NOT guess shirt or pants details.`
    );
  } else {
    lines.push("No person clearly visible.");
  }
  lines.push(
    `If the user asks about the person's clothing or appearance, respond exactly: "${VISION_UNCERTAIN_REPLY}"`
  );
  return lines.join("\n");
}

export function buildVisionSystemContext(
  analysis: VisionStructuredAnalysis | null
): string {
  const base =
    "A live camera frame is active. The visual information below is the ONLY data you have about the current camera view.";

  if (!analysis) {
    return `${base}
No reliable visual data could be extracted from the current camera frame.
Anti-hallucination rules (STRICT):
- Never invent objects, people, clothing, colors, background, or screen content.
- If the user asks about anything currently visible in the camera view, answer with exactly: "${VISION_UNCERTAIN_REPLY}"
- For questions not about the camera view, answer normally.`;
  }

  return `${base}
Vision data (structured JSON analyzed from the current camera frame):
${JSON.stringify(analysis, null, 2)}
Anti-hallucination rules (STRICT):
- This JSON is your ONLY source of truth about the current camera view. Never add, guess, or invent clothing, colors, background, objects, text, or people that are not present in it.
- Only reference an object or the person when it is present in the JSON AND its confidence is >= ${MIN_CONFIDENCE}.
- If an object the user asks about is not present in the JSON, or its confidence is below ${MIN_CONFIDENCE}, or the data is uncertain, answer with exactly: "${VISION_UNCERTAIN_REPLY}"
- For questions not about the camera view, answer normally.`;
}

/**
 * System context used when the camera/screen is turned OFF. The main LLM must
 * never guess visual details; it can only point at the missing camera feed.
 */
export function buildNoCameraSystemContext(): string {
  return `No camera or screen source is currently connected to JARVIS, so JARVIS has no visual information at all.
Anti-hallucination rules (STRICT):
- You cannot see the user, their clothing, their surroundings, objects, or their screen. Never pretend otherwise.
- If the user asks about anything currently visible (clothing, colors, objects, screen content, surroundings), answer with exactly: "${VISION_UNCERTAIN_REPLY}"
- For questions not about the camera view, answer normally.`;
}

/**
 * System context used when the camera is ON but no usable frame was captured
 * for the current message (e.g. the stream just started or capture failed).
 */
export function buildNoFrameSystemContext(): string {
  return `JARVIS's camera is currently ON, but no video frame could be captured for this message.
Anti-hallucination rules (STRICT):
- You have no visual information for the current moment. Never invent objects, people, clothing, colors, background, or screen content.
- If the user asks about anything currently visible in the camera view, answer with exactly: "${VISION_UNCERTAIN_REPLY}"
- For questions not about the camera view, answer normally.`;
}

/**
 * System context used when a pipeline step failed (image capture, encoding,
 * the request to Gemma 3, or JSON parsing). The exact failure is reported to
 * the user instead of the generic "cannot determine" refusal, and the main LLM
 * is still forbidden from guessing visual content.
 */
export function buildVisionErrorContext(detail: string): string {
  return `The camera is active but the vision analysis pipeline failed, so JARVIS has no visual data for this message.
Pipeline error: ${detail}
Instructions (STRICT):
- Briefly and honestly tell the user the vision analysis failed, mentioning the exact error above.
- Do NOT attempt to guess, describe, or analyze any visual content.
- Do NOT respond with the phrase: "${VISION_UNCERTAIN_REPLY}" — respond about the error instead.
- For questions not about the camera view, answer normally.`;
}

export interface VisionAnalysisSummary {
  state: "live" | "no-frame" | "off" | "error";
  source?: "webcam" | "screen";
  capturedAt?: number;
  confidence: number | null;
  objectCount: number;
  personConfidence: number;
  error?: string | null;
}

/**
 * Flatten a parsed vision analysis into a small summary used for the debug UI
 * and the SSE `vision` event (timestamp + confidence).
 */
export function summarizeVisionAnalysis(
  analysis: VisionStructuredAnalysis | null,
  meta: {
    source?: "webcam" | "screen";
    capturedAt?: number;
    state: "live" | "no-frame" | "off" | "error";
    error?: string | null;
  }
): VisionAnalysisSummary {
  let confidence: number | null = null;
  let objectCount = 0;
  if (analysis) {
    objectCount = analysis.visible_objects.length;
    const objectConfidence = analysis.visible_objects.reduce(
      (max, object) => Math.max(max, object.confidence),
      0
    );
    confidence = Math.max(objectConfidence, analysis.person.confidence);
    if (confidence === 0) confidence = null;
  }
  return {
    state: meta.state,
    source: meta.source,
    capturedAt: meta.capturedAt,
    confidence,
    objectCount,
    personConfidence: analysis?.person.confidence ?? 0,
    error: meta.error ?? null,
  };
}

