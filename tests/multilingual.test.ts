import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  detectSpeechLanguage,
  describeLanguage,
  hasDevanagari,
} from "@/lib/lang/detect";
import { localizeReply } from "@/lib/lang/replies";
import { languageInstruction } from "@/lib/ai/prompts";
import {
  classifyVisionDepth,
  classifyVisionIntent,
} from "@/lib/ai/vision-intent";
import {
  classifyPlanIntent,
  detectBattery,
  detectCalendar,
  detectDate,
  detectGeolocation,
  detectMemoryRecall,
  detectMemoryStore,
  detectOcr,
  detectProfile,
  detectTaskCreate,
  detectTime,
  detectWeather,
  detectWebSearch,
} from "@/services/planner";
import type { AIMessageInput } from "@/lib/ai/types";
import {
  runPipeline,
  runPipelineText,
  type PipelineEvent,
  type PipelineModel,
} from "@/services/chat";

function fakeModel(tokens: string[]): PipelineModel {
  return {
    streamText: async function* () {
      for (const token of tokens) yield token;
    },
  };
}

function recordingModel(store: AIMessageInput[]): PipelineModel {
  return {
    streamText: async function* (opts) {
      store.push(...opts.messages);
      yield "ok";
    },
  };
}

async function collect(
  prompt: string,
  messages: { role: "user"; content: string }[],
  model: PipelineModel,
  options: Parameters<typeof runPipeline>[3] = {}
): Promise<PipelineEvent[]> {
  const events: PipelineEvent[] = [];
  for await (const event of runPipeline(prompt, messages, model, options)) {
    events.push(event);
  }
  return events;
}

function textOf(events: PipelineEvent[]): string {
  return events
    .filter((e) => e.kind === "token")
    .map((e) => (e as { text: string }).text)
    .join("");
}

function intentOf(events: PipelineEvent[]): string | undefined {
  const plan = events.find((e) => e.kind === "plan") as
    | { intent?: string }
    | undefined;
  return plan?.intent;
}

