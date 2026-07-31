"use client";

import { useRef, useEffect } from "react";
import Image from "next/image";
import { GlassCard } from "@/components/ui/glass-card";
import { Button } from "@/components/ui/button";
import { useVisionStore } from "@/stores/vision-store";
import { visionService } from "@/lib/vision/vision-service";
import { Camera, Monitor, Image as ImageIcon, StopCircle, AlertTriangle } from "lucide-react";

export function VisionInterface() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const webcamActive = useVisionStore((s) => s.webcamActive);
  const screenShareActive = useVisionStore((s) => s.screenShareActive);
  const webcamStream = useVisionStore((s) => s.webcamStream);
  const screenStream = useVisionStore((s) => s.screenStream);
  const lastCapturedFrame = useVisionStore((s) => s.lastCapturedFrame);
  const visionError = useVisionStore((s) => s.visionError);
  const setVisionError = useVisionStore((s) => s.setVisionError);

  const activeMode = screenShareActive
    ? "screen"
    : webcamActive
      ? "webcam"
      : null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const stream = screenShareActive ? screenStream : webcamStream;
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      console.info(`[CAM] Attached ${activeMode} stream to video element`);
    }
    if (!stream && video.srcObject) {
      video.srcObject = null;
      console.info("[CAM] Detached stream from video element");
    }
  }, [activeMode, screenShareActive, webcamStream, screenStream]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video) {
        video.srcObject = null;
      }
    };
  }, []);

  const captureFrame = () => {
    void visionService.captureFrame().then((frame) => {
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
  };

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
          {activeMode ? (
            <Button variant="ghost" size="sm" onClick={() => visionService.stopAll()}>
              <StopCircle className="w-4 h-4 text-red-400 mr-1" />
              Stop
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => void visionService.startWebcam()}>
                <Camera className="w-3.5 h-3.5 mr-1" />
                Webcam
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void visionService.startScreenShare()}>
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
            <button
              onClick={captureFrame}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-xl border border-white/10 text-xs text-white/60 hover:text-white/80 hover:bg-white/20 transition-all"
            >
              Capture Frame
            </button>
          </>
        ) : (
          <div className="text-center">
            <Camera className="w-12 h-12 text-white/10 mx-auto mb-3" />
            <p className="text-sm text-white/30">
              Start webcam or screen share
            </p>
            <p className="text-xs text-white/20 mt-1">
              JARVIS will analyze what it sees
            </p>
          </div>
        )}
      </div>
      {lastCapturedFrame && !activeMode && (
        <div className="p-3 flex items-center gap-2 border-t border-white/[0.05]">
          <div className="w-16 h-12 rounded-lg relative overflow-hidden border border-white/10">
            <Image
              src={lastCapturedFrame}
              alt="Last captured frame"
              fill
              unoptimized
              className="object-cover"
            />
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-white/50 flex items-center gap-1.5">
              <ImageIcon className="w-3.5 h-3.5" />
              Last captured frame
            </span>
            <span className="text-[10px] text-white/25">
              Available as vision context to JARVIS
            </span>
          </div>
        </div>
      )}
    </GlassCard>
  );
}
