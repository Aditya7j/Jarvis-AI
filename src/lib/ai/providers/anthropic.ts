import Anthropic from "@anthropic-ai/sdk";
import { AIError, mapAnthropicError } from "../errors";
import { withTimeout } from "../http";
import type {
  AIMessageInput,
  GenerateTextOptions,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "../types";
import { BaseProvider, type ProviderConfig } from "./base";
import { checkProviderHealth } from "./health";

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

export class AnthropicProvider extends BaseProvider<Anthropic> {
  readonly name: ProviderName = "anthropic";

  constructor(config: ProviderConfig) {
    super(
      config,
      config.apiKey
        ? new Anthropic({
            apiKey: config.apiKey,
            timeout: config.timeoutMs,
            maxRetries: 2,
          })
        : null,
      "anthropic"
    );
    if (this.client) {
      this.log.info("Anthropic initialized (API key detected)", {
        model: this.modelName,
      });
    } else {
      this.log.warn("Anthropic not initialized (no API key)");
    }
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
    return checkProviderHealth({
      provider: "anthropic",
      configured: this.isConfigured(),
      model: this.getModel(),
      vision: true,
      ping: async () => {
        await withTimeout(
          this.client!.messages.create({
            model: this.modelName,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
          this.healthTimeoutMs,
          "Anthropic"
        );
      },
      messageFor: (error) => mapAnthropicError(error).message,
    });
  }

  async listModels(): Promise<string[]> {
    return [this.modelName];
  }
}