describe("language detection (heuristic, no LLM)", () => {
  it("classifies Devanagari text as Hindi", () => {
    for (const prompt of [
      "नमस्ते जार्विस",
      "आज का मौसम क्या है",
      "अभी कितने बजे हैं",
      "2+2 क्या है",
    ]) {
      const detection = detectLanguage(prompt);
      expect(detection.language).toBe("hindi");
      expect(detection.script).toBe("devanagari");
    }
  });

  it("classifies Hindi-spoken-in-Latin text as Hinglish", () => {
    for (const prompt of [
      "kya haal hai",
      "main kahan hoon",
      "kya time hua hai",
      "aaj ki tarikh kya hai",
      "mera naam kya hai",
      "kal kya karna hai",
    ]) {
      expect(detectLanguage(prompt).language).toBe("hinglish");
    }
  });

  it("classifies ordinary English as English", () => {
    for (const prompt of [
      "hello jarvis",
      "what time is it",
      "tell me a joke",
      "what is the weather",
    ]) {
      expect(detectLanguage(prompt).language).toBe("english");
    }
  });

  it("a single strong Hinglish token is enough", () => {
    expect(detectLanguage("kya").language).toBe("hinglish");
    expect(detectLanguage("aaj").language).toBe("hinglish");
  });

  it("hasDevanagari and describeLanguage are consistent", () => {
    expect(hasDevanagari("मौसम कैसा है")).toBe(true);
    expect(hasDevanagari("kya haal hai")).toBe(false);
    expect(describeLanguage("hindi")).toContain("Devanagari");
    expect(describeLanguage("hinglish")).toContain("Roman");
    expect(describeLanguage("english")).toBe("English");
  });

  it("maps to a TTS speech language", () => {
    expect(detectSpeechLanguage("नमस्ते")).toBe("hi");
    expect(detectSpeechLanguage("kya haal hai")).toBe("hi");
    expect(detectSpeechLanguage("hello jarvis")).toBe("en");
  });

  it("is fast enough to run per request", () => {
    const samples = [
      "नमस्ते जार्विस",
      "kya haal hai",
      "what time is it",
      "aaj ka mausam kya hai",
      "आज का तापमान",
      "mera naam kya hai",
    ];
    const start = Date.now();
    for (let i = 0; i < 2000; i++) {
      detectLanguage(samples[i % samples.length]);
    }
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("languageInstruction prompt block", () => {
  it("builds a Hindi instruction for Devanagari responses", () => {
    const block = languageInstruction("hindi");
    expect(block).toContain("Hindi (write in Devanagari script)");
    expect(block).toContain("the same language");
  });

  it("builds a Hinglish instruction", () => {
    expect(languageInstruction("hinglish")).toContain(
      "Hinglish (casual Hindi written in Roman/English letters)"
    );
  });

  it("keeps tool facts and numbers intact", () => {
    const block = languageInstruction("hindi");
    expect(block).toContain("numbers, units, names or times");
    expect(block).toContain("canonical English");
  });
});

describe("planner routes Hindi/Hinglish to the same tools as English", () => {
  it.each([
    ["अभी कितने बजे हैं", "time"],
    ["समय बताओ", "time"],
    ["kya time hua hai", "time"],
    ["आज कौन सी तारीख है", "date"],
    ["aaj ki tarikh kya hai", "date"],
    ["आज का मौसम क्या है", "weather"],
    ["नोएडा का तापमान", "weather"],
    ["aaj ka mausam kya hai", "weather"],
    ["मैं कहाँ हूँ", "location"],
    ["main kahan hoon", "location"],
    ["बैटरी कितनी है", "system"],
    ["आज मेरा शेड्यूल क्या है", "calendar"],
    ["कल क्या करना है", "calendar"],
    ["kal kya karna hai", "calendar"],
    ["मेरा नाम क्या है", "profile"],
    ["मैं कौन हूँ", "profile"],
    ["mera naam kya hai", "profile"],
    ["याद रखना मैं कॉफी पसंद करता हूँ", "memory"],
    ["मेरी पसंद क्या है", "memory"],
    ["yaad rakhna mujhe coffee pasand hai", "memory"],
    ["स्क्रीन पर क्या लिखा है", "vision"],
    ["क्या तुम मुझे देख सकते हो", "vision"],
    ["kya tum mujhe dekh sakte ho", "vision"],
    ["2 गुना 3", "math"],
    ["2+2 क्या है", "math"],
    ["kitna hoga 5 plus 3", "math"],
    ["खबर सुनाओ", "search"],
    ["क्या हाल है", "reasoning"],
    ["kya haal hai", "reasoning"],
  ])("routes %s -> %s", (prompt, expected) => {
    expect(classifyPlanIntent(prompt)).toBe(expected);
  });

  it("detector helpers agree with the classifier", () => {
    expect(detectTime("अभी कितने बजे हैं")).toBe(true);
    expect(detectTime("kya time hua hai")).toBe(true);
    expect(detectDate("आज कौन सी तारीख है")).toBe(true);
    expect(detectDate("aaj ki tarikh kya hai")).toBe(true);
    expect(detectWeather("नोएडा का तापमान")).toBe(true);
    expect(detectWeather("aaj ka mausam kya hai")).toBe(true);
    expect(detectGeolocation("मैं कहाँ हूँ")).toBe(true);
    expect(detectBattery("बैटरी कितनी है")).toBe(true);
    expect(detectCalendar("कल क्या करना है")).toBe(true);
    expect(detectProfile("मैं कौन हूँ")).toBe(true);
    expect(detectMemoryStore("याद रखना मैं कॉफी पसंद करता हूँ")).toBe(true);
    expect(detectMemoryRecall("मेरी पसंद क्या है")).toBe(true);
    expect(detectTaskCreate("रिमाइंडर बनाओ कल सुबह")).toBe(true);
    expect(detectTaskCreate("reminder banao kal subah")).toBe(true);
    expect(detectOcr("स्क्रीन पर क्या लिखा है")).toBe(true);
    expect(detectWebSearch("सर्च करो बिल्लियों की तस्वीरें")).toBe(true);
  });

  it("does not over-trigger on non-Hindi lookalikes", () => {
    expect(classifyPlanIntent("मौसमी बातचीत करते हैं")).toBe("reasoning");
    expect(detectWeather("मौसमी बातचीत करते हैं")).toBe(false);
    expect(detectOcr("समय बताओ")).toBe(false);
  });
});

describe("vision intent: Hindi/Hinglish routing", () => {
  it.each([
    "क्या तुम मुझे देख सकते हो",
    "मैं क्या पहन रखा हूँ",
    "मेरे हाथ में क्या है",
    "स्क्रीन पर क्या दिख रहा है",
    "क्या दिख रहा है",
    "मेरे सामने क्या है",
    "मुझे देखो",
    "kya tum mujhe dekh sakte ho",
    "main kya pehna hoon",
    "screen par kya likha hai",
    "padhkar batao",
  ])("treats %s as a vision request", (prompt) => {
    expect(classifyVisionIntent(prompt)).toBe("vision");
  });

  it("keeps non-visual questions out of the camera", () => {
    expect(classifyVisionIntent("समय बताओ")).toBe("text");
    expect(classifyVisionIntent("आज का मौसम क्या है")).toBe("text");
    expect(classifyVisionIntent("what is 2+2?")).toBe("text");
  });

  it("classifies Hindi depth for the cache vs Gemma decision", () => {
    expect(classifyVisionDepth("मैं क्या पहन रखा हूँ")).toBe("simple");
    expect(classifyVisionDepth("क्या तुम मुझे देख सकते हो")).toBe("simple");
    expect(classifyVisionDepth("क्या हो रहा है विस्तार से")).toBe("complex");
  });
});

describe("chat pipeline: localized direct answers (no LLM)", () => {
  it("answers Hindi date questions in Devanagari", async () => {
    const events = await collect(
      "आज कौन सी तारीख है",
      [{ role: "user", content: "आज कौन सी तारीख है" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toMatch(/^आज \d{1,2} [\u0900-\u097F]+ \d{4} है।$/);
    expect(intentOf(events)).toBe("date");
    expect(textOf(events)).not.toContain("should never be called");
  });

  it("answers Hindi time questions in Devanagari", async () => {
    const events = await collect(
      "अभी कितने बजे हैं",
      [{ role: "user", content: "अभी कितने बजे हैं" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toMatch(/^समय .+ है।$/);
    expect(intentOf(events)).toBe("time");
  });

  it("answers Hinglish date questions in Roman Hindi", async () => {
    const events = await collect(
      "aaj ki tarikh kya hai",
      [{ role: "user", content: "aaj ki tarikh kya hai" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toMatch(/^Aaj \d{1,2} [A-Za-z]+ \d{4} hai\.$/);
    expect(intentOf(events)).toBe("date");
  });

  it("answers Hinglish time questions in Roman Hindi", async () => {
    const events = await collect(
      "kya time hua hai",
      [{ role: "user", content: "kya time hua hai" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toMatch(/^Time \d{1,2}:\d{2} (am|pm) hai\.$/);
    expect(intentOf(events)).toBe("time");
  });

  it("keeps English direct answers in English", async () => {
    const events = await collect(
      "what is today's date",
      [{ role: "user", content: "what is today's date" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toMatch(/^Today is .+\.$/);
  });
});

describe("chat pipeline: language block reaches the LLM", () => {
  it("injects the Hindi instruction for Devanagari prompts", async () => {
    const store: AIMessageInput[] = [];
    const events = await collect(
      "नमस्ते जार्विस",
      [{ role: "user", content: "नमस्ते जार्विस" }],
      recordingModel(store)
    );
    expect(store[0].role).toBe("system");
    expect(store[0].content).toContain("Hindi (write in Devanagari script)");
    expect(intentOf(events)).toBe("reasoning");
  });

  it("injects the Hinglish instruction for Roman-Hindi prompts", async () => {
    const store: AIMessageInput[] = [];
    await collect(
      "kya haal hai",
      [{ role: "user", content: "kya haal hai" }],
      recordingModel(store)
    );
    expect(store[0].role).toBe("system");
    expect(store[0].content).toContain(
      "Hinglish (casual Hindi written in Roman/English letters)"
    );
  });

  it("does not inject a language block for English", async () => {
    const store: AIMessageInput[] = [];
    await collect(
      "hello jarvis",
      [{ role: "user", content: "hello jarvis" }],
      recordingModel(store)
    );
    expect(store.every((m) => !m.content.includes("The user is speaking"))).toBe(
      true
    );
  });
});

describe("chat pipeline: canned fallbacks are localized", () => {
  it("localizes geolocation denial for Hindi", async () => {
    const events = await collect(
      "मैं कहाँ हूँ",
      [{ role: "user", content: "मैं कहाँ हूँ" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toBe(localizeReply("hindi", "geolocationDenied"));
  });

  it("localizes geolocation denial for Hinglish", async () => {
    const events = await collect(
      "main kahan hoon",
      [{ role: "user", content: "main kahan hoon" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toBe(localizeReply("hinglish", "geolocationDenied"));
  });

  it("localizes weather no-location for Hindi", async () => {
    const events = await collect(
      "आज का मौसम क्या है",
      [{ role: "user", content: "आज का मौसम क्या है" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toBe(localizeReply("hindi", "weatherNoLocation"));
  });

  it("localizes weather no-location for Hinglish", async () => {
    const events = await collect(
      "aaj ka mausam kya hai",
      [{ role: "user", content: "aaj ka mausam kya hai" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toBe(localizeReply("hinglish", "weatherNoLocation"));
  });

  it("localizes battery denial for Hindi", async () => {
    const events = await collect(
      "बैटरी कितनी है",
      [{ role: "user", content: "बैटरी कितनी है" }],
      fakeModel(["should never be called"])
    );
    expect(textOf(events)).toBe(localizeReply("hindi", "batteryDenied"));
  });

  it("localizes the no-camera vision refusal for Hindi", async () => {
    const events = await collect(
      "क्या तुम मुझे देख सकते हो",
      [{ role: "user", content: "क्या तुम मुझे देख सकते हो" }],
      fakeModel(["should never be called"]),
      { vision: { state: "off", frames: [] } }
    );
    expect(textOf(events)).toBe(localizeReply("hindi", "noCamera"));
    expect(events.some((e) => e.kind === "vision")).toBe(true);
  });

  it("localizes the no-camera vision refusal for Hinglish", async () => {
    const events = await collect(
      "kya tum mujhe dekh sakte ho",
      [{ role: "user", content: "kya tum mujhe dekh sakte ho" }],
      fakeModel(["should never be called"]),
      { vision: { state: "off", frames: [] } }
    );
    expect(textOf(events)).toBe(localizeReply("hinglish", "noCamera"));
  });

  it("exposes the detected language from runPipelineText", async () => {
    const hindi = await runPipelineText(
      "नमस्ते जार्विस",
      [{ role: "user", content: "नमस्ते जार्विस" }],
      fakeModel(["namaste"])
    );
    expect(hindi.language).toBe("hindi");
    const hinglish = await runPipelineText(
      "kya time hua hai",
      [{ role: "user", content: "kya time hua hai" }],
      fakeModel(["ok"])
    );
    expect(hinglish.language).toBe("hinglish");
    const english = await runPipelineText(
      "what time is it",
      [{ role: "user", content: "what time is it" }],
      fakeModel(["ok"])
    );
    expect(english.language).toBe("english");
  });
});
