import { AIError, toAIError } from "../errors";
import { fetchWithTimeout } from "../http";
import { resizeImageForVlm, stripDataUrlPrefix } from "../image-resize";
import { aiLogger } from "../logger";
import type {
  GenerateTextOptions,
  ProviderName,
  ProviderStatusDetail,
  ToolCallInvocation,
  ToolCallResponse,
  VisionChatRequest,
  VisionRequest,
} from "../types";
import type { AIProvider } from "./types";

interface OllamaProviderConfig {
  baseUrl: string;
  model: string | null;
  gemma3Model?: string | null;
  timeoutMs: number;
  visionTimeoutMs: number;
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
  "qwen3:1.7b",
  "qwen3:4b",
  "llama3.2:3b",
  "gemma3:4b",
  "qwen2.5:3b",
  "phi3:mini",
];

const KEEP_ALIVE_MS = 5 * 60_000;

/** Generic camera-frame analysis budget when the caller does not set one. */
const VISION_DEFAULT_MAX_TOKENS = 512;

/**
 * Reasoning/thinking trace stripping (requirement 7: never let internal CoT
 * reach the UI).
 *
 * Qwen3-family models emit their reasoning monologue into `message.content`
 * even with `think: false`; the monologue is NOT wrapped in an opening
 * `<think>` tag, but it reliably ends with a literal closing tag. We therefore
 * drop everything from the start up to and including the first closing
 * reasoning tag, so only the final answer survives.
 */
const REASONING_PREFIX_RE = /^[\s\S]*?<\/(?:think|reasoning|thought)>\s*/i;
const REASONING_BLOCK_RE =
  /<think>[\s\S]*?<\/think>|<reasoning>[\s\S]*?<\/reasoning>|<thought>[\s\S]*?<\/thought>/gi;
const REASONING_CLOSE_RE = /<\/(?:think|reasoning|thought)>/i;
/** Opening reasoning tag — mirrored to what REASONING_CLOSE_RE can close. */
const REASONING_OPEN_RE = /<\s*(?:think|reasoning|thought)\b/i;
/** Keep this many characters buffered while streaming clean content, so an
 *  opening reasoning tag that straddles a chunk boundary is still stripped. */
const STRIP_MARGIN = 64;

/** Models whose raw content channel carries the reasoning prefix. */
const REASONING_LEAK_MODELS = ["qwen3", "qwen2.5", "qwq", "deepseek", "kimi"];
const holdsReasoningContent = (model: string): boolean =>
  REASONING_LEAK_MODELS.some((name) => model.toLowerCase().includes(name));

export function stripReasoningOutput(content: string): string {
  let stripped = content.replace(REASONING_PREFIX_RE, "");
  stripped = stripped.replace(REASONING_BLOCK_RE, "").trim();
  if (stripped.startsWith("think:")) {
    stripped = stripped.slice("think:".length).trim();
  }
  return stripped;
}

/**
 * Remove a dangling reasoning tag left at the end of a truncated response
 * (e.g. an unclosed `<think>` when inference hit its token budget), so no
 * reasoning artifact ever reaches the UI. Non-reasoning content is untouched.
 */
export function stripDanglingReasoning(content: string): string {
  return content
    .replace(/<(?:\/)?(?:think|reasoning|thought)>\s*$/gi, "")
    .trim();
}

/**
 * Streaming reasoning strip. Only a real reasoning block (opening tag present)
 * is buffered — everything before the block and after its closing tag streams
 * in real time. Content that never opens a reasoning block is passed through
 * immediately, so a slow model can never hold the whole response hostage while
 * the UI sits blank. Non-reasoning models pass through untouched.
 */
async function* stripReasoningPrefixStream(
  model: string,
  source: AsyncGenerator<string>
): AsyncGenerator<string> {
  if (!holdsReasoningContent(model)) {
    yield* source;
    return;
  }
  let pending = "";
  let released = false;
  let inBlock = false;
  for await (const token of source) {
    if (released) {
      yield token;
      continue;
    }
    pending += token;
    const open = REASONING_OPEN_RE.exec(pending);
    if (open) {
      inBlock = true;
      const head = pending.slice(0, open.index);
      if (head) yield head;
      pending = pending.slice(open.index);
      const close = REASONING_CLOSE_RE.exec(pending);
      if (close) {
        inBlock = false;
        released = true;
        const tail = pending.slice(close.index + close[0].length);
        pending = "";
        if (tail) yield tail;
      }
      continue;
    }
    // No reasoning block opened — this is clean final-answer content. Stream
    // it through with a small margin so an opening tag straddling a chunk
    // boundary is still caught and stripped.
    if (pending.length > STRIP_MARGIN) {
      const head = pending.slice(0, pending.length - STRIP_MARGIN);
      pending = pending.slice(-STRIP_MARGIN);
      if (head) yield head;
    }
  }
  if (!released && !inBlock) {
    const remaining = stripReasoningOutput(pending);
    if (remaining) yield remaining;
  }
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  name?: string;
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

function parseToolCalls(calls?: OllamaToolCall[]): ToolCallInvocation[] {
  if (!Array.isArray(calls)) return [];
  const parsed: ToolCallInvocation[] = [];
  for (const call of calls) {
    const fn = call?.function;
    if (!fn?.name) continue;
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        const candidate = JSON.parse(fn.arguments);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          args = candidate as Record<string, unknown>;
        }
      } catch {
        // ignore malformed arguments
      }
    } else if (fn.arguments && typeof fn.arguments === "object") {
      args = fn.arguments as Record<string, unknown>;
    }
    parsed.push({ name: fn.name, arguments: args });
  }
  return parsed;
}

