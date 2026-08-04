"use client";

import { useEffect, useRef } from "react";
import { useVisionStore } from "@/stores/vision-store";
import { cameraService } from "@/lib/camera";
import type { VisionStateSnapshot } from "@/lib/vision/vision-state";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-[10px] leading-4">
      <span className="text-white/35 shrink-0">{label}</span>
      <span className="text-cyan-300/80 text-right break-all">{value || "-"}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-[9px] uppercase tracking-wider text-white/25 mb-1">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export function VisionDebugOverlay() {
  const open = useVisionStore((s) => s.debugOverlayOpen);
  const setOpen = useVisionStore((s) => s.setDebugOverlayOpen);
  const state = useVisionStore((s) => s.latestVisionState);
  const liveResult = useVisionStore((s) => s.latestLiveResult);
  const analyzing = useVisionStore((s) => s.liveAnalyzing);
  const statsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const render = () => {
      if (statsRef.current) {
        const src = cameraService.getActiveSource();
        statsRef.current.textContent = src
          ? cameraService.formatStats(src)
          : "no active source";
      }
    };
    render();
    return cameraService.subscribeFrames(render);
  }, [open]);

  if (!open) return null;

  const vs: VisionStateSnapshot | null = state;
  const stats = vs?.stats;
  const ageMs = vs && vs.timestamp > 0 ? Date.now() - vs.timestamp : null;

  return (
    <div className="absolute inset-x-0 top-0 z-30 h-full w-full pointer-events-none">
      <div className="pointer-events-auto absolute right-3 top-3 w-[300px] max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-lg border border-cyan-500/20 bg-black/85 backdrop-blur-xl p-3 font-mono shadow-2xl">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] text-cyan-300/90 uppercase tracking-wider">
            Vision Debug
          </span>
          <button
            onClick={() => setOpen(false)}
            className="text-white/40 hover:text-white text-xs px-1"
            aria-label="Close debug overlay"
          >
            ✕
          </button>
        </div>

        <Section title="Engine">
          <Row label="Session" value={analyzing ? "analyzing" : "idle"} />
          <Row label="Objects" value={String(vs?.activeTrackingIds.length ?? 0)} />
          <Row label="Cache age" value={ageMs !== null ? `${ageMs}ms` : "none"} />
          <Row label="YOLO FPS" value={stats?.yoloFps ? stats.yoloFps.toFixed(1) : "-"} />
          <Row
            label="Inference"
            value={stats?.lastInferenceMs ? `${stats.lastInferenceMs.toFixed(1)}ms` : "-"}
          />
          <Row
            label="Pipeline"
            value={stats?.lastPipelineMs ? `${stats.lastPipelineMs.toFixed(1)}ms` : "-"}
          />
          <Row label="Frames analyzed" value={String(stats?.framesAnalyzed ?? 0)} />
          <Row label="ROI hits" value={String(stats?.roiHits ?? 0)} />
          <Row label="Model" value={stats?.source ?? "-"} />
          {stats?.lastError && <Row label="Error" value={stats.lastError} />}
        </Section>

        <Section title="Scene">
          <Row label="Summary" value={vs?.latestScene ?? "-"} />
          <Row
            label="Held object"
            value={vs?.heldObject ? `${vs.heldObject.label} (${Math.round(vs.heldObject.confidence * 100)}%)` : "-"}
          />
          <Row
            label="Flag"
            value={vs?.flag ? `${vs.flag.label} [${vs.flag.bands.join("-")}]` : "-"}
          />
          <Row label="People" value={String(vs?.latestPeople.length ?? 0)} />
          {vs?.latestPeople.map((person) => (
            <Row
              key={person.trackingId}
              label={`#${person.trackingId}`}
              value={`person · shirt ${person.shirtColor?.name ?? "?"} · ${Math.round(
                person.confidence * 100
              )}%`}
            />
          ))}
        </Section>

        <Section title="Tracked objects">
          {vs && Object.values(vs.latestObjects).length > 0 ? (
            Object.values(vs.latestObjects).map((object) => (
              <Row
                key={object.trackingId}
                label={`#${object.trackingId}`}
                value={`${object.label}${object.color ? ` (${object.color.name})` : ""} · ${Math.round(
                  object.confidence * 100
                )}% · hits ${object.hits}`}
              />
            ))
          ) : (
            <Row label="-" value="none yet" />
          )}
        </Section>

        <Section title="Text / OCR">
          <Row label="Lines" value={String(vs?.latestText.lines.length ?? 0)} />
        </Section>

        <Section title="Gemma">
          <Row
            label="Last call"
            value={
              vs?.lastGemma
                ? `${new Date(vs.lastGemma.at).toLocaleTimeString()} · ${vs.lastGemma.reason}`
                : "never (cache only)"
            }
          />
        </Section>

        <Section title="Camera">
          <div ref={statsRef} className="text-[10px] text-white/40 leading-4" />
          <Row label="Live result" value={liveResult?.state ?? "off"} />
          <Row label="New objects" value={liveResult?.newObjects.join(", ") ?? "-"} />
          <Row label="Gone objects" value={liveResult?.goneObjects.join(", ") ?? "-"} />
        </Section>
      </div>
    </div>
  );
}
