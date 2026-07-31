import { aiLogger } from "./logger";

export interface EnvConfig {
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  ollamaBaseUrl: string;
  geminiModel: string;
  openaiModel: string;
  anthropicModel: string;
  ollamaModel: string | null;
  requestTimeoutMs: number;
  healthTimeoutMs: number;
}

function env(key: string): string | null {
  const value = process.env[key];
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTimeout(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    aiLogger.warn(`Invalid ${key} "${raw}" — using ${fallback}ms`);
    return fallback;
  }
  return parsed;
}

export function loadEnvConfig(): EnvConfig {
  const geminiApiKey = env("GEMINI_API_KEY");
  const openaiApiKey = env("OPENAI_API_KEY");
  const anthropicApiKey = env("ANTHROPIC_API_KEY");
  const ollamaBaseUrl = env("OLLAMA_BASE_URL") ?? "http://localhost:11434";

  const config: EnvConfig = {
    geminiApiKey,
    openaiApiKey,
    anthropicApiKey,
    ollamaBaseUrl,
    geminiModel: env("GEMINI_MODEL") ?? "gemini-2.0-flash",
    openaiModel: env("OPENAI_MODEL") ?? "gpt-4o-mini",
    anthropicModel: env("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest",
    ollamaModel: env("OLLAMA_MODEL") ?? null,
    requestTimeoutMs: readTimeout("AI_REQUEST_TIMEOUT_MS", 60_000),
    healthTimeoutMs: readTimeout("AI_HEALTH_TIMEOUT_MS", 10_000),
  };

  if (geminiApiKey) {
    aiLogger.info("GEMINI_API_KEY detected", { model: config.geminiModel });
  } else {
    aiLogger.warn("GEMINI_API_KEY missing — Gemini unavailable");
  }
  if (openaiApiKey) {
    aiLogger.info("OPENAI_API_KEY detected");
  } else {
    aiLogger.warn("OPENAI_API_KEY missing — OpenAI unavailable");
  }
  if (anthropicApiKey) {
    aiLogger.info("ANTHROPIC_API_KEY detected");
  } else {
    aiLogger.warn("ANTHROPIC_API_KEY missing — Anthropic unavailable");
  }
  aiLogger.info(`Ollama base URL: ${ollamaBaseUrl}`, {
    model: config.ollamaModel ?? "auto-detect",
  });
  aiLogger.info("Provider priority: gemini → ollama → openai → anthropic");

  return config;
}
