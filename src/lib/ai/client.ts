import type { AIMessage } from "@/types";
import type { HealthSummary, ProviderName } from "./types";
import type { RouterCapabilities } from "./router";
import type { VisionAnalysisSummary } from "./prompts";
import type { VisionFrame } from "@/lib/vision/vision-service";
import { visionService } from "@/lib/vision/vision-service";
import { useVisionStore } from "@/stores/vision-store";
import { classifyVisionDepth, classifyVisionIntent } from "./vision-intent";

type ErrorPayload = {
  code?: string;
  message?: string;
  provider?: string;
};

interface SSEFrame {
  token?: string;
  done?: boolean;
  error?: ErrorPayload;
  vision?: VisionAnalysisSummary;
  visionState?: { phase?: string };
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
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (event === "error" && parsed.error) return parsed as SSEFrame;
    if (event === "vision" && parsed.vision) return parsed as SSEFrame;
    if (event === "vision_state") {
      return {
        visionState: {
          phase: typeof parsed.phase === "string" ? parsed.phase : "",
        },
      };
    }
    return parsed as SSEFrame;
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

  get capabilities(): RouterCapabilities | null {
    return this.health?.capabilities ?? null;
  }

  get reasoningModel(): string | null {
    return this.capabilities?.reasoning?.model ?? null;
  }

  get visionModel(): string | null {
    return this.capabilities?.vision?.model ?? null;
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

  async generateResponse(
    messages: AIMessage[],
    onToken?: (token: string) => void,
    signal?: AbortSignal,
    onStatus?: (phase: string) => void
  ): Promise<string> {
    const body: {
      messages: Array<{ role: string; content: string }>;
      stream: boolean;
      vision: {
        state: "off" | "live" | "no-frame";
        frames: Array<{
          image: string;
          mimeType: string;
          source?: "webcam" | "screen";
          width?: number;
          height?: number;
          capturedAt?: number;
        }>;
      };
    } = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      vision: { state: "off", frames: [] },
    };

    const activeSource = visionService.getActiveSource();
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";
    const needsVision = classifyVisionIntent(prompt);
    const visionDepth = needsVision ? classifyVisionDepth(prompt) : null;
    if (needsVision && activeSource && visionDepth === "simple") {
      // Simple questions are answered from the continuously-refreshed YOLO
      // cache on the server — no blocking capture, no Gemma, <700ms total.
      body.vision = { state: "live", frames: [] };
      const live = visionService.getLiveResult(activeSource);
      console.info(
        `✓ Simple vision question → live YOLO cache (${
          live ? `${live.objects.length} object(s)` : "no analysis yet"
        })`
      );
    } else if (needsVision && activeSource && visionService.isLiveResultFresh(activeSource)) {
      body.vision = { state: "live", frames: [] };
      const live = visionService.getLiveResult(activeSource);
      console.info(
        `✓ Answered from live vision result (no new capture — conf ${live?.summary?.confidence ?? "-"}%, ${live?.objects?.length ?? 0} object(s), ${live?.newObjects?.length ?? 0} new)`
      );
    } else if (needsVision && activeSource) {
      const fresh = await visionService.captureAnalysisFrame(activeSource);
      const recent = visionService.getRecentFrames(activeSource, 3);
      const seen = new Set<number>();
      const frames: VisionFrame[] = [];
      if (fresh) {
        frames.push(fresh);
        seen.add(fresh.capturedAt);
      }
      for (const frame of recent) {
        if (frames.length >= 3) break;
        if (!seen.has(frame.capturedAt)) {
          frames.push(frame);
          seen.add(frame.capturedAt);
        }
      }
      if (frames.length > 0) {
        body.vision = {
          state: "live",
          frames: frames.map((frame) => ({
            image: frame.dataUrl,
            mimeType: frame.mimeType || "image/jpeg",
            source: frame.source,
            width: frame.width,
            height: frame.height,
            capturedAt: frame.capturedAt,
          })),
        };
        const totalBytes = frames.reduce(
          (sum, frame) => sum + Math.round(frame.dataUrl.length * 0.75),
          0
        );
        console.info(
          `✓ Camera frame captured (${frames.length} frame(s), ${frames[0].width}x${frames[0].height}, newest at ${new Date(
            frames[0].capturedAt
          ).toLocaleTimeString()})`
        );
        console.info(
          `✓ Image encoded (${frames.length} frame(s), ${totalBytes} bytes total, JPEG base64)`
        );
      } else {
        body.vision = { state: "no-frame", frames: [] };
        console.warn(
          "⚠ Camera is ON but no frame could be captured for this request"
        );
      }
    } else if (activeSource && !needsVision) {
      console.info("Vision skipped — prompt is text-only");
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
          if (parsed.vision) {
            useVisionStore.getState().setLastAnalysis(parsed.vision);
            console.info(
              `✓ Vision JSON received: ${parsed.vision.confidence ?? "-"}% confidence, ${parsed.vision.objectCount} object(s)`
            );
            continue;
          }
          if (parsed.visionState) {
            onStatus?.(parsed.visionState.phase ?? "");
            continue;
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

  private async updateProviderHealth(
    provider: "gemini" | "openai" | "anthropic",
    method: "POST" | "DELETE",
    apiKey?: string
  ): Promise<HealthSummary> {
    const body = await this.request<{ health: HealthSummary }>(
      "/api/settings/provider",
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiKey ? { provider, apiKey } : { provider }),
      }
    );
    this.health = body.health;
    this.notify();
    return body.health;
  }

  async setApiKey(
    provider: "gemini" | "openai" | "anthropic",
    apiKey: string
  ): Promise<HealthSummary> {
    return this.updateProviderHealth(provider, "POST", apiKey);
  }

  async clearProvider(
    provider: "gemini" | "openai" | "anthropic"
  ): Promise<HealthSummary> {
    return this.updateProviderHealth(provider, "DELETE");
  }
}

export const conversationManager = new AIClient();
