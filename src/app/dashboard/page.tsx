"use client";

import { useEffect, useState } from "react";
import { DashboardPageFrame } from "./_components/dashboard-page-frame";
import { GlassCard } from "@/components/ui/glass-card";
import { useAppStore } from "@/stores/app-store";
import { useConversationStore } from "@/stores/conversation-store";
import { memoryClient } from "@/lib/memory/client";
import type { MemoryEntry } from "@/lib/memory/types";
import {
  Menu,
  MessageSquare,
  Mic,
  MicOff,
  Eye,
  Brain,
  Activity,
  Clock,
  Calendar,
  Bell,
  Command,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatClockDate,
  formatClockTime,
  getSystemClock,
  logTimeService,
  type SystemClockFact,
} from "@/lib/time/time-service";

function StatusDot({ active = false }: { active?: boolean }) {
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-1.5 rounded-full",
        active ? "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" : "bg-white/20"
      )}
    />
  );
}

function TimeWidget({ clock }: { clock: SystemClockFact }) {
  return (
    <GlassCard className="p-4 col-span-1">
      <div className="flex items-center justify-between mb-3">
        <Clock className="w-4 h-4 text-white/30" />
        <span className="text-[10px] text-white/20">LOCAL TIME</span>
      </div>
      <p className="text-2xl font-light tracking-tight text-white/90">
        {formatClockTime(new Date(clock.unixMs))}
      </p>
      <p className="text-xs text-white/30 mt-1">
        {formatClockDate(new Date(clock.unixMs))}
      </p>
    </GlassCard>
  );
}

function AIStateWidget() {
  const state = useConversationStore((s) => s.state);
  const messages = useConversationStore((s) => s.messages);
  return (
    <GlassCard variant="glow" className="p-4 col-span-2">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-blue-400" />
          <span className="text-xs text-white/40">AI STATUS</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusDot
            active={state === "listening" || state === "speaking" || state === "thinking"}
          />
          <span className="text-[10px] text-white/30 uppercase tracking-wider">
            {state === "idle"
              ? "Standing by"
              : state === "listening"
              ? "Listening"
              : state === "thinking"
              ? "Thinking"
              : "Speaking"}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center transition-all duration-500",
            state === "listening"
              ? "bg-green-500/20 shadow-[0_0_20px_rgba(34,197,94,0.2)]"
              : state === "thinking"
              ? "bg-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.2)]"
              : state === "speaking"
              ? "bg-purple-500/20 shadow-[0_0_20px_rgba(168,85,247,0.2)]"
              : "bg-white/5"
          )}
        >
          {state === "listening" ? (
            <Mic className="w-5 h-5 text-green-400" />
          ) : state === "speaking" ? (
            <MicOff className="w-5 h-5 text-purple-400" />
          ) : (
            <Zap className="w-5 h-5 text-white/40" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {messages.length > 0 ? (
            <p className="text-sm text-white/70 truncate">
              {messages[messages.length - 1].content.slice(0, 60)}
            </p>
          ) : (
            <p className="text-sm text-white/30">
              Say &quot;Hey Jarvis&quot; to start a conversation
            </p>
          )}
        </div>
      </div>
    </GlassCard>
  );
}

function QuickActions() {
  return (
    <GlassCard className="p-4 col-span-2">
      <div className="flex items-center gap-2 mb-4">
        <Zap className="w-4 h-4 text-yellow-400" />
        <span className="text-xs text-white/40">QUICK ACTIONS</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: "New Task", icon: MessageSquare, color: "text-blue-400" },
          { label: "Screen Share", icon: Eye, color: "text-cyan-400" },
          { label: "Calendar", icon: Calendar, color: "text-purple-400" },
          { label: "Commands", icon: Command, color: "text-orange-400" },
        ].map((action) => (
          <button
            key={action.label}
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.02] hover:bg-white/[0.05] transition-all text-sm text-white/50 hover:text-white/70"
          >
            <action.icon className={cn("w-4 h-4", action.color)} />
            {action.label}
          </button>
        ))}
      </div>
    </GlassCard>
  );
}

