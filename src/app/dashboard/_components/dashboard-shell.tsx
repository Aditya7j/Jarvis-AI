"use client";

import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette/command-palette";
import { VisionStatusBar } from "@/components/vision/vision-status-bar";
import { useSoundEffects } from "@/hooks/use-sound-effects";
import { conversationManager } from "@/lib/ai/conversation-manager";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  useSoundEffects();

  useEffect(() => {
    conversationManager.refresh().catch(() => {});
  }, []);

  return (
    <>
      <CommandPalette />
      <VisionStatusBar />
      {children}
    </>
  );
}
