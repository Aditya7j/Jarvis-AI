"use client";

import { useRef, useEffect, useCallback, useState, memo } from "react";
import { useVoice } from "@/hooks/use-voice";
import { useConversationStore } from "@/stores/conversation-store";
import { useVoiceStore } from "@/stores/voice-store";
import { conversationManager } from "@/lib/ai/conversation-manager";
import { tts } from "@/lib/tts";
import { soundFX } from "@/lib/audio/sound-service";
import { registerInterruptHandler } from "@/lib/interrupt";
import { cn } from "@/lib/utils";
import type { AIMessage } from "@/types";
import { Mic, Send, Bot, Loader2, AlertTriangle, Square } from "lucide-react";

const MAX_HISTORY_MESSAGES = 20;

function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const MessageBubble = memo(function MessageBubble({
  msg,
  stale,
}: {
  msg: AIMessage;
  stale?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex",
        msg.role === "user" ? "justify-end" : "justify-start",
        stale && "cv-auto"
      )}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap",
          msg.role === "user"
            ? "bg-gradient-to-br from-blue-500/25 to-blue-600/10 border border-blue-500/30 text-white/90 shadow-[0_0_18px_rgba(59,130,246,0.15)]"
            : "bg-white/[0.04] border border-white/[0.06] text-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
        )}
      >
        {msg.content}
      </div>
    </div>
  );
});
MessageBubble.displayName = "MessageBubble";

