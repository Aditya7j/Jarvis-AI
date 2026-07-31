import type { ProviderName } from "./types";

export type AIErrorCode =
  | "NO_PROVIDER"
  | "AUTH_FAILED"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "MODEL_UNAVAILABLE"
  | "CONNECTION_TIMEOUT"
  | "CONNECTION_FAILED"
  | "INVALID_REQUEST"
  | "REQUEST_ABORTED"
  | "PROVIDER_ERROR";

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly provider: ProviderName | "unknown";
  readonly status?: number;

  constructor(
    message: string,
    code: AIErrorCode,
    provider: ProviderName | "unknown" = "unknown",
    status?: number
  ) {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.provider = provider;
    this.status = status;
  }
}

export interface ErrorPayload {
  code: AIErrorCode;
  message: string;
  provider: ProviderName | "unknown";
  status?: number;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof AIError) {
    return {
      code: error.code,
      message: error.message,
      provider: error.provider,
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return { code: "PROVIDER_ERROR", message: error.message, provider: "unknown" };
  }
  return { code: "PROVIDER_ERROR", message: "Unknown AI error", provider: "unknown" };
}

export function toAIError(error: unknown, provider: ProviderName): AIError {
  if (error instanceof AIError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AIError(message, "PROVIDER_ERROR", provider);
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AIError && error.code === "REQUEST_ABORTED") return true;
  const name =
    (error as { name?: unknown } | null | undefined)?.name ?? "";
  const message = messageOf(error);
  return name === "AbortError" || message.includes("abort");
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null | undefined)?.status;
}

function messageOf(error: unknown): string {
  const message =
    (error as { message?: unknown } | null | undefined)?.message ?? String(error);
  return typeof message === "string" ? message.toLowerCase() : String(error).toLowerCase();
}

export function mapGeminiError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const status = statusOf(error);
  const message = messageOf(error);

  if (status === 401 || status === 403 || message.includes("api key not valid") || message.includes("invalid api key") || message.includes("permission denied") || message.includes("forbidden")) {
    return new AIError("Gemini authentication failed. Check that GEMINI_API_KEY is a valid key from https://aistudio.google.com/app/apikey.", "AUTH_FAILED", "gemini", status);
  }
  if (status === 404 || message.includes("not found")) {
    return new AIError("Gemini model unavailable. Set GEMINI_MODEL to a model that exists, e.g. gemini-2.0-flash.", "MODEL_UNAVAILABLE", "gemini", status);
  }
  if (status === 429 || message.includes("quota") || message.includes("resource exhausted") || message.includes("rate limit") || message.includes("429")) {
    return new AIError("Gemini quota exceeded. The free tier is exhausted — wait a while or create a new key.", "QUOTA_EXCEEDED", "gemini", status);
  }
  if (message.includes("abort") || message.includes("timeout")) {
    return new AIError("Gemini connection timed out.", "CONNECTION_TIMEOUT", "gemini");
  }
  if (message.includes("fetch failed") || message.includes("econnrefused") || message.includes("enotfound") || message.includes("network") || message.includes("socket")) {
    return new AIError("Gemini connection failed — check network access.", "CONNECTION_FAILED", "gemini");
  }
  return new AIError(`Gemini error: ${message}`, "PROVIDER_ERROR", "gemini", status);
}

export function mapOpenAIError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const status = statusOf(error);
  const message = messageOf(error);

  if (status === 401 || message.includes("incorrect api key") || message.includes("invalid api key") || message.includes("authentication")) {
    return new AIError("OpenAI authentication failed. Check that OPENAI_API_KEY is valid.", "AUTH_FAILED", "openai", status);
  }
  if (message.includes("insufficient_quota") || message.includes("quota")) {
    return new AIError("OpenAI quota exceeded.", "QUOTA_EXCEEDED", "openai", status);
  }
  if (status === 404 || message.includes("model") || message.includes("does not exist") || message.includes("not found")) {
    return new AIError("OpenAI model unavailable. Set OPENAI_MODEL to an existing model.", "MODEL_UNAVAILABLE", "openai", status);
  }
  if (status === 429 || message.includes("rate limit") || message.includes("429")) {
    return new AIError("OpenAI rate limited. Try again shortly.", "RATE_LIMITED", "openai", status);
  }
  if (message.includes("timeout") || message.includes("abort") || message.includes("fetch failed") || message.includes("econnrefused") || message.includes("enotfound") || message.includes("socket")) {
    return new AIError("OpenAI connection timed out.", "CONNECTION_TIMEOUT", "openai");
  }
  return new AIError(`OpenAI error: ${message}`, "PROVIDER_ERROR", "openai", status);
}

export function mapAnthropicError(error: unknown): AIError {
  if (error instanceof AIError) return error;
  const status = statusOf(error);
  const message = messageOf(error);

  if (message.includes("authentication_error") || status === 401) {
    return new AIError("Anthropic authentication failed. Check that ANTHROPIC_API_KEY is valid.", "AUTH_FAILED", "anthropic", status);
  }
  if (message.includes("permission_error") || status === 403) {
    return new AIError("Anthropic permission denied.", "AUTH_FAILED", "anthropic", status);
  }
  if (message.includes("not_found_error") || status === 404) {
    return new AIError("Anthropic model unavailable. Set ANTHROPIC_MODEL to an existing model.", "MODEL_UNAVAILABLE", "anthropic", status);
  }
  if (message.includes("rate_limit_error") || message.includes("overloaded_error") || status === 429) {
    return new AIError("Anthropic rate limited or overloaded. Try again shortly.", "RATE_LIMITED", "anthropic", status);
  }
  if (message.includes("timeout") || message.includes("abort") || message.includes("fetch failed") || message.includes("econnrefused") || message.includes("enotfound") || message.includes("socket")) {
    return new AIError("Anthropic connection timed out.", "CONNECTION_TIMEOUT", "anthropic");
  }
  return new AIError(`Anthropic error: ${message}`, "PROVIDER_ERROR", "anthropic", status);
}
