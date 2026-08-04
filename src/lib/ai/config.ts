import { aiLogger } from "./logger";

export type SttMode = "auto" | "whisper" | "deepgram" | "browser";
export type TtsMode = "auto" | "piper" | "browser";

export interface EnvConfig {
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  deepgramApiKey: string | null;
  ollamaBaseUrl: string;
  geminiModel: string;
  openaiModel: string;
  anthropicModel: string;
  ollamaModel: string | null;
  qwen3Model: string;
  gemma3Model: string | null;
  requestTimeoutMs: number;
  visionTimeoutMs: number;
  healthTimeoutMs: number;
  maxToolIterations: number;
  sttMode: SttMode;
  whisperEnabled: boolean;
  whisperCommand: string;
  whisperServerUrl: string | null;
  whisperModel: string;
  ttsMode: TtsMode;
  piperEnabled: boolean;
  piperCommand: string;
  piperServerUrl: string | null;
  piperVoice: string;
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

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = env(key);
  if (!raw) return fallback;
  const value = raw.toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

function readInt(key: string, fallback: number): number {
  const raw = env(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    aiLogger.warn(`Invalid ${key} "${raw}" — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function readEnum<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const raw = env(key);
  if (!raw) return fallback;
  const value = raw.toLowerCase() as T;
  if ((allowed as readonly string[]).includes(value)) return value;
  aiLogger.warn(`Invalid ${key} "${raw}" — using "${fallback}"`);
  return fallback;
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
    deepgramApiKey: env("DEEPGRAM_API_KEY"),
    ollamaBaseUrl,
    geminiModel: env("GEMINI_MODEL") ?? "gemini-2.0-flash",
    openaiModel: env("OPENAI_MODEL") ?? "gpt-4o-mini",
    anthropicModel: env("ANTHROPIC_MODEL") ?? "claude-3-5-sonnet-latest",
    ollamaModel: env("OLLAMA_MODEL") ?? null,
    qwen3Model: env("QWEN3_MODEL") ?? env("OLLAMA_MODEL") ?? "qwen3:latest",
    gemma3Model: env("GEMMA3_MODEL") ?? null,
    requestTimeoutMs: readTimeout("AI_REQUEST_TIMEOUT_MS", 60_000),
    visionTimeoutMs: readTimeout("AI_VISION_TIMEOUT_MS", 300_000),
    healthTimeoutMs: readTimeout("AI_HEALTH_TIMEOUT_MS", 10_000),
    maxToolIterations: readInt("AI_MAX_TOOL_ITERATIONS", 4),
    sttMode: readEnum("STT_MODE", ["auto", "whisper", "deepgram", "browser"] as const, "auto"),
    whisperEnabled: readBoolean("WHISPER_ENABLED", true),
    whisperCommand: env("WHISPER_COMMAND") ?? "whisper",
    whisperServerUrl: env("WHISPER_SERVER_URL") ?? null,
    whisperModel: env("WHISPER_MODEL") ?? "base",
    ttsMode: readEnum("TTS_MODE", ["auto", "piper", "browser"] as const, "auto"),
    piperEnabled: readBoolean("PIPER_ENABLED", true),
    piperCommand: env("PIPER_COMMAND") ?? "piper",
    piperServerUrl: env("PIPER_SERVER_URL") ?? null,
    piperVoice: env("PIPER_VOICE") ?? "en_US-lessac-medium",
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
    reasoning: config.qwen3Model,
    vision: config.gemma3Model ?? "auto-detect",
  });
  aiLogger.info(
    `AI Router: ${config.qwen3Model ?? "auto"} (reasoning) → ${config.gemma3Model ?? "auto"} (vision) → cloud fallbacks`
  );
  aiLogger.info(`STT mode: ${config.sttMode}`, {
    whisperEnabled: config.whisperEnabled,
    whisperServerUrl: config.whisperServerUrl ?? "cli",
  });
  aiLogger.info(`TTS mode: ${config.ttsMode}`, {
    piperEnabled: config.piperEnabled,
    piperServerUrl: config.piperServerUrl ?? "cli",
    voice: config.piperVoice,
  });

  return config;
}
