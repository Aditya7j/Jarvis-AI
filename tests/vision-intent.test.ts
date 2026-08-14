import { describe, it, expect } from "vitest";
import {
  classifyVisionAdjacent,
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

  it("routes common typos of vision trigger words to vision", () => {
    expect(classifyVisionIntent("what am i weaing")).toBe("vision");
    expect(classifyVisionIntent("what am i waering")).toBe("vision");
    expect(classifyVisionIntent("what am i holdin")).toBe("vision");
    expect(classifyVisionIntent("what am i holdign")).toBe("vision");
    expect(classifyVisionIntent("what am i wearingg")).toBe("vision");
    expect(classifyVisionIntent("is my shirt colur visible")).toBe("vision");
    expect(classifyVisionIntent("what is on my moniter")).toBe("vision");
  });

  it("keeps non-vision phrases with near-miss words as text", () => {
    // Near-miss vocabulary must never hijack unrelated requests.
    expect(classifyVisionIntent("I have a hearing problem")).toBe("text");
    expect(classifyVisionIntent("shift the meeting to 5pm")).toBe("text");
    expect(classifyVisionIntent("which singh always give the full name")).toBe("text");
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

describe("classifyVisionAdjacent (honesty backstop vocabulary)", () => {
  it("flags camera-adjacent phrases that bypass the strict classifier", () => {
    expect(classifyVisionAdjacent("is my camera working?")).toBe(true);
    expect(classifyVisionAdjacent("what am i weaing")).toBe(true);
    expect(classifyVisionAdjacent("please look at the screen")).toBe(true);
  });

  it("does not flag plain conversation", () => {
    expect(classifyVisionAdjacent("tell me a joke")).toBe(false);
    expect(classifyVisionAdjacent("what is 2 + 2")).toBe(false);
    expect(classifyVisionAdjacent("which singh always give the full name")).toBe(false);
    expect(classifyVisionAdjacent("")).toBe(false);
  });
});
