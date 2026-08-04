import type { EnvConfig, SttMode, TtsMode } from "./config";
import type { ProviderName } from "./types";

export type ModelRole = "reasoning" | "vision";

export interface RouterModelInfo {
  provider: ProviderName | null;
  model: string | null;
}

export interface RouterSttInfo {
  mode: SttMode;
  engine: "whisper" | "deepgram" | "browser" | "none";
  enabled: boolean;
}

export interface RouterTtsInfo {
  mode: TtsMode;
  engine: "piper" | "browser" | "none";
  enabled: boolean;
}

export interface RouterCapabilities {
  reasoning: RouterModelInfo;
  vision: RouterModelInfo;
  stt: RouterSttInfo;
  tts: RouterTtsInfo;
}

export const VISION_KEYWORDS = [
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

export const REASONING_KEYWORDS = ["qwen3", "qwen2.5", "qwen2", "llama3", "gemma3", "mistral", "deepseek"];

export function isVisionModel(name: string): boolean {
  const lower = name.toLowerCase();
  return VISION_KEYWORDS.some((keyword) => lower.includes(keyword));
}

export function isReasoningModel(name: string): boolean {
  const lower = name.toLowerCase();
  return REASONING_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * Resolve the Ollama model name that should handle a given role.
 * Returns null when the router should auto-detect from installed models
 * (used for vision when GEMMA3_MODEL is not explicitly set).
 */
export function roleModelName(config: EnvConfig, role: ModelRole): string | null {
  if (role === "reasoning") {
    return config.qwen3Model;
  }
  return config.gemma3Model;
}

export function pickLocalVisionModel(availableModels: string[]): string | null {
  return (
    availableModels.find((name) => isVisionModel(name)) ??
    availableModels.find((name) => isReasoningModel(name)) ??
    null
  );
}

function resolveGemma3Model(
  config: EnvConfig,
  ollamaVisionModel: string | null
): string | null {
  const configured = config.gemma3Model;
  if (configured && configured.toLowerCase().includes("gemma3")) {
    return configured;
  }
  if (ollamaVisionModel && ollamaVisionModel.toLowerCase().includes("gemma3")) {
    return ollamaVisionModel;
  }
  return null;
}

export function describeRoles(
  config: EnvConfig,
  ollamaConnected: boolean,
  ollamaModel: string | null,
  ollamaHasVision: boolean,
  ollamaVisionModel: string | null,
  cloudProvider: ProviderName | null,
  cloudModel: string | null,
  stt: RouterSttInfo,
  tts: RouterTtsInfo
): RouterCapabilities {
  const gemma3Model = resolveGemma3Model(config, ollamaVisionModel);
  const visionHandledByGemma3 =
    ollamaConnected && ollamaHasVision && gemma3Model !== null;
  return {
    reasoning: {
      provider: ollamaConnected ? "ollama" : cloudProvider,
      model: ollamaConnected ? roleModelName(config, "reasoning") : cloudModel,
    },
    vision: {
      provider: visionHandledByGemma3 ? "ollama" : null,
      model: visionHandledByGemma3 ? gemma3Model : null,
    },
    stt,
    tts,
  };
}
