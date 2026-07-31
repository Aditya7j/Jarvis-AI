"use client";

import { useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "@/stores/app-store";
import {
  Command,
  Search,
  MessageSquare,
  Eye,
  Settings,
  Zap,
  FileText,
  Terminal,
  Globe,
  Calendar,
} from "lucide-react";

const commands = [
  {
    group: "Navigation",
    items: [
      { icon: MessageSquare, label: "Open Conversations", action: "/dashboard/conversations" },
      { icon: Eye, label: "Open Vision", action: "/dashboard/vision" },
      { icon: Settings, label: "Open Settings", action: "/dashboard/settings" },
    ],
  },
  {
    group: "Actions",
    items: [
      { icon: Zap, label: "New Task", action: "new-task" },
      { icon: Terminal, label: "Open Terminal", action: "terminal" },
      { icon: Globe, label: "Browser Automation", action: "browser" },
      { icon: Calendar, label: "Check Calendar", action: "calendar" },
      { icon: FileText, label: "Create Note", action: "note" },
    ],
  },
];

export function CommandPalette() {
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const flatCommands = useMemo(() => commands.flatMap((g) => g.items), []);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(!useAppStore.getState().commandPaletteOpen);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setCommandPaletteOpen]);

  useEffect(() => {
    if (commandPaletteOpen) {
      setSearch("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [commandPaletteOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!useAppStore.getState().commandPaletteOpen) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatCommands.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Escape") {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flatCommands.length, setCommandPaletteOpen]);

  const filtered = useMemo(
    () =>
      commands
        .map((g) => ({
          ...g,
          items: g.items.filter((i) =>
            i.label.toLowerCase().includes(deferredSearch.toLowerCase())
          ),
        }))
        .filter((g) => g.items.length > 0),
    [deferredSearch]
  );

  return (
    <AnimatePresence>
      {commandPaletteOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 z-50"
            onClick={() => setCommandPaletteOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.15 }}
            className="fixed top-[15%] left-1/2 -translate-x-1/2 w-full max-w-lg z-50"
          >
            <div className="rounded-2xl border border-white/[0.08] bg-black/95 overflow-hidden shadow-2xl shadow-black/50">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.05]">
                <Search className="w-4 h-4 text-white/30" />
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelectedIndex(0);
                  }}
                  placeholder="Type a command or search..."
                  className="flex-1 bg-transparent text-sm text-white/70 placeholder:text-white/20 outline-none"
                />
                <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-white/[0.05] text-white/20 border border-white/[0.05]">
                  ESC
                </kbd>
              </div>
              <div className="p-2 max-h-72 overflow-y-auto">
                {filtered.map((group) => (
                  <div key={group.group}>
                    <p className="px-2 py-1.5 text-[10px] text-white/20 tracking-widest uppercase">
                      {group.group}
                    </p>
                    {group.items.map((item) => (
                      <button
                        key={item.label}
                        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm text-white/50 hover:text-white/80 hover:bg-white/[0.05] transition-all"
                        onClick={() => setCommandPaletteOpen(false)}
                      >
                        <item.icon className="w-4 h-4 text-white/30" />
                        {item.label}
                      </button>
                    ))}
                  </div>
                ))}
                {filtered.length === 0 && (
                  <p className="text-center py-8 text-sm text-white/20">
                    No commands found
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
