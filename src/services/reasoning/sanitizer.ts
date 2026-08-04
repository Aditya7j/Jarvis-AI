/**
 * Reasoning Engine — enforces JARVIS's answer contract.
 *
 * The reasoning model is the LAST component and its output is the ONLY thing
 * the user sees. Chain of thought is never exposed: any internal-thinking
 * blocks (`<think>…</think>`, `<reasoning>…</reasoning>`, `Thought:` lines) are
 * stripped in-flight so only the final answer ever reaches the user.
 */

const THINK_BLOCK =
  /<think[\s\S]*?<\/think>|<reasoning[\s\S]*?<\/reasoning>|<Thought[\s\S]*?<\/Thought>|<thinking[\s\S]*?<\/thinking>/gi;
const THINK_OPEN_TAG = /<(?:think|thinking|reasoning|Thought)[\s\S]*?>/gi;
const THINK_CLOSE_TAG = /<\/(?:think|thinking|reasoning|Thought)>/gi;
const THINK_LINE = /^\s*(?:Thought|Thinking|Reasoning|Internal\s+reasoning|Chain\s+of\s+thought)\s*[:\-].*$/gim;

/** Remove every chain-of-thought block from a complete text. */
export function stripChainOfThought(text: string): string {
  if (!text) return "";
  const clean = text
    .replace(THINK_BLOCK, "")
    .replace(THINK_OPEN_TAG, "")
    .replace(THINK_CLOSE_TAG, "")
    .replace(THINK_LINE, "");
  return clean.trim();
}

const BOUNDARY_MARGIN = 64;

// Non-global clones for the streaming filter: `String.match` only exposes
// `.index` on non-global regexes, and the filter relies on tag positions.
const OPEN_TAG = /<(?:think|thinking|reasoning|Thought)[\s\S]*?>/i;
const CLOSE_TAG = /<\/(?:think|thinking|reasoning|Thought)>/i;

/**
 * Streaming chain-of-thought filter. Feed raw tokens; it emits only clean
 * final-answer tokens. Handles think tags that span token boundaries by
 * keeping a small pending tail.
 */
export class CoTFilter {
  private pending = "";
  private inThink = false;
  private emittedCount = 0;

  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    let output = "";

    while (this.pending.length > 0) {
      if (this.inThink) {
        const close = this.pending.match(CLOSE_TAG);
        if (close) {
          this.pending = this.pending.slice((close.index ?? 0) + close[0].length);
          this.inThink = false;
          continue;
        }
        // No close tag yet — keep only the tail in case the close tag spans
        // the next chunk boundary; discard the rest (it is internal thought).
        this.pending = this.pending.slice(-BOUNDARY_MARGIN);
        break;
      }
      const open = this.pending.match(OPEN_TAG);
      if (open) {
        const openEnd = (open.index ?? 0) + open[0].length;
        output += this.pending.slice(0, open.index ?? 0);
        this.pending = this.pending.slice(openEnd);
        this.inThink = true;
        continue;
      }
      // No open tag: emit everything except a boundary margin so an opening
      // tag at the very end of this chunk is caught on the next push.
      if (this.pending.length > BOUNDARY_MARGIN) {
        output += this.pending.slice(0, this.pending.length - BOUNDARY_MARGIN);
        this.pending = this.pending.slice(-BOUNDARY_MARGIN);
      }
      break;
    }

    if (output.length > 0) this.emittedCount += output.length;
    return output;
  }

  /** Flush any remaining clean text (must be called when the stream ends). */
  flush(): string {
    const output = this.inThink ? "" : this.pending;
    this.pending = "";
    this.inThink = false;
    if (output.length > 0) this.emittedCount += output.length;
    return output;
  }

  emitted(): number {
    return this.emittedCount;
  }
}

/** Sanitize a full final answer before it is persisted or returned. */
export function sanitizeFinalAnswer(text: string): string {
  return stripChainOfThought(text);
}
