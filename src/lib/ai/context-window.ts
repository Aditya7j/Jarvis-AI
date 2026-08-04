import type { AIMessageInput } from "./types";

export const CONTEXT_WINDOW_MAX_MESSAGES = 16;
export const CONTEXT_WINDOW_MAX_MSG_CHARS = 4000;
export const CONTEXT_WINDOW_SUMMARY_CHARS = 2000;

function truncateContent(content: string): string {
  if (content.length <= CONTEXT_WINDOW_MAX_MSG_CHARS) return content;
  return `${content.slice(0, CONTEXT_WINDOW_MAX_MSG_CHARS)}\n…[truncated]`;
}

function compressDropped(messages: AIMessageInput[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = message.content;
    if (!text.trim()) continue;
    const label =
      message.role === "user" ? "User" : message.role === "tool" ? "Tool" : "Assistant";
    lines.push(`${label}: ${text}`);
  }
  const joined = lines.join("\n");
  if (!joined) return "";
  return `[Earlier conversation]\n${joined.slice(0, CONTEXT_WINDOW_SUMMARY_CHARS)}`;
}

function truncateMessage(message: AIMessageInput): AIMessageInput {
  if (message.content.length <= CONTEXT_WINDOW_MAX_MSG_CHARS) return message;
  return { ...message, content: truncateContent(message.content) };
}

/**
 * Bounds the conversation context sent to the model. System prompts (including
 * the default prompt, memory and vision context) are always preserved; the
 * oldest non-system turns beyond CONTEXT_WINDOW_MAX_MESSAGES are compressed into
 * a compact "earlier conversation" block, and every individual message is
 * capped to keep the token count bounded on long sessions.
 */
export function trimContextWindow(messages: AIMessageInput[]): AIMessageInput[] {
  const system = messages.filter((message) => message.role === "system");
  const rest = messages.filter((message) => message.role !== "system");

  if (rest.length === 0) return messages.map(truncateMessage);

  const summary = rest.length > CONTEXT_WINDOW_MAX_MESSAGES
    ? compressDropped(rest.slice(0, rest.length - CONTEXT_WINDOW_MAX_MESSAGES))
    : null;
  const tail = rest.slice(-CONTEXT_WINDOW_MAX_MESSAGES);

  const trimmed: AIMessageInput[] = [];
  if (summary) {
    trimmed.push({ role: "system", content: summary });
  }
  trimmed.push(...tail.map(truncateMessage));

  return [...system.map(truncateMessage), ...trimmed];
}
