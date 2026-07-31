import { GoogleGenerativeAI, type Content, type GenerativeModel } from "@google/generative-ai";
import { AIError, mapGeminiError } from "../errors";
import { withTimeout } from "../http";
import { aiLogger } from "../logger";
import type {
  AIMessageInput,
  GenerateTextOptions,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "../types";
import type { AIProvider } from "./types";

interface GeminiProviderConfig {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  healthTimeoutMs: number;
}

export class GeminiProvider implements AIProvider {
  readonly name: ProviderName = "gemini";

  private readonly client: GoogleGenerativeAI | null;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly log = aiLogger.child("gemini");

  constructor(config: GeminiProviderConfig) {
    this.modelName = config.model;
    this.timeoutMs = config.timeoutMs;
    this.healthTimeoutMs = config.healthTimeoutMs;
    this.client = config.apiKey ? new GoogleGenerativeAI(config.apiKey) : null;
    if (this.client) {
      this.log.info("Gemini initialized (API key detected)", { model: this.modelName });
    } else {
      this.log.warn("Gemini not initialized (no API key)");
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getModel(): string | null {
    return this.client ? this.modelName : null;
  }

  supportsVision(): boolean {
    return this.isConfigured();
  }

  private instance(): GenerativeModel {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    return this.client.getGenerativeModel({ model: this.modelName });
  }

  private toGeminiMessages(messages: AIMessageInput[]): {
    system: string | null;
    history: Content[];
    prompt: string;
  } {
    let system: string | null = null;
    const history: Content[] = [];
    for (const message of messages) {
      if (message.role === "system") {
        system = message.content;
        continue;
      }
      history.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      });
    }
    const last = history.pop();
    return {
      system,
      history,
      prompt: last?.parts?.[0]?.text ?? "Hello",
    };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    const model = this.instance();
    const { system, history, prompt } = this.toGeminiMessages(options.messages);
    try {
      const chat = model.startChat({
        history,
        systemInstruction: system ?? undefined,
      });
      const result = await withTimeout(
        chat.sendMessage(prompt, { signal: options.signal }),
        this.timeoutMs,
        "Gemini"
      );
      return result.response.text();
    } catch (error) {
      throw mapGeminiError(error);
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    const model = this.instance();
    const { system, history, prompt } = this.toGeminiMessages(options.messages);
    try {
      const chat = model.startChat({
        history,
        systemInstruction: system ?? undefined,
      });
      const stream = await chat.sendMessageStream(prompt, { signal: options.signal });
      for await (const chunk of stream.stream) {
        const token = chunk.text();
        if (token) yield token;
      }
    } catch (error) {
      throw mapGeminiError(error);
    }
  }

  async generateVision(request: VisionRequest): Promise<string> {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    const model = this.instance();
    try {
      const result = await model.generateContent([
        {
          text:
            request.prompt ||
            "Describe what you see in this image in detail.",
        },
        {
          inlineData: {
            mimeType: request.mimeType || "image/jpeg",
            data: request.imageBase64,
          },
        },
      ]);
      return result.response.text();
    } catch (error) {
      throw mapGeminiError(error);
    }
  }

  private toVisionGeminiMessages(request: VisionChatRequest): {
    system: string | null;
    history: Content[];
  } {
    let system: string | null = null;
    const history: Content[] = [];
    for (const message of request.messages) {
      if (message.role === "system") {
        system = message.content;
        continue;
      }
      history.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      });
    }
    if (request.images.length > 0) {
      const imageParts = request.images.map((image) => ({
        inlineData: {
          mimeType: image.mimeType || "image/jpeg",
          data: image.data,
        },
      }));
      const last = history[history.length - 1];
      if (last && last.role === "user") {
        last.parts.push(...imageParts);
      } else {
        history.push({ role: "user", parts: imageParts });
      }
    }
    return { system, history };
  }

  async generateVisionChat(request: VisionChatRequest): Promise<string> {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    if (request.images.length === 0) {
      return this.generateText(request);
    }
    const model = this.instance();
    const { system, history } = this.toVisionGeminiMessages(request);
    const last = history[history.length - 1];
    try {
      const chat = model.startChat({
        history: history.slice(0, -1),
        systemInstruction: system ?? undefined,
      });
      const result = await withTimeout(
        chat.sendMessage(last?.parts ?? "", { signal: request.signal }),
        this.timeoutMs,
        "Gemini"
      );
      return result.response.text();
    } catch (error) {
      throw mapGeminiError(error);
    }
  }

  async *streamVisionChat(request: VisionChatRequest): AsyncGenerator<string> {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    if (request.images.length === 0) {
      yield* this.streamText(request);
      return;
    }
    const model = this.instance();
    const { system, history } = this.toVisionGeminiMessages(request);
    const last = history[history.length - 1];
    try {
      const chat = model.startChat({
        history: history.slice(0, -1),
        systemInstruction: system ?? undefined,
      });
      const stream = await chat.sendMessageStream(last?.parts ?? "", {
        signal: request.signal,
      });
      for await (const chunk of stream.stream) {
        const token = chunk.text();
        if (token) yield token;
      }
    } catch (error) {
      throw mapGeminiError(error);
    }
  }

  async healthCheck(): Promise<ProviderStatusDetail> {
    if (!this.client) {
      return {
        provider: "gemini",
        status: "not_configured",
        configured: false,
        model: null,
        error: null,
        latencyMs: null,
        vision: true,
      };
    }
    const startedAt = Date.now();
    try {
      const model = this.instance();
      await withTimeout(model.generateContent("ping"), this.healthTimeoutMs, "Gemini");
      return {
        provider: "gemini",
        status: "connected",
        configured: true,
        model: this.modelName,
        error: null,
        latencyMs: Date.now() - startedAt,
        vision: true,
      };
    } catch (error) {
      const mapped = mapGeminiError(error);
      return {
        provider: "gemini",
        status: "error",
        configured: true,
        model: this.modelName,
        error: mapped.message,
        latencyMs: Date.now() - startedAt,
        vision: true,
      };
    }
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      throw new AIError("Gemini is not configured.", "NO_PROVIDER", "gemini");
    }
    const key = (this.client as unknown as { apiKey?: string }).apiKey;
    if (!key) return [this.modelName];
    try {
      const res = await withTimeout(
        fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
        ),
        this.healthTimeoutMs,
        "Gemini"
      );
      if (!res.ok) return [this.modelName];
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => m.name.replace(/^models\//, ""));
    } catch {
      return [this.modelName];
    }
  }
}
