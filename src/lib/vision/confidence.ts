/**
 * Single source of truth for vision confidence thresholds.
 *
 * Every consumer (fast YOLO cache router, Gemma-grounded chat, prompts) uses
 * these same bands so behaviour is consistent:
 *   >= HIGH        -> answer directly
 *   MID .. HIGH-1  -> answer with an uncertainty hedge
 *   < MID          -> never assert; ask the user to reposition (follow-up)
 */
export const CONFIDENCE_HIGH = 80;
export const CONFIDENCE_MID = 70;
export const CONFIDENCE_LOW = 50;

export type ConfidenceBand = "high" | "uncertain" | "low";

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= CONFIDENCE_HIGH) return "high";
  if (confidence >= CONFIDENCE_MID) return "uncertain";
  return "low";
}

/** Follow-up used whenever confidence is below CONFIDENCE_MID (70%). */
export const LOW_CONFIDENCE_FOLLOWUP =
  "I'm not confident enough about what's in view to answer that — could you reposition the camera or move closer, then ask again?";
