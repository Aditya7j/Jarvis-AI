"use client";

import { Sidebar } from "@/components/layout/sidebar";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";

export function DashboardPageFrame({
  children,
}: {
  children: React.ReactNode;
}) {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  return (
    <div className="min-h-screen">
      <Sidebar />
      <div
        className={cn(
          "transition-all duration-300 min-h-screen",
          sidebarOpen ? "ml-[280px]" : "ml-0"
        )}
      >
        {children}
      </div>
    </div>
  );
}
