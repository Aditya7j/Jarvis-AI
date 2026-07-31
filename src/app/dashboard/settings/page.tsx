"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { cn } from "@/lib/utils";
import { GlassCard } from "@/components/ui/glass-card";
import { Button } from "@/components/ui/button";
import { conversationManager } from "@/lib/ai/conversation-manager";
import type { HealthSummary, ProviderStatusDetail } from "@/lib/ai/types";
import { Mic, Eye, Brain, Zap, Globe, Key, Check, ExternalLink, AlertTriangle, RefreshCw } from "lucide-react";

type ProviderKey = "gemini" | "openai" | "anthropic" | "ollama";

interface ProviderRow {
  key: ProviderKey;
  label: string;
  connectedLabel: string;
  disconnectedLabel: string;
}

const PROVIDER_ROWS: ProviderRow[] = [
  { key: "gemini", label: "Gemini", connectedLabel: "Connected", disconnectedLabel: "Not Connected" },
  { key: "openai", label: "OpenAI", connectedLabel: "Connected", disconnectedLabel: "Not Connected" },
  { key: "anthropic", label: "Anthropic", connectedLabel: "Connected", disconnectedLabel: "Not Connected" },
  { key: "ollama", label: "Ollama (Local)", connectedLabel: "Running", disconnectedLabel: "Not Running" },
];

const PROVIDER_BY_KEY = new Map(PROVIDER_ROWS.map((row) => [row.key, row]));

function providerStatus(health: HealthSummary | null, key: ProviderKey) {
  const detail: ProviderStatusDetail | undefined = health?.[key];
  const row = PROVIDER_BY_KEY.get(key);
  if (!detail) {
    return { text: "Checking...", color: "text-white/30", error: null };
  }
  if (detail.status === "connected") {
    return {
      text: row?.connectedLabel ?? "Connected",
      color: "text-green-400",
      error: null,
    };
  }
  if (detail.status === "error") {
    return {
      text: row?.disconnectedLabel ?? "Not Connected",
      color: "text-red-400/80",
      error: detail.error,
    };
  }
  return {
    text: row?.disconnectedLabel ?? "Not Connected",
    color: "text-white/30",
    error: null,
  };
}

