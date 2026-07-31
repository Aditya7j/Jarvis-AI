export type ProviderName = "gemini" | "openai" | "anthropic" | "ollama";

export type ChatRole = "system" | "user" | "assistant";

export interface AIMessageInput {
  role: ChatRole;
  content: string;
}

export interface ToolCall {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GenerateTextOptions {
  messages: AIMessageInput[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolCall[];
  signal?: AbortSignal;
}

export interface VisionRequest {
  imageBase64: string;
  mimeType?: string;
  prompt?: string;
}

export interface VisionImage {
  data: string;
  mimeType?: string;
  source?: "webcam" | "screen";
}

export interface VisionChatRequest {
  messages: AIMessageInput[];
  images: VisionImage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export type ProviderStatusType =
  | "connected"
  | "not_configured"
  | "not_running"
  | "error";

export interface ProviderStatusDetail {
  provider: ProviderName;
  status: ProviderStatusType;
  configured: boolean;
  model: string | null;
  error: string | null;
  latencyMs: number | null;
  vision: boolean;
}

export interface HealthSummary {
  provider: ProviderName | "none";
  status: "online" | "degraded" | "offline";
  activeModel: string | null;
  gemini: ProviderStatusDetail;
  openai: ProviderStatusDetail;
  anthropic: ProviderStatusDetail;
  ollama: ProviderStatusDetail;
  version: string;
  timestamp: number;
}
