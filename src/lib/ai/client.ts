import type { AIMessage } from "@/types";
import type { HealthSummary, ProviderName } from "./types";
import { getVisionContext } from "@/lib/vision/vision-context";

type ErrorPayload = {
  code?: string;
  message?: string;
  provider?: string;
};

interface SSEFrame {
  token?: string;
  done?: boolean;
  error?: ErrorPayload;
}

function parseSSEFrame(frame: string): SSEFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    const parsed = JSON.parse(raw) as SSEFrame;
    if (event === "error" && parsed.error) return parsed;
    return parsed;
  } catch {
    return null;
  }
}

export class AIClient {
  private static readonly REFRESH_TTL_MS = 15_000;
  private health: HealthSummary | null = null;
  private refreshPromise: Promise<HealthSummary> | null = null;
  private lastRefreshAt = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  get isConfigured(): boolean {
    return (
      this.health?.status === "online" || this.health?.status === "degraded"
    );
  }

  get provider(): ProviderName | "none" {
    return this.health?.provider ?? "none";
  }

  get summary(): HealthSummary | null {
    return this.health;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, init);
    const body = (await res.json().catch(() => null)) as
      | (T & { error?: ErrorPayload })
      | null;
    if (!res.ok || !body) {
      const message =
        body?.error?.message ??
        (body === null ? `Request failed (${res.status})` : `Request failed`);
      throw new Error(message);
    }
    return body;
  }

  async refresh(): Promise<HealthSummary> {
    const now = Date.now();
    if (this.health && now - this.lastRefreshAt < AIClient.REFRESH_TTL_MS) {
      return this.health;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.request<HealthSummary>("/api/health")
        .then((health) => {
          this.health = health;
          this.lastRefreshAt = Date.now();
          this.notify();
          return health;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }

  async testConnection(): Promise<HealthSummary> {
    this.health = await this.request<HealthSummary>("/api/health/test", {
      method: "POST",
    });
    this.lastRefreshAt = Date.now();
    this.notify();
    return this.health;
  }

  async checkOllama(): Promise<boolean> {
    const health = await this.refresh();
    return health.ollama.status === "connected";
  }

  async generateResponse(
    messages: AIMessage[],
    onToken?: (token: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const body: {
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      vision?: {
        frames: Array<{
          image: string;
          mimeType: string;
          source?: "webcam" | "screen";
        }>;
      };
    } = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };

    const visionContext = getVisionContext();
    if (visionContext && visionContext.frames.length > 0) {
      body.vision = {
        frames: visionContext.frames.map((frame) => ({
          image: frame.data,
          mimeType: frame.mimeType || "image/jpeg",
          source: frame.source,
        })),
      };
    }

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: ErrorPayload;
      } | null;
      throw new Error(
        body?.error?.message ?? `AI request failed (${res.status})`
      );
    }

    if (!res.body) {
      throw new Error("Streaming is not supported by this browser.");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    try {
      while (true) {
        if (signal?.aborted) {
          throw new Error("AI request cancelled.");
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const parsed = parseSSEFrame(frame);
          if (!parsed) continue;
          if (parsed.error) {
            throw new Error(parsed.error.message ?? "AI request failed");
          }
          if (parsed.done) return full;
          if (parsed.token) {
            full += parsed.token;
            onToken?.(parsed.token);
          }
        }
      }
      return full;
    } finally {
      reader.releaseLock();
    }
  }

  async analyzeVision(imageBase64: string, prompt?: string): Promise<string> {
    const body = await this.request<{ description: string }>("/api/vision/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64, prompt }),
    });
    return body.description;
  }

  async setApiKey(
    provider: "gemini" | "openai" | "anthropic",
    apiKey: string
  ): Promise<HealthSummary> {
    const body = await this.request<{ health: HealthSummary }>(
      "/api/settings/provider",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey }),
      }
    );
    this.health = body.health;
    this.notify();
    return body.health;
  }

  async clearProvider(
    provider: "gemini" | "openai" | "anthropic"
  ): Promise<HealthSummary> {
    const body = await this.request<{ health: HealthSummary }>(
      "/api/settings/provider",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      }
    );
    this.health = body.health;
    this.notify();
    return body.health;
  }

  async listModels(): Promise<string[]> {
    const body = await this.request<{ models: string[] }>("/api/models");
    return body.models;
  }
}

export const conversationManager = new AIClient();