export default function SettingsPage() {
  const [health, setHealth] = useState<HealthSummary | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [testingKey, setTestingKey] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await conversationManager.refresh();
      setHealth(result);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveApiKey = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) return;
    setKeyError("");
    setTestingKey(true);
    try {
      const result = await conversationManager.setApiKey("gemini", key);
      setHealth(result);
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 2000);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : "Could not save the API key.");
    }
    setTestingKey(false);
  }, [apiKey]);

  const testConnection = useCallback(async () => {
    setTestingConnection(true);
    try {
      const result = await conversationManager.testConnection();
      setHealth(result);
    } catch {
      setHealth(null);
    }
    setTestingConnection(false);
  }, []);

  const isGeminiConnected = health?.gemini.status === "connected";
  const isOllamaConnected = health?.ollama.status === "connected";
  const activeProviderLabel =
    health?.provider && health.provider !== "none"
      ? PROVIDER_BY_KEY.get(health.provider)?.label ?? "None"
      : "None";

  const sections = useMemo(() => {
    const providerItems = PROVIDER_ROWS.map((row) => {
      const status = providerStatus(health, row.key);
      return {
        label: row.label,
        value: status.text,
        color: status.color,
      };
    });
    return [
      {
        title: "AI Providers",
        icon: Globe,
        description: "Gemini (cloud, free tier), Ollama (local, no rate limits), OpenAI and Anthropic (paid).",
        items: [
          ...providerItems,
          {
            label: "Active Provider",
            value: activeProviderLabel,
            color: health?.status === "offline" || !health ? "text-white/30" : "text-green-400",
          },
        ],
      },
      {
        title: "Voice",
        icon: Mic,
        items: [
          { label: "Wake Word", value: '"Hey Jarvis"' },
          { label: "Speech Recognition", value: "Browser API (Free)" },
          { label: "Speech Synthesis", value: "Browser API (Free)" },
        ],
      },
      {
        title: "Vision",
        icon: Eye,
        items: [
          { label: "Camera", value: "Browser Webcam API" },
          { label: "Screen Share", value: "Browser Screen Capture API" },
          {
            label: "AI Vision",
            value: isGeminiConnected
              ? "Gemini Vision"
              : isOllamaConnected
              ? "Ollama (vision if available)"
              : "Unavailable",
            color: isGeminiConnected || isOllamaConnected ? "text-green-400" : "text-white/30",
          },
        ],
      },
      {
        title: "Memory",
        icon: Brain,
        items: [
          { label: "Storage", value: "Local & Browser Memory" },
          { label: "Retention", value: "Session + Local Storage" },
        ],
      },
      {
        title: "Plugins",
        icon: Zap,
        items: [
          { label: "Browser Automation", value: "Coming Soon" },
          { label: "Terminal", value: "Coming Soon" },
          { label: "GitHub", value: "Coming Soon" },
        ],
      },
    ] as Array<{
      title: string;
      icon: React.ComponentType<{ className?: string }>;
      description?: string;
      items: Array<{ label: string; value: string; color?: string }>;
    }>;
  }, [health, isGeminiConnected, isOllamaConnected, activeProviderLabel]);

  const providerErrors = useMemo(
    () =>
      PROVIDER_ROWS.map((row) => providerStatus(health, row.key).error).filter(
        (e): e is string => Boolean(e)
      ),
    [health]
  );

  return (
    <DashboardPageFrame>
      <div>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Settings</h1>
        </header>
        <main className="p-6 max-w-4xl">
          <GlassCard className="p-5 mb-4 border-blue-500/20">
            <div className="flex items-center gap-2 mb-3">
              <Key className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm text-white/70">Free API Key (Gemini)</h2>
            </div>
            <p className="text-xs text-white/30 mb-3">
              Get a free API key from{" "}
              <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline inline-flex items-center gap-1">
                Google AI Studio <ExternalLink className="w-3 h-3" />
              </a>{" "}
              — no credit card required. Keys are stored server-side only.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your Gemini API key..."
                className="flex-1 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.05] text-sm text-white/70 placeholder:text-white/20 outline-none focus:border-blue-500/30"
              />
              <Button size="sm" onClick={saveApiKey} variant={keySaved ? "secondary" : "default"} disabled={testingKey}>
                {testingKey ? (
                  "Saving..."
                ) : keySaved ? (
                  <><Check className="w-3.5 h-3.5 mr-1" /> Saved</>
                ) : (
                  "Save"
                )}
              </Button>
            </div>
            {keyError && (
              <p className="text-xs text-red-400/80 mt-2 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {keyError}
              </p>
            )}
            {health?.status === "offline" && (
              <p className="text-xs text-yellow-400/60 mt-2 flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                No AI provider is connected. Add GEMINI_API_KEY to your .env file or start Ollama.
              </p>
            )}
            {health?.status !== "offline" && health && (
              <p className="text-xs text-green-400/60 mt-2 flex items-center gap-1">
                <Check className="w-3 h-3" /> AI is active — all features enabled
              </p>
            )}
          </GlassCard>

          <div className="grid gap-4">
            {sections.map((section) => (
              <GlassCard key={section.title} className="p-5">
                <div className="flex items-center gap-2 mb-1">
                  <section.icon className="w-4 h-4 text-blue-400" />
                  <h2 className="text-sm text-white/70">{section.title}</h2>
                </div>
                {section.description && (
                  <p className="text-xs text-white/20 mb-3">{section.description}</p>
                )}
                <div className="space-y-3">
                  {section.items.map((item) => (
                    <div key={item.label} className="flex items-center justify-between py-1">
                      <span className="text-sm text-white/40">{item.label}</span>
                      <span className={cn("text-sm", item.color || "text-white/60")}>{item.value}</span>
                    </div>
                  ))}
                </div>
                {section.title === "AI Providers" && (
                  <div className="mt-4 flex items-center gap-3 border-t border-white/[0.05] pt-4">
                    <Button size="sm" variant="secondary" onClick={testConnection} disabled={testingConnection}>
                      <RefreshCw className={cn("w-3.5 h-3.5 mr-1", testingConnection && "animate-spin")} />
                      {testingConnection ? "Testing..." : "Test Connection"}
                    </Button>
                    {health && (
                      <span className="text-xs text-white/30">
                        Last checked {new Date(health.timestamp).toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                )}
              </GlassCard>
            ))}
          </div>

          {providerErrors.length > 0 && (
            <GlassCard className="p-5 mt-4 border-red-500/10">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <h2 className="text-sm text-white/70">Provider Errors</h2>
              </div>
              <div className="space-y-2">
                {providerErrors.map((error, index) => (
                  <p key={index} className="text-xs text-red-400/80 leading-relaxed">
                    {error}
                  </p>
                ))}
              </div>
            </GlassCard>
          )}
        </main>
      </div>
    </DashboardPageFrame>
  );
}
