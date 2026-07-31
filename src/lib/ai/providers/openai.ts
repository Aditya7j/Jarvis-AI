import OpenAI from "openai";
import { AIError, mapOpenAIError } from "../errors";
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

interface OpenAIProviderConfig {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  healthTimeoutMs: number;
}

export class OpenAIProvider implements AIProvider {
  readonly name: ProviderName = "openai";

  private readonly client: OpenAI | null;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly log = aiLogger.child("openai");

  constructor(config: OpenAIProviderConfig) {
    this.modelName = config.model;
    this.timeoutMs = config.timeoutMs;
    this.healthTimeoutMs = config.healthTimeoutMs;
    this.client = config.apiKey
      ? new OpenAI({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 2 })
      : null;
    if (this.client) {
      this.log.info("OpenAI initialized (API key detected)", { model: this.modelName });
    } else {
      this.log.warn("OpenAI not initialized (no API key)");
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

  private toOpenAIMessages(messages: AIMessageInput[]) {
    return messages.map((m) => ({
      role: m.role as "system" | "user" | "assistant",
      content: m.content,
    }));
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    if (!this.client) {
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: options.model ?? this.modelName,
          messages: this.toOpenAIMessages(options.messages),
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream: false,
        },
        { signal: options.signal }
      );
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    if (!this.client) {
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: options.model ?? this.modelName,
          messages: this.toOpenAIMessages(options.messages),
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          stream: true,
        },
        { signal: options.signal }
      );
      for await (const part of stream) {
        const token = part.choices[0]?.delta?.content;
        if (token) yield token;
      }
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }

  async generateVision(request: VisionRequest): Promise<string> {
    if (!this.client) {
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    const mimeType = request.mimeType || "image/jpeg";
    try {
      const completion = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  request.prompt ||
                  "Describe what you see in this image in detail.",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${request.imageBase64}`,
                },
              },
            ],
          },
        ],
      });
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }

  private toVisionOpenAIMessages(
    request: VisionChatRequest
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content:
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "image_url"; image_url: { url: string } }
          >;
    }> = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (request.images.length > 0) {
      const imageParts: Array<{
        type: "image_url";
        image_url: { url: string };
      }> = request.images.map((image) => ({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType || "image/jpeg"};base64,${image.data}`,
        },
      }));
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        if (typeof last.content === "string") {
          last.content = [{ type: "text", text: last.content }, ...imageParts];
        } else {
          last.content = [...last.content, ...imageParts];
        }
      } else {
        messages.push({ role: "user", content: imageParts });
      }
    }
    return messages as OpenAI.Chat.ChatCompletionMessageParam[];
  }

  async generateVisionChat(request: VisionChatRequest): Promise<string> {
    if (!this.client) {
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    if (request.images.length === 0) {
      return this.generateText(request);
    }
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: request.model ?? this.modelName,
          messages: this.toVisionOpenAIMessages(request),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: false,
        },
        { signal: request.signal }
      );
      return completion.choices[0]?.message?.content ?? "";
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }

  async *streamVisionChat(request: VisionChatRequest): AsyncGenerator<string> {
    if (!this.client) {
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    if (request.images.length === 0) {
      yield* this.streamText(request);
      return;
    }
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: request.model ?? this.modelName,
          messages: this.toVisionOpenAIMessages(request),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: true,
        },
        { signal: request.signal }
      );
      for await (const part of stream) {
        const token = part.choices[0]?.delta?.content;
        if (token) yield token;
      }
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }

  async healthCheck(): Promise<ProviderStatusDetail> {
    if (!this.client) {
      return {
        provider: "openai",
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
      const page = await withTimeout(this.client.models.list(), this.healthTimeoutMs, "OpenAI");
      void page.data;
      return {
        provider: "openai",
        status: "connected",
        configured: true,
        model: this.modelName,
        error: null,
        latencyMs: Date.now() - startedAt,
        vision: true,
      };
    } catch (error) {
      const mapped = mapOpenAIError(error);
      return {
        provider: "openai",
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
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    const page = await this.client.models.list();
    return page.data.map((m) => m.id);
  }
}
