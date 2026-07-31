import { randomUUID } from "crypto";
import { loadEnvConfig, type EnvConfig } from "./config";
import { AIError, isAbortError, toAIError } from "./errors";
import { aiLogger } from "./logger";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts";
import { clearRuntimeKey, getRuntimeKey, setRuntimeKey } from "./registry";
import { AnthropicProvider } from "./providers/anthropic";
import { GeminiProvider } from "./providers/gemini";
import { OllamaProvider } from "./providers/ollama";
import { OpenAIProvider } from "./providers/openai";
import type { AIProvider } from "./providers/types";
import { APP_VERSION } from "./version";
import type {
  GenerateTextOptions,
  HealthSummary,
  ProviderName,
  ProviderStatusDetail,
  VisionChatRequest,
  VisionRequest,
} from "./types";

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
      return `No AI providers configured. Add GEMINI_API_KEY to your .env file (get one at https://aistudio.google.com/app/apikey), or start Ollama locally at ${this.config.ollamaBaseUrl}.`;
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

  private withSystemContext(options: GenerateTextOptions): GenerateTextOptions {
    if (options.messages.some((m) => m.role === "system")) return options;
    return {
      ...options,
      messages: [
        { role: "system", content: DEFAULT_SYSTEM_PROMPT },
        ...options.messages,
      ],
    };
  }

  async generateText(options: GenerateTextOptions): Promise<string> {
    const requestOptions = this.withSystemContext(options);
    const candidates = this.candidates();
    if (candidates.length === 0) {
      throw new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      this.log.info(`Selecting provider: ${provider.name}`, {
        requestId,
        model: provider.getModel(),
      });
      try {
        const text = await provider.generateText(requestOptions);
        this.markSuccess(provider.name);
        this.log.info(`Provider responded: ${provider.name}`, {
          requestId,
          chars: text.length,
        });
        return text;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        if (isAbortError(mapped)) {
          this.log.info(`${provider.name} request aborted`, { requestId });
          throw mapped;
        }
        lastError = mapped;
        this.markFailure(provider.name, mapped);
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
    const requestOptions = this.withSystemContext(options);
    const candidates = this.candidates();
    if (candidates.length === 0) {
      throw new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }

    let lastError: AIError | null = null;
    for (const provider of candidates) {
      const requestId = randomUUID();
      this.log.info(`Selecting streaming provider: ${provider.name}`, {
        requestId,
        model: provider.getModel(),
      });
      try {
        const stream = provider.streamText(requestOptions);
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

  async generateVision(
    request: VisionRequest,
    options: { trackFailures?: boolean } = {}
  ): Promise<string> {
    const trackFailures = options.trackFailures ?? true;
    const candidates = this.candidates().filter((provider) =>
      provider.supportsVision()
    );
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
      this.log.info(`Selecting vision provider: ${provider.name}`, {
        requestId,
        model: provider.getModel(),
      });
      try {
        const text = await provider.generateVision(request);
        if (trackFailures) {
          this.markSuccess(provider.name);
        }
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
        this.log.warn(
          `${provider.name} vision unavailable: ${mapped.message}`,
          { requestId, code: mapped.code }
        );
      }
    }

    throw lastError ?? new AIError("No vision-capable AI provider is available.", "NO_PROVIDER", "unknown");
  }

  hasVisionProvider(): boolean {
    return this.candidates().some(
      (provider) =>
        provider.supportsVision() &&
        typeof provider.generateVisionChat === "function"
    );
  }

  async generateVisionChat(
    request: VisionChatRequest,
    options: { trackFailures?: boolean } = {}
  ): Promise<string> {
    const trackFailures = options.trackFailures ?? false;
    const candidates = this.candidates().filter(
      (provider) =>
        provider.supportsVision() &&
        typeof provider.generateVisionChat === "function"
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
      this.log.info(`Selecting vision-chat provider: ${provider.name}`, {
        requestId,
        model: provider.getModel(),
      });
      try {
        const text = await provider.generateVisionChat!(request);
        if (trackFailures) {
          this.markSuccess(provider.name);
        }
        this.log.info(`Vision-chat provider responded: ${provider.name}`, {
          requestId,
          chars: text.length,
        });
        return text;
      } catch (error) {
        const mapped = toAIError(error, provider.name);
        if (isAbortError(mapped)) {
          this.log.info(`${provider.name} vision-chat request aborted`, {
            requestId,
          });
          throw mapped;
        }
        lastError = mapped;
        if (trackFailures) {
          this.markFailure(provider.name, mapped);
        }
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
    const candidates = this.candidates().filter(
      (provider) =>
        provider.supportsVision() &&
        typeof provider.streamVisionChat === "function"
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
      this.log.info(`Selecting streaming vision provider: ${provider.name}`, {
        requestId,
        model: provider.getModel(),
      });
      try {
        const stream = provider.streamVisionChat!(request);
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
        try {
          return await provider.healthCheck();
        } catch (error) {
          const mapped = toAIError(error, name);
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

    const health: HealthSummary = {
      provider: firstConnected?.provider ?? "none",
      status,
      activeModel: firstConnected?.model ?? null,
      gemini: byName.gemini,
      openai: byName.openai,
      anthropic: byName.anthropic,
      ollama: byName.ollama,
      version: APP_VERSION,
      timestamp: Date.now(),
    };

    this.log.info(
      `Health check complete: ${status} (active: ${health.provider}, model: ${health.activeModel ?? "none"})`
    );
    this.cachedHealth = health;
    return health;
  }

  async listModels(): Promise<{ provider: ProviderName; models: string[] }> {
    const active = this.configuredProviders()[0];
    if (!active) {
      throw new AIError(this.noProviderMessage, "NO_PROVIDER", "unknown");
    }
    const models = await active.listModels();
    this.log.info(`Listed models from ${active.name}`, { count: models.length });
    return { provider: active.name, models };
  }
}

export const aiService = new AIProviderService();