function SystemStatus() {
  return (
    <GlassCard className="p-4 col-span-1">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-4 h-4 text-white/30" />
        <span className="text-xs text-white/40">SYSTEM</span>
      </div>
      <div className="space-y-3">
        {[
          { label: "AI Core", status: "online" as const },
          { label: "Vision", status: "standby" as const },
          { label: "Memory", status: "online" as const },
          { label: "Voice", status: "online" as const },
        ].map((item) => (
          <div key={item.label} className="flex items-center justify-between">
            <span className="text-xs text-white/30">{item.label}</span>
            <div className="flex items-center gap-1.5">
              <StatusDot active={item.status === "online"} />
              <span className="text-[10px] text-white/20">{item.status}</span>
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

function RecentActivity() {
  return (
    <GlassCard className="p-4 col-span-1">
      <div className="flex items-center gap-2 mb-4">
        <Bell className="w-4 h-4 text-white/30" />
        <span className="text-xs text-white/40">ACTIVITY</span>
      </div>
      <div className="space-y-3">
        {[
          { text: "Memory synced", time: "2m ago" },
          { text: "Screen captured", time: "15m ago" },
          { text: "Task completed", time: "1h ago" },
        ].map((item, i) => (
          <div
            key={i}
            className="flex items-center justify-between py-1"
          >
            <span className="text-xs text-white/40">{item.text}</span>
            <span className="text-[10px] text-white/20">{item.time}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

function MemorySnapshot() {
  const [memories, setMemories] = useState<MemoryEntry[] | null>(null);

  useEffect(() => {
    let active = true;
    memoryClient
      .getSnapshot()
      .then((snapshot) => {
        if (!active) return;
        setMemories(
          snapshot.entries
            .filter((entry) => entry.status === "approved")
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 3)
        );
      })
      .catch(() => {
        if (active) setMemories([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <GlassCard variant="interactive" className="p-4 col-span-2">
      <div className="flex items-center gap-2 mb-4">
        <Brain className="w-4 h-4 text-purple-400" />
        <span className="text-xs text-white/40">MEMORY HIGHLIGHTS</span>
      </div>
      <div className="space-y-2">
        {memories === null ? (
          <p className="text-sm text-white/30">Loading memories...</p>
        ) : memories.length === 0 ? (
          <p className="text-sm text-white/30">
            No memories yet — add facts in the Memory tab.
          </p>
        ) : (
          memories.map((memory) => (
            <div
              key={memory.id}
              className="flex items-start gap-2 text-sm text-white/50"
            >
              <span className="text-purple-400/50 mt-0.5">•</span>
              <span>{memory.content}</span>
            </div>
          ))
        )}
      </div>
    </GlassCard>
  );
}

export default function DashboardPage() {
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const toggleCommandPalette = useAppStore((s) => s.toggleCommandPalette);
  const [clock, setClock] = useState<SystemClockFact>(() => getSystemClock());
  useEffect(() => {
    const timer = setInterval(() => {
      const next = getSystemClock();
      logTimeService("dashboard-clock", next);
      setClock(next);
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <DashboardPageFrame>
      <div>
        <header className="sticky top-0 z-20 border-b border-white/[0.03] bg-black/60 backdrop-blur-xl">
          <div className="flex items-center justify-between px-6 h-14">
            <div className="flex items-center gap-4">
              <button
                onClick={toggleSidebar}
                className="p-2 rounded-xl hover:bg-white/[0.05] transition-all text-white/40 hover:text-white/70"
              >
                <Menu className="w-4 h-4" />
              </button>
              <div className="h-4 w-px bg-white/[0.05]" />
              <span className="text-sm text-white/30 font-light">
                Dashboard
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={toggleCommandPalette}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.05] text-xs text-white/30 hover:text-white/50 transition-all"
              >
                <Command className="w-3 h-3" />
                <span>Ctrl+K</span>
              </button>
              <button className="p-2 rounded-xl hover:bg-white/[0.05] transition-all text-white/40 hover:text-white/70">
                <Bell className="w-4 h-4" />
              </button>
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-[10px] text-white font-medium">
                U
              </div>
            </div>
          </div>
        </header>

        <main className="p-6">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-white/90">
              {clock.greeting}
            </h1>
            <p className="text-sm text-white/30 mt-1">
              Your AI companion is ready.
            </p>
          </div>

          <div className="grid grid-cols-4 gap-4">
            <TimeWidget clock={clock} />
            <AIStateWidget />
            <QuickActions />
            <SystemStatus />
            <RecentActivity />
            <MemorySnapshot />
          </div>
        </main>
      </div>
    </DashboardPageFrame>
  );
}
