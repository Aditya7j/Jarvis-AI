import { describe, it, expect } from "vitest";
import {
  classifyVisionIntent,
  classifyVisionDepth,
} from "@/lib/ai/vision-intent";

describe("classifyVisionIntent", () => {
  it("treats empty prompts as text", () => {
    expect(classifyVisionIntent("")).toBe("text");
    expect(classifyVisionIntent("   ")).toBe("text");
  });

  it("detects strong vision phrases even with negation", () => {
    expect(classifyVisionIntent("can you see me?")).toBe("vision");
    expect(classifyVisionIntent("don't you see the cat?")).toBe("vision");
    expect(classifyVisionIntent("what do you see")).toBe("vision");
    expect(classifyVisionIntent("what am I holding")).toBe("vision");
  });

  it("treats slang 'u' as 'you' for see-phrases", () => {
    expect(classifyVisionIntent("can u see me")).toBe("vision");
    expect(classifyVisionIntent("can u see the cat")).toBe("vision");
  });

  it("respects negation for instruction-like phrases", () => {
    expect(classifyVisionIntent("don't look at the screen")).toBe("text");
    expect(classifyVisionIntent("do not read the screen")).toBe("text");
    expect(classifyVisionIntent("never describe the room")).toBe("text");
  });

  it("routes weak vision vocabulary to vision", () => {
    expect(classifyVisionIntent("what color is my shirt")).toBe("vision");
    expect(classifyVisionIntent("how many people are there")).toBe("vision");
    expect(classifyVisionIntent("what is in front of me")).toBe("vision");
  });

  it("keeps plain conversation as text", () => {
    expect(classifyVisionIntent("what is 2 + 2")).toBe("text");
    expect(classifyVisionIntent("tell me a joke")).toBe("text");
    expect(classifyVisionIntent("how's the weather")).toBe("text");
  });

  it("never invokes vision for the wake word / greetings", () => {
    expect(classifyVisionIntent("hey jarvis")).toBe("text");
    expect(classifyVisionIntent("jarvis")).toBe("text");
    expect(classifyVisionIntent("hey jarvis, what can you do?")).toBe("text");
    expect(classifyVisionIntent("good morning jarvis")).toBe("text");
    expect(classifyVisionIntent("jarvis please set a timer")).toBe("text");
  });
});

describe("classifyVisionDepth", () => {
  it("routes detailed analysis to complex", () => {
    expect(classifyVisionDepth("describe what you see in detail")).toBe(
      "complex"
    );
    expect(classifyVisionDepth("analyze the scene")).toBe("complex");
    expect(classifyVisionDepth("what is happening in the room")).toBe(
      "complex"
    );
  });

  it("routes simple factual questions to the cache", () => {
    expect(classifyVisionDepth("what am I holding")).toBe("simple");
    expect(classifyVisionDepth("what color is my shirt")).toBe("simple");
    expect(classifyVisionDepth("how many people are there")).toBe("simple");
  });

  it("routes 'can u see me' (slang) to the simple cache path", () => {
    expect(classifyVisionDepth("can u see me")).toBe("simple");
    expect(classifyVisionDepth("can you see me")).toBe("simple");
  });

  it("defaults unknown vision prompts to complex", () => {
    expect(classifyVisionDepth("")).toBe("complex");
    expect(classifyVisionDepth("what do you see")).toBe("simple");
  });
});