export function VoiceInterface() {
  const { state, startListening, stopListening, speak, resumeContinuousMode } =
    useVoice();
  const messages = useConversationStore((s) => s.messages);
  const addMessage = useConversationStore((s) => s.addMessage);
  const transcript = useVoiceStore((s) => s.transcript);
  const interimTranscript = useVoiceStore((s) => s.interimTranscript);
  const setTranscript = useVoiceStore((s) => s.setTranscript);
  const micError = useVoiceStore((s) => s.micError);
  const recordingMs = useVoiceStore((s) => s.recordingMs);
  const clearMicError = useVoiceStore((s) => s.clearMicError);
  const continuousMode = useVoiceStore((s) => s.continuousMode);
  const setContinuousMode = useVoiceStore((s) => s.setContinuousMode);

  const containerRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingStreamRef = useRef("");
  const streamRafRef = useRef<number | null>(null);
  const [inputText, setInputText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [, setHealthVersion] = useState(0);

  useEffect(() => {
    conversationManager.refresh().catch(() => {});
    return conversationManager.subscribe(() => setHealthVersion((v) => v + 1));
  }, []);

  const queueStreamChunk = useCallback((token: string) => {
    pendingStreamRef.current += token;
    if (streamRafRef.current === null) {
      streamRafRef.current = requestAnimationFrame(() => {
        streamRafRef.current = null;
        setStreamingContent(pendingStreamRef.current);
      });
    }
  }, []);

  const resetStream = useCallback(() => {
    pendingStreamRef.current = "";
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    setStreamingContent("");
  }, []);

  const handleCancel = useCallback(() => {
    console.info("[VOICE] Interrupt requested");
    abortRef.current?.abort();
    tts.stop();
    resetStream();
    setErrorMessage(null);
    processingRef.current = false;
    setIsProcessing(false);
    useConversationStore.getState().setState("idle");
  }, [resetStream]);

  useEffect(() => {
    registerInterruptHandler(handleCancel);
    return () => registerInterruptHandler(null);
  }, [handleCancel]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      tts.stop();
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
    };
  }, []);

  const processAndSend = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || processingRef.current) return;

      if (tts.isSpeaking) {
        console.info("[VOICE] New message while speaking — interrupting");
        abortRef.current?.abort();
        tts.stop();
        resetStream();
      }

      processingRef.current = true;
      setIsProcessing(true);
      resetStream();
      setErrorMessage(null);
      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: trimmed,
        timestamp: Date.now(),
      };
      addMessage(userMsg);
      setInputText("");
      setTranscript("");

      useConversationStore.getState().setState("thinking");

      const controller = new AbortController();
      abortRef.current = controller;
      let didSpeak = false;

      try {
        const allMessages = [
          ...useConversationStore.getState().messages,
          userMsg,
        ].slice(-MAX_HISTORY_MESSAGES);
        let fullResponse = "";

        try {
          fullResponse = await conversationManager.generateResponse(
            allMessages,
            queueStreamChunk,
            controller.signal
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "AI request failed.";
          if (controller.signal.aborted) {
            resetStream();
            setErrorMessage(null);
            useConversationStore.getState().setState("idle");
            return;
          }
          setErrorMessage(message);
          resetStream();
          useConversationStore.getState().setState("idle");
          soundFX.play("error");
          return;
        }

        const assistantMsg = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: fullResponse,
          timestamp: Date.now(),
        };
        addMessage(assistantMsg);
        resetStream();
        useConversationStore.getState().setState("idle");

        if (fullResponse && !controller.signal.aborted) {
          didSpeak = true;
          speak(fullResponse);
        }
      } catch (err) {
        console.error("Error processing message:", err);
        useConversationStore.getState().setState("idle");
        resetStream();
      } finally {
        abortRef.current = null;
        processingRef.current = false;
        setIsProcessing(false);
        if (useVoiceStore.getState().continuousMode && !didSpeak) {
          resumeContinuousMode();
        }
      }
    },
    [addMessage, setTranscript, resetStream, queueStreamChunk, speak, resumeContinuousMode]
  );

  const handleSend = useCallback(() => {
    const text = (inputText || transcript).trim();
    if (text) void processAndSend(text);
  }, [inputText, transcript, processAndSend]);

  useEffect(() => {
    const finalTranscript = transcript?.trim();
    if (finalTranscript && !isProcessing) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "user" && lastMsg.content === finalTranscript)
        return;
      void processAndSend(finalTranscript);
    }
  }, [transcript, processAndSend, isProcessing, messages]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 96) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, interimTranscript, streamingContent, errorMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isSpeaking = state === "speaking";

  const statusLine = (() => {
    const caps = conversationManager.capabilities;
    const reasoning = caps?.reasoning;
    if (reasoning?.provider === "ollama") {
      return `Qwen3 ${reasoning.model ?? ""} via Ollama. Say &quot;Hey Jarvis&quot; or type a message.`;
    }
    if (reasoning?.provider) {
      return `Reasoning via ${reasoning.provider} (${reasoning.model ?? ""}). Say &quot;Hey Jarvis&quot; or type a message.`;
    }
    return "No AI provider connected. Add a Gemini API key in Settings or start Ollama.";
  })();

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={containerRef}>
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="relative w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500/15 via-cyan-500/10 to-purple-500/15 flex items-center justify-center mb-6 border border-cyan-500/15 shadow-[0_0_40px_rgba(56,189,248,0.15)]">
              <span className="absolute inset-0 rounded-3xl border border-cyan-300/20 animate-pulse-glow" />
              <Bot className="w-10 h-10 text-blue-400/80" />
            </div>
            <p className="text-white/40 text-sm tracking-[0.3em] uppercase text-gradient font-medium">
              Jarvis is ready
            </p>
            <p className="text-white/15 text-xs mt-2 max-w-xs leading-relaxed">
              {statusLine}
            </p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              stale={i < messages.length - 3}
            />
          ))
        )}

        {streamingContent && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white/[0.03] border border-white/[0.05] text-white/70 whitespace-pre-wrap">
              {streamingContent}
              <span className="inline-block w-1.5 h-4 bg-blue-400 ml-0.5 animate-pulse" />
            </div>
          </div>
        )}

        {isProcessing && !streamingContent && !errorMessage && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-white/[0.03] border border-white/[0.05] text-white/40 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
              Thinking<span className="animate-pulse">...</span>
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed bg-red-500/10 border border-red-500/20 text-red-400/90 whitespace-pre-wrap flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              {errorMessage}
            </div>
          </div>
        )}

        {(interimTranscript || state === "listening") &&
          !transcript &&
          !isProcessing &&
          !isSpeaking && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm bg-blue-500/10 border border-blue-500/10 text-white/40 italic">
                {interimTranscript || "Listening..."}
              </div>
            </div>
          )}
      </div>

      <div className="p-4 border-t border-white/[0.05]">
        {micError && (
          <div className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400/90 text-xs leading-relaxed">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span className="flex-1">{micError.message}</span>
            <button
              onClick={clearMicError}
              className="text-amber-400/60 hover:text-amber-300 text-sm leading-none shrink-0"
              aria-label="Dismiss microphone error"
            >
              &times;
            </button>
          </div>
        )}

        <div className="flex items-center justify-between mb-3 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.05]">
          <span className="text-xs text-white/40 flex items-center gap-2">
            <Mic className="w-3.5 h-3.5 text-green-400/70" />
            Continuous Voice Mode
          </span>
          <button
            onClick={() => {
              setTranscript("");
              setContinuousMode(!continuousMode);
            }}
            className={cn(
              "relative w-9 h-5 rounded-full transition-all duration-300",
              continuousMode
                ? "bg-gradient-to-r from-green-600/60 to-emerald-500/60 shadow-[0_0_12px_rgba(34,197,94,0.4)]"
                : "bg-white/[0.08] hover:bg-white/[0.12]"
            )}
            aria-pressed={continuousMode}
            title={
              continuousMode
                ? "Disable continuous voice mode"
                : "Enable continuous voice mode"
            }
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white/80 transition-transform duration-300",
                continuousMode && "translate-x-4"
              )}
            />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              if (state === "speaking") {
                handleCancel();
                return;
              }
              state === "listening" ? stopListening() : startListening();
            }}
            className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300 shrink-0",
              state === "listening"
                ? "bg-green-500/20 text-green-400"
                : "bg-white/[0.03] text-white/30 hover:text-white/50 hover:bg-white/[0.06]"
            )}
            title={
              state === "speaking"
                ? "Stop speaking"
                : state === "listening"
                ? "Stop listening"
                : "Start listening"
            }
          >
            <Mic className="w-4 h-4" />
          </button>

          <div className="flex-1 relative">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                state === "listening" ? "Speak or type..." : "Ask JARVIS anything..."
              }
              className="w-full px-4 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.05] text-sm text-white/70 placeholder:text-white/20 outline-none focus:border-cyan-500/40 focus:shadow-[0_0_16px_rgba(56,189,248,0.08)] transition-all"
            />
            {state === "listening" && !isProcessing && !isSpeaking && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                <span className="text-[10px] text-green-400/70 font-mono tabular-nums">
                  {formatRecordingTime(recordingMs)}
                </span>
                <div className="flex gap-0.5 items-end h-4">
                  {[2, 4, 3, 5, 2].map((h, i) => (
                    <div
                      key={i}
                      className="w-0.5 rounded-full bg-green-400 eq-bar"
                      style={{
                        height: h * 4,
                        animationDelay: `${i * 0.12}s`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          {isProcessing || isSpeaking ? (
            <button
              onClick={handleCancel}
              className="w-10 h-10 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all flex items-center justify-center shrink-0"
              aria-label="Stop generating or speaking"
              title="Stop"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!inputText.trim() && !transcript}
              className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-all flex items-center justify-center shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
