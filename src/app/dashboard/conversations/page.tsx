"use client";

import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { VoiceInterface } from "@/components/voice/voice-interface";
import { conversationManager } from "@/lib/ai/conversation-manager";
import { Bot, WifiOff, Cpu } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderName } from "@/lib/ai/types";

export default function ConversationsPage() {
  const [aiReady, setAiReady] = useState(false);
  const [provider, setProvider] = useState<ProviderName | "none">("none");

  useEffect(() => {
    let mounted = true;
    conversationManager
      .refresh()
      .then((health) => {
        if (!mounted) return;
        setAiReady(health.status !== "offline");
        setProvider(health.provider);
      })
      .catch(() => {
        if (mounted) setAiReady(false);
      });
    const unsubscribe = conversationManager.subscribe(() => {
      setAiReady(conversationManager.isConfigured);
      setProvider(conversationManager.provider);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <DashboardPageFrame>
      <div className="h-dvh overflow-hidden flex flex-col">
        <header className="hud-header px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-sm text-white/60">Conversations</h1>
            {!aiReady && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400/60 text-[10px]">
                <WifiOff className="w-3 h-3" />
                Offline mode
              </span>
            )}
            {aiReady && provider === "ollama" && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400/60 text-[10px]">
                <Cpu className="w-3 h-3" />
                Ollama (Local)
              </span>
            )}
            {aiReady && provider === "gemini" && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-400/60 text-[10px]">
                <Bot className="w-3 h-3" />
                Gemini Active
              </span>
            )}
            {aiReady &&
              (provider === "openai" || provider === "anthropic") && (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-400/60 text-[10px]">
                  <Bot className="w-3 h-3" />
                  {provider === "openai" ? "OpenAI Active" : "Anthropic Active"}
                </span>
              )}
          </div>
        </header>
        <VoiceInterface />
      </div>
    </DashboardPageFrame>
  );
}
