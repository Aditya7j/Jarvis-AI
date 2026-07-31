"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { GlassCard } from "@/components/ui/glass-card";
import { cn } from "@/lib/utils";
import { Brain, Search, MessageSquare, Clock } from "lucide-react";

const memories = [
  { text: "Working on JARVIS AI OS project - Next.js, TypeScript, Tailwind", time: "2 hours ago", type: "project" },
  { text: "User prefers dark mode with glassmorphism effects", time: "1 day ago", type: "preference" },
  { text: "Using Node.js v24 and npm v11 for development", time: "3 days ago", type: "system" },
  { text: "User asked about Three.js and React Three Fiber", time: "5 days ago", type: "conversation" },
];

export default function MemoryPage() {
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const filtered = useMemo(
    () =>
      memories.filter((m) =>
        m.text.toLowerCase().includes(deferredSearch.toLowerCase())
      ),
    [deferredSearch]
  );

  return (
    <DashboardPageFrame>
      <div>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Memory</h1>
        </header>
        <main className="p-6 max-w-4xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search memories..."
                className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.05] text-sm text-white/70 placeholder:text-white/20 outline-none focus:border-blue-500/30 transition-all"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2 px-3 py-2">
              <Brain className="w-4 h-4 text-purple-400" />
              <span className="text-xs text-white/30">LONG-TERM MEMORIES ({filtered.length})</span>
            </div>
            {filtered.map((memory, i) => (
              <div key={i} className="cv-auto">
                <GlassCard variant="interactive" className="p-4">
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                      memory.type === "project" ? "bg-blue-500/10" : memory.type === "preference" ? "bg-purple-500/10" : memory.type === "system" ? "bg-green-500/10" : "bg-orange-500/10"
                    )}>
                      {memory.type === "conversation" ? (
                        <MessageSquare className={cn("w-4 h-4", memory.type === "conversation" && "text-orange-400")} />
                      ) : (
                        <Brain className={cn("w-4 h-4", memory.type === "project" ? "text-blue-400" : memory.type === "preference" ? "text-purple-400" : "text-green-400")} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white/60">{memory.text}</p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Clock className="w-3 h-3 text-white/20" />
                        <span className="text-[10px] text-white/20">{memory.time}</span>
                        <span className="text-[10px] text-white/10 capitalize">· {memory.type}</span>
                      </div>
                    </div>
                  </div>
                </GlassCard>
              </div>
            ))}
          </div>
        </main>
      </div>
    </DashboardPageFrame>
  );
}
