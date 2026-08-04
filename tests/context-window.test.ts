import { describe, it, expect } from "vitest";
import {
  trimContextWindow,
  CONTEXT_WINDOW_MAX_MESSAGES,
} from "@/lib/ai/context-window";
import type { AIMessageInput } from "@/lib/ai/types";

function message(role: AIMessageInput["role"], content: string): AIMessageInput {
  return { role, content };
}

describe("trimContextWindow", () => {
  it("leaves short conversations untouched", () => {
    const messages = [
      message("system", "default"),
      message("user", "hello"),
      message("assistant", "hi there"),
    ];
    const result = trimContextWindow(messages);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("default");
  });

  it("preserves all system prompts while bounding the tail", () => {
    const messages: AIMessageInput[] = [
      message("system", "default"),
      message("system", "vision context block"),
    ];
    for (let i = 0; i < CONTEXT_WINDOW_MAX_MESSAGES + 4; i++) {
      messages.push(message(i % 2 === 0 ? "user" : "assistant", `msg ${i}`));
    }
    const result = trimContextWindow(messages);
    const systemCount = result.filter((m) => m.role === "system").length;
    const nonSystem = result.filter((m) => m.role !== "system");
    expect(systemCount).toBe(3);
    expect(nonSystem.length).toBeLessThanOrEqual(CONTEXT_WINDOW_MAX_MESSAGES);
    expect(result.some((m) => m.content.includes("[Earlier conversation]"))).toBe(
      true
    );
    expect(nonSystem[nonSystem.length - 1].content).toBe(
      `msg ${CONTEXT_WINDOW_MAX_MESSAGES + 3}`
    );
  });

  it("caps individual message length", () => {
    const long = "a".repeat(10_000);
    const result = trimContextWindow([message("user", long)]);
    expect(result[0].content.length).toBeLessThan(5000);
    expect(result[0].content).toContain("[truncated]");
  });

  it("returns empty input unchanged", () => {
    expect(trimContextWindow([])).toEqual([]);
  });

  it("keeps the newest turns when over the limit", () => {
    const messages: AIMessageInput[] = [];
    for (let i = 0; i < CONTEXT_WINDOW_MAX_MESSAGES + 2; i++) {
      messages.push(message("user", `q${i}`));
    }
    const result = trimContextWindow(messages);
    const tail = result.filter((m) => m.role !== "system");
    expect(tail[tail.length - 1].content).toBe(`q${CONTEXT_WINDOW_MAX_MESSAGES + 1}`);
    expect(tail[tail.length - 2].content).toBe(`q${CONTEXT_WINDOW_MAX_MESSAGES}`);
  });
});
