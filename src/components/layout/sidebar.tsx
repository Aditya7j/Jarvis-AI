"use client";

import { useAppStore } from "@/stores/app-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  MessageSquare,
  Sparkles,
  Clock,
  Settings,
  Search,
  Plus,
  Bot,
  Eye,
  Calendar,
  CheckSquare,
  HardDrive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { icon: Bot, label: "Dashboard", href: "/dashboard" },
  { icon: MessageSquare, label: "Conversations", href: "/dashboard/conversations" },
  { icon: Eye, label: "Vision", href: "/dashboard/vision" },
  { icon: CheckSquare, label: "Tasks", href: "/dashboard/tasks" },
  { icon: Calendar, label: "Calendar", href: "/dashboard/calendar" },
  { icon: HardDrive, label: "Memory", href: "/dashboard/memory" },
  { icon: Settings, label: "Settings", href: "/dashboard/settings" },
];

export function Sidebar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const conversations = useConversationStore((s) => s.conversations);
  const createConversation = useConversationStore((s) => s.createConversation);
  const switchConversation = useConversationStore((s) => s.switchConversation);
  const pathname = usePathname();

  return (
    <AnimatePresence mode="wait">
      {sidebarOpen && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 280, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: "easeInOut" }}
          className="fixed left-0 top-0 h-full z-30 overflow-hidden border-r border-white/[0.05]"
        >
          <div className="w-[280px] h-full bg-black/85 flex flex-col">
            <div className="p-4 border-b border-white/[0.05]">
              <Link
                href="/dashboard"
                className="flex items-center gap-3 group"
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white/90">
                    JARVIS
                  </h2>
                  <p className="text-[10px] text-white/30 tracking-widest uppercase">
                    AI Operating System
                  </p>
                </div>
              </Link>
            </div>

            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all duration-200 group",
                      isActive
                        ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                        : "text-white/40 hover:text-white/70 hover:bg-white/[0.03]"
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    <span>{item.label}</span>
                    {isActive && (
                      <motion.div
                        layoutId="activeNav"
                        className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400"
                      />
                    )}
                  </Link>
                );
              })}
            </nav>

            <div className="p-3 border-t border-white/[0.05]">
              <div className="mb-2 px-3 py-1">
                <p className="text-[10px] text-white/20 tracking-widest uppercase flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  Recent
                </p>
              </div>
              <button
                onClick={createConversation}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-sm text-white/50 hover:text-white/70 hover:bg-white/[0.03] transition-all mb-1"
              >
                <Plus className="w-3.5 h-3.5" />
                New conversation
              </button>
              {conversations.slice(0, 5).map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => switchConversation(conv.id)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-xs text-white/30 hover:text-white/50 hover:bg-white/[0.03] transition-all truncate"
                >
                  <MessageSquare className="w-3 h-3 shrink-0" />
                  <span className="truncate">{conv.title}</span>
                </button>
              ))}
            </div>

            <div className="p-3 border-t border-white/[0.05]">
              <button className="flex items-center gap-2 w-full px-3 py-2 rounded-xl text-xs text-white/20 hover:text-white/40 hover:bg-white/[0.03] transition-all">
                <Search className="w-3 h-3" />
                Search memory...
              </button>
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
