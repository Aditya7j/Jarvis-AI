"use client";

import { useCallback, useEffect, useRef } from "react";
import { GlassCard } from "@/components/ui/glass-card";
import { Button } from "@/components/ui/button";
import { useVisionStore } from "@/stores/vision-store";
import { cameraService } from "@/lib/camera";
import type { CameraSource } from "@/lib/camera";
import { liveVisionSession } from "@/lib/vision/live-vision-session";
import { VisionDebugOverlay } from "./vision-debug-overlay";
import { Camera, Monitor, StopCircle, AlertTriangle, Video, Gauge } from "lucide-react";
import { formatTimestampTime } from "@/lib/time/time-service";

export function VisionInterface() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const miniVideoRef = useRef<HTMLVideoElement>(null);
  const statsRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);
  const analysisRef = useRef<HTMLSpanElement>(null);

  const webcamActive = useVisionStore((s) => s.webcamActive);
  const screenShareActive = useVisionStore((s) => s.screenShareActive);
  const webcamStream = useVisionStore((s) => s.webcamStream);
  const screenStream = useVisionStore((s) => s.screenStream);
  const visionError = useVisionStore((s) => s.visionError);
  const setVisionError = useVisionStore((s) => s.setVisionError);
  const lastAnalysis = useVisionStore((s) => s.lastAnalysis);
  const debugOverlayOpen = useVisionStore((s) => s.debugOverlayOpen);
  const setDebugOverlayOpen = useVisionStore((s) => s.setDebugOverlayOpen);

  const activeMode: CameraSource | null = screenShareActive
    ? "screen"
    : webcamActive
      ? "webcam"
      : null;
  const activeStream = screenShareActive ? screenStream : webcamStream;

  useEffect(() => {
    if (activeMode) {
      liveVisionSession.start();
    } else {
      liveVisionSession.stop();
    }
  }, [activeMode]);

  useEffect(() => {
    for (const ref of [videoRef, miniVideoRef]) {
      const video = ref.current;
      if (!video) continue;
      if (activeStream && video.srcObject !== activeStream) {
        video.srcObject = activeStream;
        void video.play().catch(() => {});
      } else if (!activeStream && video.srcObject) {
        video.srcObject = null;
      }
    }
  }, [activeStream]);

  useEffect(() => {
    if (!activeMode) return;
    const render = () => {
      if (statsRef.current) {
        statsRef.current.textContent = cameraService.formatStats(activeMode);
      }
      const frame = cameraService.getLatestFrame(activeMode);
      if (metaRef.current) {
        metaRef.current.textContent = frame
          ? `Frame ${frame.width}×${frame.height} · ${formatTimestampTime(frame.capturedAt)}`
          : "Waiting for first frame...";
      }
      if (analysisRef.current) {
        const state = useVisionStore.getState();
        const live = state.latestLiveResult;
        if (state.liveAnalyzing) {
          analysisRef.current.textContent = "Analyzing live frame…";
        } else if (live && live.summary && live.summary.state === "live") {
          const extra =
            live.newObjects.length > 0
              ? ` · new: ${live.newObjects.join(", ")}`
              : "";
          analysisRef.current.textContent = `Live analyzed ${formatTimestampTime(
            live.summary.capturedAt ?? Date.now()
          )} · conf ${live.summary.confidence ?? "?"}% · ${
            live.summary.objectCount
          } object(s)${extra}`;
        } else if (live?.error) {
          analysisRef.current.textContent = "Vision error — check server logs";
        } else {
          const analysis = state.lastAnalysis;
          if (analysis?.state === "error") {
            analysisRef.current.textContent = "Vision error — check server logs";
          } else if (analysis && analysis.state === "live" && analysis.capturedAt) {
            analysisRef.current.textContent = `Analyzed ${formatTimestampTime(
              analysis.capturedAt
            )} · conf ${analysis.confidence ?? "?"}% · ${
              analysis.objectCount
            } object(s)`;
          } else {
            analysisRef.current.textContent =
              "Waiting for first live analysis…";
          }
        }
      }
    };
    render();
    return cameraService.subscribeFrames(render);
  }, [activeMode, lastAnalysis]);

  const handleCapture = useCallback(() => {
    void cameraService.captureFrame().then((frame) => {
      if (frame) {
        console.info(
          `[VISION] Frame captured (${frame.width}x${frame.height}, ${Math.round(
            frame.dataUrl.length / 1024
          )} KB)`
        );
      } else {
        console.warn("[VISION] Frame capture failed — no active stream");
      }
    });
  }, []);

  return (
    <GlassCard className="overflow-hidden">
      <div className="p-4 border-b border-white/[0.05] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-cyan-400" />
          <span className="text-sm text-white/60">Vision</span>
          {activeMode && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-400/80 text-[10px]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-400" />
              </span>
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDebugOverlayOpen(!debugOverlayOpen)}
              className={debugOverlayOpen ? "bg-cyan-500/10 text-cyan-300" : ""}
            >
              <Gauge className="w-3.5 h-3.5 mr-1" />
              Debug
            </Button>
          )}
          {activeMode ? (
            <Button variant="ghost" size="sm" onClick={() => cameraService.stopAll()}>
              <StopCircle className="w-4 h-4 text-red-400 mr-1" />
              Stop
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => void cameraService.startWebcam()}>
                <Camera className="w-3.5 h-3.5 mr-1" />
                Webcam
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void cameraService.startScreenShare()}>
                <Monitor className="w-3.5 h-3.5 mr-1" />
                Screen
              </Button>
            </>
          )}
        </div>
      </div>
      {visionError && (
        <div className="px-4 py-2.5 border-b border-white/[0.05] bg-amber-500/5 flex items-center gap-2 text-amber-400/90 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1">{visionError}</span>
          <button
            onClick={() => setVisionError(null)}
            className="text-amber-400/60 hover:text-amber-300"
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}
      <div className="relative aspect-video bg-black/50 flex items-center justify-center">
        {activeMode ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain"
            />
            <VisionDebugOverlay />
            <button
              onClick={handleCapture}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-xl border border-white/10 text-xs text-white/60 hover:text-white/80 hover:bg-white/20 transition-all"
            >
              Capture Frame
            </button>
          </>
        ) : (
          <div className="text-center">
            <Camera className="w-12 h-12 text-white/10 mx-auto mb-3" />
            <p className="text-sm text-white/30">Start webcam or screen share</p>
            <p className="text-xs text-white/20 mt-1">JARVIS will analyze what it sees</p>
          </div>
        )}
      </div>
      {activeMode && (
        <div className="p-3 flex items-center gap-3 border-t border-white/[0.05]">
          <div className="w-16 h-12 rounded-lg relative overflow-hidden border border-white/10 bg-black shrink-0">
            <video ref={miniVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs text-white/50 flex items-center gap-1.5">
              <Video className="w-3.5 h-3.5" />
              Live vision shared with JARVIS
            </span>
            <span ref={statsRef} className="text-[10px] text-white/25 font-mono truncate" />
            <span ref={metaRef} className="text-[10px] text-white/25 font-mono truncate" />
            <span ref={analysisRef} className="text-[10px] text-cyan-400/50 font-mono truncate" />
          </div>
        </div>
      )}
    </GlassCard>
  );
}
