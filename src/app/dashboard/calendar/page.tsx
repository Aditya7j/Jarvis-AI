"use client";

import { useCallback, useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { GlassCard } from "@/components/ui/glass-card";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";

const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export default function CalendarPage() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const [date, setDate] = useState(new Date());
  const [events, setEvents] = useState<Record<string, string[]>>({});

  const year = date.getFullYear();
  const month = date.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  const prevMonth = useCallback(() => setDate(new Date(year, month - 1, 1)), [year, month]);
  const nextMonth = useCallback(() => setDate(new Date(year, month + 1, 1)), [year, month]);

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <div className={cn("transition-all duration-300 min-h-screen", sidebarOpen ? "ml-[280px]" : "ml-0")}>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Calendar</h1>
        </header>
        <main className="p-6 max-w-4xl">
          <GlassCard className="p-6">
            <div className="flex items-center justify-between mb-6">
              <button onClick={prevMonth} className="p-2 rounded-xl hover:bg-white/[0.05] text-white/40 hover:text-white/70">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <h2 className="text-lg text-white/70 font-light">{months[month]} {year}</h2>
              <button onClick={nextMonth} className="p-2 rounded-xl hover:bg-white/[0.05] text-white/40 hover:text-white/70">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-1 mb-2">
              {days.map(d => (
                <div key={d} className="text-center text-[10px] text-white/20 tracking-widest uppercase py-2">{d}</div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstDay }).map((_, i) => (
                <div key={`empty-${i}`} className="aspect-square" />
              ))}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const day = i + 1;
                const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                const key = `${year}-${month}-${day}`;
                const hasEvents = events[key]?.length > 0;
                return (
                  <div
                    key={day}
                    className={cn(
                      "aspect-square rounded-xl flex items-center justify-center text-sm cursor-pointer transition-all",
                      isToday ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "text-white/40 hover:bg-white/[0.05] hover:scale-[1.05]"
                    )}
                  >
                    <div className="relative">
                      {day}
                      {hasEvents && <span className="absolute -top-1 -right-2 w-1.5 h-1.5 rounded-full bg-blue-400" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </GlassCard>
        </main>
      </div>
    </div>
  );
}
