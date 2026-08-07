"use client";

import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { VisionInterface } from "@/components/vision/vision-interface";

export default function VisionPage() {
  return (
    <DashboardPageFrame>
      <div>
        <header className="hud-header px-6 py-3">
          <h1 className="text-sm text-white/60">Vision</h1>
        </header>
        <main className="p-6">
          <VisionInterface />
        </main>
      </div>
    </DashboardPageFrame>
  );
}
