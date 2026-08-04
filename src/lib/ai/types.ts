import type { RouterCapabilities } from "./router";

export type ProviderName = "gemini" | "openai" | "anthropic" | "ollama";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface AIMessageInput {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface ToolCall {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolCallInvocation {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResponse {
  content: string;
  toolCalls: ToolCallInvocation[];
}

export interface GenerateTextOptions {
  messages: AIMessageInput[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolCall[];
  maxToolIterations?: number;
  signal?: AbortSignal;
}

export interface VisionRequest {
  imageBase64: string;
  mimeType?: string;
  prompt?: string;
  model?: string;
  signal?: AbortSignal;
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
  visionModel?: string | null;
}

export interface HealthSummary {
  provider: ProviderName | "none";
  status: "online" | "degraded" | "offline";
  activeModel: string | null;
  gemini: ProviderStatusDetail;
  openai: ProviderStatusDetail;
  anthropic: ProviderStatusDetail;
  ollama: ProviderStatusDetail;
  capabilities: RouterCapabilities;
  version: string;
  timestamp: number;
}
