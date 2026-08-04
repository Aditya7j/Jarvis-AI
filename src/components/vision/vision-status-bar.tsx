"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { memo } from "react";
import { useVisionStore } from "@/stores/vision-store";
import { cameraService } from "@/lib/camera";
import { Camera, Monitor, X, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const LiveThumbnail = memo(function LiveThumbnail({
  stream,
  label,
}: {
  stream: MediaStream | null;
  label: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      void video.play().catch(() => {});
    } else if (!stream && video.srcObject) {
      video.srcObject = null;
    }
  }, [stream]);

  if (!stream) return null;

  return (
    <div className="relative w-20 h-14 rounded-xl overflow-hidden border border-white/10 bg-black">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="w-full h-full object-cover"
      />
      <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-[8px] font-mono text-green-300/90">
        LIVE · {label}
      </span>
    </div>
  );
});
LiveThumbnail.displayName = "LiveThumbnail";

function PreviewThumbnail() {
  const webcamActive = useVisionStore((s) => s.webcamActive);
  const screenShareActive = useVisionStore((s) => s.screenShareActive);
  const webcamStream = useVisionStore((s) => s.webcamStream);
  const screenStream = useVisionStore((s) => s.screenStream);

  const stream = screenShareActive ? screenStream : webcamActive ? webcamStream : null;
  const label = screenShareActive ? "SCREEN" : "CAM";

  return <LiveThumbnail stream={stream} label={label} />;
}

function SourceBadge({
  icon,
  label,
  active,
  onStop,
  stopLabel,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onStop: () => void;
  stopLabel: string;
}) {
  if (!active) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/85 border border-green-500/20 shadow-[0_0_20px_rgba(34,197,94,0.15)]">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
      </span>
      {icon}
      <span className="text-xs text-green-300/90">{label} ON</span>
      <button
        onClick={onStop}
        className="flex items-center gap-1 ml-1 px-2 py-1 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/40 transition-colors text-[10px]"
        title={stopLabel}
      >
        <X className="w-3 h-3" />
        Stop
      </button>
    </div>
  );
}

export function VisionStatusBar() {
  const webcamActive = useVisionStore((s) => s.webcamActive);
  const screenShareActive = useVisionStore((s) => s.screenShareActive);
  const visionError = useVisionStore((s) => s.visionError);
  const setVisionError = useVisionStore((s) => s.setVisionError);
  const lastAnalysis = useVisionStore((s) => s.lastAnalysis);

  const anyActive = webcamActive || screenShareActive;
  if (!anyActive && !visionError) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      <AnimatePresence>
        {visionError && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="flex items-start gap-2 max-w-xs px-3 py-2.5 rounded-xl bg-black/85 border border-amber-500/20 text-amber-400/90 text-xs"
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span className="flex-1">{visionError}</span>
            <button
              onClick={() => setVisionError(null)}
              className="text-amber-400/60 hover:text-amber-300"
              aria-label="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {anyActive && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn("flex items-center gap-2")}
        >
          <PreviewThumbnail />
          <div className="flex items-center gap-2">
            <SourceBadge
              icon={<Camera className="w-3.5 h-3.5 text-green-400" />}
              label="Camera"
              active={webcamActive}
              onStop={() => cameraService.stopWebcam()}
              stopLabel="Turn camera off"
            />
            <SourceBadge
              icon={<Monitor className="w-3.5 h-3.5 text-green-400" />}
              label="Screen"
              active={screenShareActive}
              onStop={() => cameraService.stopScreenShare()}
              stopLabel="Stop screen sharing"
            />
          </div>
        </motion.div>
      )}

      {lastAnalysis && lastAnalysis.state !== "off" && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className={
            lastAnalysis.state === "error"
              ? "flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/85 border border-red-500/30 text-red-300/90 text-[10px] font-mono"
              : "flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/85 border border-cyan-500/20 text-cyan-300/80 text-[10px] font-mono"
          }
        >
          <span
            className={
              lastAnalysis.state === "error"
                ? "relative inline-flex rounded-full h-1.5 w-1.5 bg-red-400"
                : "relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400"
            }
          />
          {lastAnalysis.state === "error"
            ? `Vision error: ${lastAnalysis.error ?? "pipeline failed"}`
            : lastAnalysis.capturedAt
              ? `Analyzed ${new Date(lastAnalysis.capturedAt).toLocaleTimeString()} · conf ${
                  lastAnalysis.confidence ?? "-"
                }% · ${lastAnalysis.objectCount} object(s)`
              : "Camera ON · awaiting frame analysis"}
        </motion.div>
      )}
    </div>
  );
}
