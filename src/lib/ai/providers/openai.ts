import OpenAI from "openai";
import { AIError, mapOpenAIError } from "../errors";
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

export class OpenAIProvider extends BaseProvider<OpenAI> {
  readonly name: ProviderName = "openai";

  constructor(config: ProviderConfig) {
    super(
      config,
      config.apiKey
        ? new OpenAI({
            apiKey: config.apiKey,
            timeout: config.timeoutMs,
            maxRetries: 2,
          })
        : null,
      "openai"
    );
    if (this.client) {
      this.log.info("OpenAI initialized (API key detected)", {
        model: this.modelName,
      });
    } else {
      this.log.warn("OpenAI not initialized (no API key)");
    }
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
    return checkProviderHealth({
      provider: "openai",
      configured: this.isConfigured(),
      model: this.getModel(),
      vision: true,
      ping: async () => {
        const page = await withTimeout(
          this.client!.models.list(),
          this.healthTimeoutMs,
          "OpenAI"
        );
        void page.data;
      },
      messageFor: (error) => mapOpenAIError(error).message,
    });
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      throw new AIError("OpenAI is not configured.", "NO_PROVIDER", "openai");
    }
    const page = await this.client.models.list();
    return page.data.map((m) => m.id);
  }
}
