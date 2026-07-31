import Anthropic from "@anthropic-ai/sdk";
import { AIError, mapAnthropicError } from "../errors";
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

interface AnthropicProviderConfig {
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  healthTimeoutMs: number;
}

type AnthropicVisionContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type:
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp";
            data: string;
          };
        }
    >;

export class AnthropicProvider implements AIProvider {
  readonly name: ProviderName = "anthropic";

  private readonly client: Anthropic | null;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly log = aiLogger.child("anthropic");

  constructor(config: AnthropicProviderConfig) {
    this.modelName = config.model;
    this.timeoutMs = config.timeoutMs;
    this.healthTimeoutMs = config.healthTimeoutMs;
    this.client = config.apiKey
      ? new Anthropic({ apiKey: config.apiKey, timeout: config.timeoutMs, maxRetries: 2 })
      : null;
    if (this.client) {
      this.log.info("Anthropic initialized (API key detected)", { model: this.modelName });
    } else {
      this.log.warn("Anthropic not initialized (no API key)");
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

  private splitSystem(messages: AIMessageInput[]): {
    system: string | undefined;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    const system = messages.find((m) => m.role === "system")?.content;
    const conversation = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    return { system, messages: conversation };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    if (!this.client) {
      throw new AIError("Anthropic is not configured.", "NO_PROVIDER", "anthropic");
    }
    const { system, messages } = this.splitSystem(options.messages);
    try {
      const response = await this.client.messages.create(
        {
          model: options.model ?? this.modelName,
          max_tokens: options.maxTokens ?? 1024,
          temperature: options.temperature,
          system,
          messages,
        },
        { signal: options.signal }
      );
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    if (!this.client) {
      throw new AIError("Anthropic is not configured.", "NO_PROVIDER", "anthropic");
    }
    const { system, messages } = this.splitSystem(options.messages);
    try {
      const stream = await this.client.messages.create(
        {
          model: options.model ?? this.modelName,
          max_tokens: options.maxTokens ?? 1024,
          temperature: options.temperature,
          system,
          messages,
          stream: true,
        },
        { signal: options.signal }
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  async generateVision(request: VisionRequest): Promise<string> {
    if (!this.client) {
      throw new AIError("Anthropic is not configured.", "NO_PROVIDER", "anthropic");
    }
    const mimeType = request.mimeType || "image/jpeg";
    try {
      const response = await this.client.messages.create({
        model: this.modelName,
        max_tokens: 1024,
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
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType as "image/jpeg",
                  data: request.imageBase64,
                },
              },
            ],
          },
        ],
      });
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  private toVisionAnthropicMessages(request: VisionChatRequest): Array<{
    role: "user" | "assistant";
    content: AnthropicVisionContent;
  }> {
    const messages: Array<{
      role: "user" | "assistant";
      content: AnthropicVisionContent;
    }> = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
    if (request.images.length > 0) {
      const imageParts = request.images.map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: (image.mimeType ||
            "image/jpeg") as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: image.data,
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
    return messages;
  }

  async generateVisionChat(request: VisionChatRequest): Promise<string> {
    if (!this.client) {
      throw new AIError("Anthropic is not configured.", "NO_PROVIDER", "anthropic");
    }
    if (request.images.length === 0) {
      return this.generateText(request);
    }
    const { system } = this.splitSystem(request.messages);
    try {
      const response = await this.client.messages.create(
        {
          model: request.model ?? this.modelName,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature,
          system,
          messages: this.toVisionAnthropicMessages(request),
        },
        { signal: request.signal }
      );
      return response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  async *streamVisionChat(request: VisionChatRequest): AsyncGenerator<string> {
    if (!this.client) {
      throw new AIError("Anthropic is not configured.", "NO_PROVIDER", "anthropic");
    }
    if (request.images.length === 0) {
      yield* this.streamText(request);
      return;
    }
    const { system } = this.splitSystem(request.messages);
    try {
      const stream = await this.client.messages.create(
        {
          model: request.model ?? this.modelName,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature,
          system,
          messages: this.toVisionAnthropicMessages(request),
          stream: true,
        },
        { signal: request.signal }
      );
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    } catch (error) {
      throw mapAnthropicError(error);
    }
  }

  async healthCheck(): Promise<ProviderStatusDetail> {
    if (!this.client) {
      return {
        provider: "anthropic",
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
      await withTimeout(
        this.client.messages.create({
          model: this.modelName,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        this.healthTimeoutMs,
        "Anthropic"
      );
      return {
        provider: "anthropic",
        status: "connected",
        configured: true,
        model: this.modelName,
        error: null,
        latencyMs: Date.now() - startedAt,
        vision: true,
      };
    } catch (error) {
      const mapped = mapAnthropicError(error);
      return {
        provider: "anthropic",
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
    return [this.modelName];
  }
}
