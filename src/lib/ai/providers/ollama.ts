import { AIError, toAIError } from "../errors";
import { fetchWithTimeout } from "../http";
import { aiLogger } from "../logger";
import type {
  GenerateTextOptions,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "../types";
import type { AIProvider } from "./types";

interface OllamaProviderConfig {
  baseUrl: string;
  model: string | null;
  timeoutMs: number;
  healthTimeoutMs: number;
}

const VISION_KEYWORDS = [
  "llava",
  "bakllava",
  "moondream",
  "minicpm",
  "qwen2-vl",
  "qwen2.5-vl",
  "vision",
  "llama3.2-vision",
  "gemma3",
  "phi4-vision",
  "granite3.2-vision",
];

const FAST_MODEL_PREFERENCE = [
  "qwen3:1.8b",
  "qwen3:4b",
  "llama3.2:3b",
  "gemma3:4b",
  "qwen2.5:3b",
  "phi3:mini",
];

const KEEP_ALIVE_MS = 5 * 60_000;

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export class OllamaProvider implements AIProvider {
  readonly name: ProviderName = "ollama";

  private readonly baseUrl: string;
  private readonly configuredModel: string | null;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly log = aiLogger.child("ollama");

  constructor(config: OllamaProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.configuredModel = config.model;
    this.timeoutMs = config.timeoutMs;
    this.healthTimeoutMs = config.healthTimeoutMs;
    this.log.info("Ollama provider registered", { baseUrl: this.baseUrl });
  }

  isConfigured(): boolean {
    return true;
  }

  getModel(): string | null {
    return this.configuredModel;
  }

  supportsVision(): boolean {
    return true;
  }

  private async fetchTags(): Promise<string[]> {
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/tags`,
      {},
      this.healthTimeoutMs
    );
    if (!res.ok) {
      throw new AIError(
        `Ollama server responded with ${res.status} at ${this.baseUrl}`,
        "CONNECTION_FAILED",
        "ollama",
        res.status
      );
    }
    const body = (await res.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map((m) => m.name);
  }

  private async resolveModel(requireVision: boolean): Promise<string> {
    if (this.configuredModel) {
      if (requireVision) {
        const lower = this.configuredModel.toLowerCase();
        const isVision = VISION_KEYWORDS.some((keyword) => lower.includes(keyword));
        if (!isVision) {
          throw new AIError(
            `Ollama model "${this.configuredModel}" is not a known multimodal model. Set OLLAMA_MODEL to a vision model (e.g. llama3.2-vision, llava).`,
            "MODEL_UNAVAILABLE",
            "ollama"
          );
        }
      }
      return this.configuredModel;
    }

    const available = await this.fetchTags();
    const fast = available.find((name) => {
      const lower = name.toLowerCase();
      return FAST_MODEL_PREFERENCE.some((pref) => lower.startsWith(pref));
    });
    if (requireVision) {
      const vision = available.find((name) => {
        const lower = name.toLowerCase();
        return VISION_KEYWORDS.some((keyword) => lower.includes(keyword));
      });
      if (vision) return vision;
      throw new AIError(
        `No multimodal (vision) model found on Ollama. Available: ${
          available.join(", ") || "none"
        }. Install one, e.g. "ollama pull llama3.2-vision".`,
        "MODEL_UNAVAILABLE",
        "ollama"
      );
    }
    return fast ?? available[0] ?? "llama3.2";
  }

  private baseBody(
    options: GenerateTextOptions,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: "", // filled by caller after model resolution
      messages: this.toOllamaMessages(options),
      stream,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
      },
    };
    if (options.tools?.length) {
      body.tools = options.tools;
    }
    return body;
  }

  private toOllamaMessages(
    options: GenerateTextOptions
  ): OllamaMessage[] {
    return options.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const model = await this.resolveModel(false);
    const startedAt = Date.now();
    const body = this.baseBody(options, false);
    body.model = model;
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      },
      this.timeoutMs
    );
    if (!res.ok) {
      throw this.mapOllamaStatus(res.status);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      eval_count?: number;
      total_duration?: number;
    };
    const content = data.message?.content ?? "";
    this.log.info("Ollama request finished", {
      model,
      stream: false,
      chars: content.length,
      evalTokens: data.eval_count ?? null,
      latencyMs: Date.now() - startedAt,
    });
    return content;
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const model = await this.resolveModel(false);
    const body = this.baseBody(options, true);
    body.model = model;
    yield* this.streamResponse(body, options.signal);
  }

  private async *streamResponse(
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): AsyncGenerator<string> {
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let evalTokens = 0;
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
      this.timeoutMs
    );
    if (!res.ok) {
      throw this.mapOllamaStatus(res.status);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      throw new AIError("Ollama returned no response stream.", "PROVIDER_ERROR", "ollama");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        if (signal?.aborted) {
          throw new AIError("Request aborted by caller.", "REQUEST_ABORTED");
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as {
              message?: { content?: string };
              eval_count?: number;
              done?: boolean;
            };
            const token = parsed.message?.content;
            if (token) {
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
              }
              evalTokens = parsed.eval_count ?? evalTokens;
              yield token;
            }
            if (parsed.done) {
              evalTokens = parsed.eval_count ?? evalTokens;
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
      this.log.info("Ollama stream finished", {
        model: body.model,
        stream: true,
        evalTokens,
        ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null,
        totalMs: Date.now() - startedAt,
        aborted: signal?.aborted ?? false,
      });
    }
  }

  async generateVision(request: VisionRequest): Promise<string> {
    const model = await this.resolveModel(true);
    const messages: OllamaMessage[] = [
      {
        role: "user",
        content:
          request.prompt || "Describe what you see in this image in detail.",
        images: [request.imageBase64],
      },
    ];
    const body = {
      model,
      messages,
      stream: false,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
    };
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.timeoutMs
    );
    if (!res.ok) {
      throw this.mapOllamaStatus(res.status);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  private toVisionOllamaMessages(request: VisionChatRequest): OllamaMessage[] {
    const messages: OllamaMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (request.images.length > 0) {
      const images = request.images.map((image) => image.data);
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        last.images = images;
      } else {
        messages.push({ role: "user", content: "", images });
      }
    }
    return messages;
  }

  async generateVisionChat(request: VisionChatRequest): Promise<string> {
    if (request.images.length === 0) {
      return this.generateText(request);
    }
    const model = await this.resolveModel(true);
    const body = {
      model,
      messages: this.toVisionOllamaMessages(request),
      stream: false,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
      },
    };
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      },
      this.timeoutMs
    );
    if (!res.ok) {
      throw this.mapOllamaStatus(res.status);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? "";
  }

  async *streamVisionChat(request: VisionChatRequest): AsyncGenerator<string> {
    if (request.images.length === 0) {
      yield* this.streamText(request);
      return;
    }
    const model = await this.resolveModel(true);
    const body = {
      model,
      messages: this.toVisionOllamaMessages(request),
      stream: true,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
      },
    };
    yield* this.streamResponse(body, request.signal);
  }

  async healthCheck(): Promise<ProviderStatusDetail> {
    const startedAt = Date.now();
    try {
      const available = await this.fetchTags();
      const model = this.configuredModel ?? available[0] ?? null;
      const hasVision = available.some((name) => {
        const lower = name.toLowerCase();
        return VISION_KEYWORDS.some((keyword) => lower.includes(keyword));
      });
      this.log.info("Ollama connected", {
        model: model ?? "none",
        models: available.length,
      });
      return {
        provider: "ollama",
        status: "connected",
        configured: true,
        model,
        error: null,
        latencyMs: Date.now() - startedAt,
        vision: hasVision || this.configuredModel !== null,
      };
    } catch (error) {
      const mapped = toAIError(error, "ollama");
      return {
        provider: "ollama",
        status: "not_running",
        configured: true,
        model: null,
        error:
          mapped.code === "CONNECTION_TIMEOUT"
            ? `Ollama server not responding at ${this.baseUrl}.`
            : `Ollama server not running at ${this.baseUrl}. Start it with "ollama serve".`,
        latencyMs: Date.now() - startedAt,
        vision: false,
      };
    }
  }

  async listModels(): Promise<string[]> {
    return this.fetchTags();
  }

  private mapOllamaStatus(status: number): AIError {
    if (status === 404) {
      return new AIError(
        "Ollama model not found. Pull it first, e.g. \"ollama pull llama3.2\".",
        "MODEL_UNAVAILABLE",
        "ollama",
        status
      );
    }
    return new AIError(
      `Ollama request failed with status ${status}.`,
      "PROVIDER_ERROR",
      "ollama",
      status
    );
  }
}
