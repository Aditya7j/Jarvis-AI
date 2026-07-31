"use client";

import { Sidebar } from "@/components/layout/sidebar";
import { VisionInterface } from "@/components/vision/vision-interface";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";

export default function VisionPage() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);

  return (
    <div className="min-h-screen bg-black">
      <Sidebar />
      <div
        className={cn(
          "transition-all duration-300 min-h-screen",
          sidebarOpen ? "ml-[280px]" : "ml-0"
        )}
      >
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3">
          <h1 className="text-sm text-white/60">Vision</h1>
        </header>
        <main className="p-6">
          <VisionInterface />
        </main>
      </div>
    </div>
  );
}
