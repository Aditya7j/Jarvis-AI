import { randomUUID } from "crypto";
import { loadEnvConfig, type EnvConfig } from "./config";
import { AIError, isAbortError, toAIError } from "./errors";
import { aiLogger } from "./logger";
import {
  attemptEnded,
  attemptStarted,
  type MetricEndStatus,
  type MetricKind,
} from "../metrics/metrics";
import { appendMemoryContext, memoryService } from "../memory";
import { trimContextWindow } from "./context-window";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";
import { clearRuntimeKey, getRuntimeKey, setRuntimeKey } from "./registry";
import {
  detectPiper,
  detectWhisper,
  resolveSttEngine,
  resolveTtsEngine,
} from "./local-tools";
import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { OllamaProvider } from "./providers/ollama";
import { OpenAIProvider } from "./providers/openai";
import type { AIProvider } from "./providers/types";
import { describeRoles, roleModelName, type ModelRole } from "./router";
import { executeTool, initToolRouter } from "@/services/tools";
import { APP_VERSION } from "./version";
import type {
  AIMessageInput,
  GenerateTextOptions,
  HealthSummary,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "./types";
import type { MetricStages } from "../metrics/metrics";

export const PROVIDER_PRIORITY: ProviderName[] = [
  "gemini",
  "ollama",
  "openai",
  "anthropic",
];

const HEALTH_CACHE_MS = 10_000;

export class AIProviderService {
  private readonly config: EnvConfig;
  private readonly providers = new Map<ProviderName, AIProvider>();
  private readonly failures = new Map<ProviderName, { until: number; code: string }>();
  private cachedHealth: HealthSummary | null = null;
  private readonly log = aiLogger.child("service");

  private beginAttempt(
    kind: MetricKind,
    provider: ProviderName,
    model: string | null | undefined
  ): { id: string; startedAt: number } {
    const id = randomUUID();
    const startedAt = Date.now();
    attemptStarted({ id, kind, provider, model: model ?? "unknown", startedAt });
    return { id, startedAt };
  }

  private endAttempt(
    id: string,
    startedAt: number,
    status: MetricEndStatus,
    extra?: {
      ttfbMs?: number | null;
      chars?: number | null;
      tokens?: number | null;
      errorCode?: string | null;
      message?: string | null;
      stages?: MetricStages | null;
    }
  ): void {
    attemptEnded({
      id,
      status,
      durationMs: Date.now() - startedAt,
      ttfbMs: extra?.ttfbMs ?? null,
      chars: extra?.chars ?? null,
      tokens: extra?.tokens ?? null,
      errorCode: extra?.errorCode ?? null,
      message: extra?.message ?? null,
      stages: extra?.stages ?? null,
    });
  }

  private static statusFor(error: AIError): MetricEndStatus {
    if (error.code === "CONNECTION_TIMEOUT") return "timeout";
    if (isAbortError(error)) return "aborted";
    return "error";
  }

  private async *trackedStream(
    kind: MetricKind,
    provider: ProviderName,
    model: string | null | undefined,
    generator: AsyncGenerator<string>
  ): AsyncGenerator<string> {
    const attempt = this.beginAttempt(kind, provider, model);
    let ttfbMs: number | null = null;
    let chars = 0;
    try {
      const iterator = generator[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          this.endAttempt(attempt.id, attempt.startedAt, "ok", { ttfbMs, chars });
          return;
        }
        if (ttfbMs === null) ttfbMs = Date.now() - attempt.startedAt;
        chars += next.value.length;
        yield next.value;
      }
    } catch (error) {
      const mapped = toAIError(error, provider);
      this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
        ttfbMs,
        chars,
        errorCode: mapped.code,
        message: mapped.message,
      });
      throw error;
    }
  }

  constructor() {
    this.config = loadEnvConfig();
    this.buildProviders();
  }

  private buildProviders(): void {
    this.providers.clear();
    this.providers.set(
      "gemini",
      new GeminiProvider({
        apiKey: getRuntimeKey("gemini") ?? this.config.geminiApiKey,
        model: this.config.geminiModel,
        timeoutMs: this.config.requestTimeoutMs,
        healthTimeoutMs: this.config.healthTimeoutMs,
      })
    );
    this.providers.set(
      "openai",
      new OpenAIProvider({
        apiKey: getRuntimeKey("openai") ?? this.config.openaiApiKey,
        model: this.config.openaiModel,
        timeoutMs: this.config.requestTimeoutMs,
        healthTimeoutMs: this.config.healthTimeoutMs,
      })
    );
    this.providers.set(
      "anthropic",
      new AnthropicProvider({
        apiKey: getRuntimeKey("anthropic") ?? this.config.anthropicApiKey,
        model: this.config.anthropicModel,
        timeoutMs: this.config.requestTimeoutMs,
        healthTimeoutMs: this.config.healthTimeoutMs,
      })
    );
    this.providers.set(
      "ollama",
      new OllamaProvider({
        baseUrl: this.config.ollamaBaseUrl,
        model: this.config.ollamaModel,
        timeoutMs: this.config.requestTimeoutMs,
        visionTimeoutMs: this.config.visionTimeoutMs,
        healthTimeoutMs: this.config.healthTimeoutMs,
      })
    );
  }

  configureProvider(name: ProviderName, apiKey: string): void {
    setRuntimeKey(name, apiKey);
    this.buildProviders();
    this.failures.clear();
    this.cachedHealth = null;
    this.log.info(`Runtime API key configured for ${name}`);
  }

  clearProvider(name: ProviderName): void {
    clearRuntimeKey(name);
    this.buildProviders();
    this.failures.clear();
    this.cachedHealth = null;
    this.log.info(`Runtime API key cleared for ${name}`);
  }

  isConfigured(name: ProviderName): boolean {
    return this.providers.get(name)?.isConfigured() ?? false;
  }

  get activeProviderName(): ProviderName | "none" {
    return this.candidates()[0]?.name ?? "none";
  }

  get noProviderMessage(): string {
    const configured = this.configuredProviders();
    if (configured.length === 0) {
      return `No AI providers configured. Add GEMINI_API_KEY to your .env file (get one at https://aistudio.google.com/app/apikey), or start Ollama locally at ${this.config.ollamaBaseUrl} with a fast model (e.g. "ollama pull gemma3:4b").`;
    }
    return `AI providers are configured but all failed. Check the server logs for details, or start Ollama at ${this.config.ollamaBaseUrl}.`;
  }

  private isInCooldown(name: ProviderName): boolean {
    const failure = this.failures.get(name);
    return Boolean(failure && failure.until > Date.now());
  }

  private markFailure(name: ProviderName, error: AIError): void {
    const ttl =
      error.code === "AUTH_FAILED" || error.code === "QUOTA_EXCEEDED"
        ? 5 * 60_000
        : 30_000;
    this.failures.set(name, { until: Date.now() + ttl, code: error.code });
  }

  private markSuccess(name: ProviderName): void {
    this.failures.delete(name);
  }

  private configuredProviders(): AIProvider[] {
    return PROVIDER_PRIORITY.map((name) => this.providers.get(name)!).filter(
      (provider) => provider.isConfigured()
    );
  }

  private candidates(): AIProvider[] {
    return this.configuredProviders().filter(
      (provider) => !this.isInCooldown(provider.name)
    );
  }

  /**
   * AI Router: order candidates by role. Local Ollama is always tried first
   * for both reasoning and vision routes (see roleModelName); cloud providers
   * act as graceful fallbacks when Ollama is unavailable.
   */
  private orderedCandidates(role: ModelRole, visionOnly: boolean): AIProvider[] {
    const active = this.candidates().filter(
      (provider) => !visionOnly || provider.supportsVision()
    );
    const ollama = active.find((provider) => provider.name === "ollama");
    const rest = active.filter((provider) => provider.name !== "ollama");
    return ollama ? [ollama, ...rest] : rest;
  }

  private routeOptions<T extends { model?: string }>(
    provider: AIProvider,
    options: T,
    role: ModelRole
  ): T {
    if (provider.name !== "ollama") return options;
    const hint = roleModelName(this.config, role);
    if (!hint) return options;
    return { ...options, model: hint };
  }

  private withSystemContext(options: GenerateTextOptions): GenerateTextOptions {
    const messages: AIMessageInput[] = options.messages.some(
      (m) => m.role === "system"
    )
      ? options.messages
      : [
          { role: "system", content: DEFAULT_SYSTEM_PROMPT },
          ...options.messages,
        ];
    return { ...options, messages: trimContextWindow(messages) };
  }

  private async withMemoryContext<T extends { messages?: AIMessageInput[] }>(
    options: T
  ): Promise<T> {
    const context = await memoryService.buildContext();
    if (!context) return options;
    const messages = appendMemoryContext(options.messages ?? [], context);
    return { ...options, messages };
  }

  private async withMemoryPrompt(request: VisionRequest): Promise<VisionRequest> {
    const context = await memoryService.buildContext();
    if (!context) return request;
    const prompt =
      request.prompt?.trim() ||
      "Describe what you see in this image in detail.";
    return { ...request, prompt: `${context}\n\n${prompt}` };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const requestOptions = await this.withMemoryContext(
      this.withSystemContext(options)
    );
    const candidates = this.orderedCandidates("reasoning", false);
    if (candidates.length === 0) {
      throw new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      const routed = this.routeOptions(provider, requestOptions, "reasoning");
      const model = provider.getModel() ?? routed.model;
      const kind: MetricKind = routed.tools?.length ? "tools" : "text";
      const attempt = this.beginAttempt(kind, provider.name, model);
      this.log.info(`Selecting provider: ${provider.name}`, {
        requestId,
        model,
      });
      try {
        const text =
          routed.tools?.length && typeof provider.generateWithTools === "function"
            ? await this.runToolLoop(provider, routed)
            : await provider.generateText(routed);
        this.markSuccess(provider.name);
        this.endAttempt(attempt.id, attempt.startedAt, "ok", {
          chars: text.length,
        });
        this.log.info(`Provider responded: ${provider.name}`, {
          requestId,
          chars: text.length,
        });
        return text;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        if (isAbortError(mapped)) {
          this.endAttempt(attempt.id, attempt.startedAt, "aborted", {
            errorCode: mapped.code,
            message: mapped.message,
          });
          this.log.info(`${provider.name} request aborted`, { requestId });
          throw mapped;
        }
        lastError = mapped;
        this.markFailure(provider.name, mapped);
        this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
          errorCode: mapped.code,
          message: mapped.message,
        });
        this.log.warn(
          `${provider.name} unavailable: ${mapped.message}`,
          { requestId, code: mapped.code }
        );
      }
    }

    this.log.error("All providers failed", { lastError: lastError?.message });
    throw lastError ?? new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
  }

  async *streamText(options: GenerateTextOptions): AsyncGenerator<string> {
    const requestOptions = await this.withMemoryContext(
      this.withSystemContext(options)
    );
    const candidates = this.orderedCandidates("reasoning", false);
    if (candidates.length === 0) {
      throw new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }

    if (options.tools?.length) {
      let lastError: AIError | null = null;
      for (const provider of candidates) {
        if (typeof provider.generateWithTools !== "function") continue;
        const attempt = this.beginAttempt(
          "tools",
          provider.name,
          provider.getModel() ?? requestOptions.model
        );
        try {
          const text = await this.runToolLoop(provider, requestOptions);
          this.markSuccess(provider.name);
          this.endAttempt(attempt.id, attempt.startedAt, "ok", {
            chars: text.length,
          });
          if (text) yield text;
          return;
        } catch (error) {
          const mapped = toAIError(error, provider.name);
          if (isAbortError(mapped)) {
            this.endAttempt(attempt.id, attempt.startedAt, "aborted", {
              errorCode: mapped.code,
              message: mapped.message,
            });
            throw mapped;
          }
          lastError = mapped;
          this.markFailure(provider.name, mapped);
          this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
            errorCode: mapped.code,
            message: mapped.message,
          });
          this.log.warn(
            `${provider.name} tool streaming unavailable: ${mapped.message}`,
            { code: mapped.code }
          );
        }
      }
      this.log.error("All tool-enabled providers failed", {
        lastError: lastError?.message,
      });
      throw lastError ?? new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      const routed = this.routeOptions(provider, requestOptions, "reasoning");
      this.log.info(`Selecting streaming provider: ${provider.name}`, {
        requestId,
        model: provider.getModel() ?? routed.model,
      });
      try {
        const stream = this.trackedStream(
          "stream",
          provider.name,
          provider.getModel() ?? routed.model,
          provider.streamText(routed)
        );
        const first = await stream.next();
        if (first.done) {
          this.markSuccess(provider.name);
          return;
        }
        yield first.value;
        this.markSuccess(provider.name);
        yield* stream;
        return;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        if (isAbortError(mapped)) {
          this.log.info(`${provider.name} streaming aborted`, { requestId });
          throw mapped;
        }
        lastError = mapped;
        this.markFailure(provider.name, mapped);
        this.log.warn(
          `${provider.name} streaming unavailable: ${mapped.message}`,
          { requestId, code: mapped.code }
        );
      }
    }

    this.log.error("All streaming providers failed", {
      lastError: lastError?.message,
    });
    throw lastError ?? new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
  }

  /**
   * Analyze a camera frame for the chat pipeline. Gemma 3 (via Ollama) is the
   * ONLY model allowed to analyze camera frames; there is deliberately no cloud
   * fallback, so an unavailable Gemma 3 never gets replaced by a model that
   * could hallucinate visual details.
   */
  async analyzeCameraFrame(request: VisionRequest): Promise<string> {
    const ollama = this.providers.get("ollama");
    if (!ollama) {
      throw new AIError(
        "Ollama (Gemma 3) is required to analyze camera frames but is not available.",
        "NO_PROVIDER",
        "ollama"
      );
    }
    const gemma3Model = await (ollama as OllamaProvider).resolveGemma3Model();
    if (!gemma3Model) {
      throw new AIError(
        "Gemma 3 is not installed on Ollama. Run \"ollama pull gemma3:4b\" so camera frames can be analyzed.",
        "MODEL_UNAVAILABLE",
        "ollama"
      );
    }
    const requestId = randomUUID();
    const attempt = this.beginAttempt("camera-frame", "ollama", gemma3Model);
    this.log.info("Selecting frame analysis provider: Gemma 3 (ollama)", {
      requestId,
      model: gemma3Model,
    });
    try {
      const text = await ollama.generateVision({ ...request, model: gemma3Model });
      this.markSuccess("ollama");
      this.endAttempt(attempt.id, attempt.startedAt, "ok", {
        chars: text.length,
        stages: {
          frameBytes: Math.round(request.imageBase64.length * 0.75),
          llmMs: Date.now() - attempt.startedAt,
        },
      });
      this.log.info("Gemma 3 frame analysis finished", {
        requestId,
        model: gemma3Model,
        chars: text.length,
      });
      return text;
    } catch (error) {
      const mapped = toAIError(error, "ollama");
      if (isAbortError(mapped)) {
        this.endAttempt(attempt.id, attempt.startedAt, "aborted", {
          errorCode: mapped.code,
          message: mapped.message,
        });
        this.log.info("Gemma 3 frame analysis aborted (superseded or cancelled)", {
          requestId,
          model: gemma3Model,
        });
        throw mapped;
      }
      this.markFailure("ollama", mapped);
      this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
        errorCode: mapped.code,
        message: mapped.message,
      });
      this.log.error("✕ Gemma 3 frame analysis failed", {
        requestId,
        model: gemma3Model,
        code: mapped.code,
        message: mapped.message,
        status: mapped.status ?? null,
      });
      throw mapped;
    }
  }

  async generateVision(
    request: VisionRequest,
    options: { trackFailures?: boolean; includeMemory?: boolean } = {}
  ): Promise<string> {
    const trackFailures = options.trackFailures ?? true;
    const requestWithMemory =
      options.includeMemory === false
        ? request
        : await this.withMemoryPrompt(request);
    const candidates = this.orderedCandidates("vision", true);
    if (candidates.length === 0) {
      throw new AIError(
        "No AI provider with vision support is available. Configure Gemini or run a multimodal Ollama model.",
        "NO_PROVIDER",
        "unknown"
      );
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      const routed = this.routeOptions(provider, requestWithMemory, "vision");
      const attempt = this.beginAttempt(
        "vision",
        provider.name,
        provider.getModel() ?? routed.model
      );
      this.log.info(`Selecting vision provider: ${provider.name}`, {
        requestId,
        model: provider.getModel() ?? routed.model,
      });
      try {
        const text = await provider.generateVision(routed);
        if (trackFailures) {
          this.markSuccess(provider.name);
        }
        this.endAttempt(attempt.id, attempt.startedAt, "ok", {
          chars: text.length,
        });
        this.log.info(`Vision provider responded: ${provider.name}`, {
          requestId,
        });
        return text;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        lastError = mapped;
        if (trackFailures) {
          this.markFailure(provider.name, mapped);
        }
        this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
          errorCode: mapped.code,
          message: mapped.message,
        });
        this.log.warn(
          `${provider.name} vision unavailable: ${mapped.message}`,
          { requestId, code: mapped.code }
        );
      }
    }

    throw lastError ?? new AIError("No vision-capable AI provider is available.", "NO_PROVIDER", "unknown");
  }

  async generateVisionChat(
    request: VisionChatRequest,
    options: { trackFailures?: boolean } = {}
  ): Promise<string> {
    const trackFailures = options.trackFailures ?? false;
    const requestWithMemory = await this.withMemoryContext(request);
    const candidates = this.orderedCandidates("vision", true).filter(
      (provider) => typeof provider.generateVisionChat === "function"
    );
    if (candidates.length === 0) {
      throw new AIError(
        "No AI provider with multimodal vision support is available.",
        "NO_PROVIDER",
        "unknown"
      );
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      const routed = this.routeOptions(provider, requestWithMemory, "vision");
      const attempt = this.beginAttempt(
        "vision-chat",
        provider.name,
        provider.getModel() ?? routed.model
      );
      this.log.info(`Selecting vision-chat provider: ${provider.name}`, {
        requestId,
        model: provider.getModel() ?? routed.model,
      });
      try {
        const text = await provider.generateVisionChat!(routed);
        if (trackFailures) {
          this.markSuccess(provider.name);
        }
        this.endAttempt(attempt.id, attempt.startedAt, "ok", {
          chars: text.length,
        });
        this.log.info(`Vision-chat provider responded: ${provider.name}`, {
          requestId,
          chars: text.length,
        });
        return text;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        if (isAbortError(mapped)) {
          this.endAttempt(attempt.id, attempt.startedAt, "aborted", {
            errorCode: mapped.code,
            message: mapped.message,
          });
          this.log.info(`${provider.name} vision-chat request aborted`, {
            requestId,
          });
          throw mapped;
        }
        lastError = mapped;
        if (trackFailures) {
          this.markFailure(provider.name, mapped);
        }
        this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
          errorCode: mapped.code,
          message: mapped.message,
        });
        this.log.warn(
          `${provider.name} vision-chat unavailable: ${mapped.message}`,
          { requestId, code: mapped.code }
        );
      }
    }

    throw (
      lastError ??
      new AIError("No multimodal AI provider is available.", "NO_PROVIDER", "unknown")
    );
  }

  async *streamVisionChat(
    request: VisionChatRequest,
    options: { trackFailures?: boolean } = {}
  ): AsyncGenerator<string> {
    const trackFailures = options.trackFailures ?? false;
    const requestWithMemory = await this.withMemoryContext(request);
    const candidates = this.orderedCandidates("vision", true).filter(
      (provider) => typeof provider.streamVisionChat === "function"
    );
    if (candidates.length === 0) {
      throw new AIError(
        "No AI provider with multimodal vision support is available.",
        "NO_PROVIDER",
        "unknown"
      );
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      const routed = this.routeOptions(provider, requestWithMemory, "vision");
      this.log.info(`Selecting streaming vision provider: ${provider.name}`, {
        requestId,
        model: provider.getModel() ?? routed.model,
      });
      try {
        const stream = this.trackedStream(
          "vision-chat",
          provider.name,
          provider.getModel() ?? routed.model,
          provider.streamVisionChat!(routed)
        );
        const first = await stream.next();
        if (first.done) {
          if (trackFailures) {
            this.markSuccess(provider.name);
          }
          return;
        }
        yield first.value;
        if (trackFailures) {
          this.markSuccess(provider.name);
        }
        yield* stream;
        return;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        if (isAbortError(mapped)) {
          this.log.info(`${provider.name} vision streaming aborted`, {
            requestId,
          });
          throw mapped;
        }
        lastError = mapped;
        if (trackFailures) {
          this.markFailure(provider.name, mapped);
        }
        this.log.warn(
          `${provider.name} vision streaming unavailable: ${mapped.message}`,
          { requestId, code: mapped.code }
        );
      }
    }

    throw (
      lastError ??
      new AIError("No multimodal AI provider is available.", "NO_PROVIDER", "unknown")
    );
  }

  /**
   * Agent orchestration: when the caller requests tool calling, run a bounded
   * loop that hands the model's tool calls to the local tool registry and feeds
   * the results back until the model produces a final text response or the
   * iteration budget is exhausted. Only engaged when `options.tools` is set,
   * so the default chat/vision paths are untouched.
   */
  private async runToolLoop(
    provider: AIProvider,
    options: GenerateTextOptions
  ): Promise<string> {
    const maxIterations =
      options.maxToolIterations ?? this.config.maxToolIterations;
    const generateWithTools = provider.generateWithTools;
    if (!generateWithTools) return provider.generateText(options);

    let messages = options.messages;
    let routed = { ...options, messages };
    let lastContent = "";

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const { content, toolCalls } = await generateWithTools.call(provider, routed);
      lastContent = content;
      if (toolCalls.length === 0) {
        this.log.info("Tool orchestration finished", {
          provider: provider.name,
          iterations: iteration + 1,
        });
        return content;
      }

      const next: AIMessageInput[] = [...messages];
      next.push({ role: "assistant", content: content || "" });
      initToolRouter();
      for (const call of toolCalls) {
        const result = await executeTool(call.name, call.arguments);
        const output = result.ok
          ? JSON.stringify(result.data)
          : JSON.stringify({ error: result.error.message });
        next.push({ role: "tool", content: output, name: call.name });
      }
      messages = next;
      routed = { ...options, messages };
      this.log.info("Tool orchestration iteration", {
        provider: provider.name,
        iteration: iteration + 1,
        toolCalls: toolCalls.map((call) => call.name),
        remaining: maxIterations - iteration - 1,
      });
    }

    this.log.warn("Tool orchestration reached iteration budget", {
      provider: provider.name,
      maxIterations,
    });
    return lastContent || "Tool orchestration completed without a final response.";
  }

  async healthCheck(options: { force?: boolean } = {}): Promise<HealthSummary> {
    if (
      !options.force &&
      this.cachedHealth &&
      Date.now() - this.cachedHealth.timestamp < HEALTH_CACHE_MS
    ) {
      return this.cachedHealth;
    }

    this.log.info("Running provider health check...");

    const entries = await Promise.all(
      PROVIDER_PRIORITY.map(async (name) => {
        const provider = this.providers.get(name)!;
        const attempt = this.beginAttempt("health", name, provider.getModel());
        try {
          const detail = await provider.healthCheck();
          this.endAttempt(attempt.id, attempt.startedAt, "ok", {
            ttfbMs: detail.latencyMs,
          });
          return detail;
        } catch (error) {
          const mapped = toAIError(error, name);
          this.endAttempt(attempt.id, attempt.startedAt, AIProviderService.statusFor(mapped), {
            errorCode: mapped.code,
            message: mapped.message,
          });
          return {
            provider: name,
            status: "error",
            configured: provider.isConfigured(),
            model: provider.getModel(),
            error: mapped.message,
            latencyMs: null,
            vision: false,
          } as ProviderStatusDetail;
        }
      })
    );

    const byName = Object.fromEntries(
      entries.map((entry) => [entry.provider, entry])
    ) as Record<ProviderName, ProviderStatusDetail>;

    const connected = entries.filter((entry) => entry.status === "connected");
    const configuredEntries = entries.filter((entry) => entry.configured);
    const anyError = configuredEntries.some((entry) => entry.status === "error");
    const status =
      connected.length === 0
        ? "offline"
        : anyError
          ? "degraded"
          : "online";
    const firstConnected = connected[0] ?? null;

    const ollamaConnected = byName.ollama.status === "connected";
    const cloudConnected = connected.filter(
      (entry) => entry.provider !== "ollama"
    );
    const cloudProvider = cloudConnected[0]?.provider ?? null;
    const cloudModel = cloudConnected[0]?.model ?? null;

    const [whisper, piper] = await Promise.all([
      detectWhisper(this.config),
      detectPiper(this.config),
    ]);
    const stt = resolveSttEngine(this.config, whisper);
    const tts = resolveTtsEngine(this.config, piper);
    const capabilities = describeRoles(
      this.config,
      ollamaConnected,
      byName.ollama.model,
      byName.ollama.vision,
      byName.ollama.visionModel ?? null,
      cloudProvider,
      cloudModel,
      stt,
      tts
    );

    const activeProvider = capabilities.reasoning.provider ?? "none";

    const health: HealthSummary = {
      provider: activeProvider,
      status,
      activeModel: capabilities.reasoning.model ?? firstConnected?.model ?? null,
      gemini: byName.gemini,
      openai: byName.openai,
      anthropic: byName.anthropic,
      ollama: byName.ollama,
      capabilities,
      version: APP_VERSION,
      timestamp: Date.now(),
    };

    this.log.info(
      `Health check complete: ${status} (reasoning: ${capabilities.reasoning.provider}/${capabilities.reasoning.model ?? "none"}, vision: ${capabilities.vision.provider}/${capabilities.vision.model ?? "none"}, stt: ${stt.engine}, tts: ${tts.engine})`
    );
    this.cachedHealth = health;
    return health;
  }

  async listModels(): Promise<{ provider: ProviderName; models: string[] }> {
    const active = this.orderedCandidates("reasoning", false)[0];
    if (!active) {
      throw new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }
    const models = await active.listModels();
    this.log.info(`Listed models from ${active.name}`, { count: models.length });
    return { provider: active.name, models };
  }
}

export const aiService = new AIProviderService();
