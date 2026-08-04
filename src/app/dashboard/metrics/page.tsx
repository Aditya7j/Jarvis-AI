"use client";

import { DashboardPageFrame } from "../_components/dashboard-page-frame";
import { MetricsPanel } from "./_components/metrics-panel";

export default function MetricsPage() {
  return (
    <DashboardPageFrame>
      <div>
        <header className="border-b border-white/[0.03] bg-black/60 backdrop-blur-xl px-6 py-3 flex items-center justify-between">
          <h1 className="text-sm text-white/60">Metrics</h1>
        </header>
        <main className="p-6">
          <MetricsPanel />
        </main>
      </div>
    </DashboardPageFrame>
  );
}