export class OllamaProvider implements AIProvider {
  readonly name: ProviderName = "ollama";

  private readonly baseUrl: string;
  private readonly configuredModel: string | null;
  private readonly gemma3Model: string | null;
  private readonly timeoutMs: number;
  private readonly visionTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly log = aiLogger.child("ollama");

  constructor(config: OllamaProviderConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.configuredModel = config.model;
    this.gemma3Model = config.gemma3Model ?? null;
    this.timeoutMs = config.timeoutMs;
    this.visionTimeoutMs = config.visionTimeoutMs;
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

  /**
   * Resolve the exact Gemma 3 vision model available on Ollama, or null when
   * it is not installed. Only Gemma 3 is allowed to analyze camera frames.
   * Honors GEMMA3_MODEL first; auto-detection prefers the smallest Gemma 3
   * (4b) so frame analysis stays fast on CPU instead of falling back to 12b.
   */
  async resolveGemma3Model(): Promise<string | null> {
    if (
      this.gemma3Model &&
      this.gemma3Model.toLowerCase().includes("gemma3")
    ) {
      return this.gemma3Model;
    }
    if (
      this.configuredModel &&
      this.configuredModel.toLowerCase().includes("gemma3")
    ) {
      return this.configuredModel;
    }
    try {
      const available = await this.fetchTags();
      const isGemma3 = (name: string) =>
        name.toLowerCase().includes("gemma3");
      return (
        available.find((name) => isGemma3(name) && name.toLowerCase().includes(":4b")) ??
        available.find(isGemma3) ??
        null
      );
    } catch (error) {
      this.log.warn("Could not list Ollama models to find Gemma 3", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async resolveModel(
    requireVision: boolean,
    hint?: string | null
  ): Promise<string> {
    if (hint) {
      if (requireVision) {
        const isVision = VISION_KEYWORDS.some((keyword) =>
          hint.toLowerCase().includes(keyword)
        );
        if (isVision) return hint;
        this.log.warn(
          `Configured vision model "${hint}" is not a known multimodal model — auto-selecting instead`,
          { hint }
        );
      } else {
        return hint;
      }
    }
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
    stream: boolean,
    model: string
  ): Record<string, unknown> {
    // `think: false` is a no-op for Qwen3: it reasons anyway, but dumps the
    // monologue inline in the content channel with a closing tag that only
    // arrives after the whole generation — which forced the streaming strip to
    // buffer every Qwen3 response in full, so the UI sat blank for the entire
    // CPU-bound generation. Without the flag Qwen3 keeps its thinking on the
    // hidden `message.reasoning` channel and streams the clean answer as it is
    // generated (verified against Ollama directly). Other reasoning models
    // (DeepSeek-R1 etc.) DO honor the flag, so it stays on for them.
    const suppressThinking = !/qwen3/i.test(model);
    const body: Record<string, unknown> = {
      model,
      messages: this.toOllamaMessages(options),
      stream,
      keep_alive: KEEP_ALIVE_MS,
      ...(suppressThinking ? { think: false } : {}),
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens,
        ...(suppressThinking ? { enable_thinking: false } : {}),
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
      ...(m.role === "tool" && m.name ? { name: m.name } : {}),
    }));
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const model = await this.resolveModel(false, options.model);
    const startedAt = Date.now();
    const body = this.baseBody(options, false, model);
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
    const content = stripReasoningOutput(data.message?.content ?? "");
    this.log.info("Ollama request finished", {
      model,
      stream: false,
      chars: content.length,
      evalTokens: data.eval_count ?? null,
      latencyMs: Date.now() - startedAt,
    });
    return content;
  }

  async generateWithTools(
    options: GenerateTextOptions
  ): Promise<ToolCallResponse> {
    const model = await this.resolveModel(false, options.model);
    const startedAt = Date.now();
    const body = this.baseBody(options, false, model);
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
      message?: { content?: string; tool_calls?: OllamaToolCall[] };
    };
    const content = stripReasoningOutput(data.message?.content ?? "");
    const toolCalls = parseToolCalls(data.message?.tool_calls);
    this.log.info("Ollama tool-enabled request finished", {
      model,
      chars: content.length,
      toolCalls: toolCalls.length,
      latencyMs: Date.now() - startedAt,
    });
    return { content, toolCalls };
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const model = await this.resolveModel(false, options.model);
    const body = this.baseBody(options, true, model);
    yield* this.streamResponse(body, options.signal);
  }

  private async *streamResponse(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = this.timeoutMs
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
      timeoutMs
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
    const modelName = String(body.model ?? "");
    try {
      const rawTokens = async function* (): AsyncGenerator<string> {
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
      };
      yield* stripReasoningPrefixStream(modelName, rawTokens());
    } finally {
      reader.releaseLock();
      this.log.info("Ollama stream finished", {
        model: modelName,
        stream: true,
        evalTokens,
        ttftMs: firstTokenAt !== null ? firstTokenAt - startedAt : null,
        totalMs: Date.now() - startedAt,
        aborted: signal?.aborted ?? false,
      });
    }
  }

  async generateVision(request: VisionRequest): Promise<string> {
    const model = await this.resolveModel(true, request.model);
    // Downscale first: a full-res webcam frame is 4-9x more vision tokens than
    // a 512px version, and image prefill dominates latency on local hardware.
    // The resize is bounded (~30-60ms with sharp) and fails soft back to the
    // original frame.
    const imageBase64 = await resizeImageForVlm(request.imageBase64);
    const images = [stripDataUrlPrefix(imageBase64)];
    const messages: OllamaMessage[] = [
      {
        role: "user",
        content:
          request.prompt || "Describe what you see in this image in detail.",
        images,
      },
    ];
    const body = {
      model,
      messages,
      stream: false,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
      options: {
        enable_thinking: false,
        // Explicit num_predict: without it Ollama defaults to the model's full
        // context (2048+ tokens) and keeps generating for minutes on slow CPUs
        // even though the JSON answers are ~100-400 tokens. The caller passes a
        // small budget (96 focused / 384 full); 512 is the generic default.
        num_predict: request.maxTokens ?? VISION_DEFAULT_MAX_TOKENS,
      },
    };
    const startedAt = Date.now();
    this.log.info("✓ Request sent to Gemma 3", {
      model,
      images: images.length,
      imageBytes: Math.round(request.imageBase64.length * 0.75),
    });
    const res = await fetchWithTimeout(
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
      },
      this.visionTimeoutMs
    );
    if (!res.ok) {
      throw this.mapOllamaStatus(res.status);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    const content = stripDanglingReasoning(
      stripReasoningOutput(data.message?.content ?? "")
    );
    this.log.info("✓ Vision response received", {
      model,
      chars: content.length,
      latencyMs: Date.now() - startedAt,
    });
    return content;
  }

  private toVisionOllamaMessages(request: VisionChatRequest): OllamaMessage[] {
    const messages: OllamaMessage[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.role === "tool" && m.name ? { name: m.name } : {}),
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
    const model = await this.resolveModel(true, request.model);
    const body = {
      model,
      messages: this.toVisionOllamaMessages(request),
      stream: false,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        enable_thinking: false,
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
      this.visionTimeoutMs
    );
    if (!res.ok) {
      throw this.mapOllamaStatus(res.status);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return stripDanglingReasoning(
      stripReasoningOutput(data.message?.content ?? "")
    );
  }

  async *streamVisionChat(request: VisionChatRequest): AsyncGenerator<string> {
    if (request.images.length === 0) {
      yield* this.streamText(request);
      return;
    }
    const model = await this.resolveModel(true, request.model);
    const body = {
      model,
      messages: this.toVisionOllamaMessages(request),
      stream: true,
      keep_alive: KEEP_ALIVE_MS,
      think: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        enable_thinking: false,
      },
    };
    yield* this.streamResponse(body, request.signal, this.visionTimeoutMs);
  }

  async healthCheck(): Promise<ProviderStatusDetail> {
    const startedAt = Date.now();
    try {
      const available = await this.fetchTags();
      const model = this.configuredModel ?? available[0] ?? null;
      const matchesVision = (name: string): boolean => {
        const lower = name.toLowerCase();
        return VISION_KEYWORDS.some((keyword) => lower.includes(keyword));
      };
      const configuredIsVision =
        this.configuredModel !== null && matchesVision(this.configuredModel);
      const hasVision =
        available.some((name) => matchesVision(name)) || configuredIsVision;
      const visionModel = configuredIsVision
        ? this.configuredModel
        : available.find((name) => matchesVision(name)) ?? null;
      this.log.info("Ollama connected", {
        model: model ?? "none",
        models: available.length,
        visionModel: visionModel ?? null,
      });
      return {
        provider: "ollama",
        status: "connected",
        configured: true,
        model,
        error: null,
        latencyMs: Date.now() - startedAt,
        vision: hasVision,
        visionModel,
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
