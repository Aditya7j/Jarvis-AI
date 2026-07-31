"use client";

import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { memo } from "react";
import { useVisionStore } from "@/stores/vision-store";
import { visionService } from "@/lib/vision/vision-service";
import { Camera, Monitor, X, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

const PreviewThumbnail = memo(function PreviewThumbnail() {
  const lastCapturedFrame = useVisionStore((s) => s.lastCapturedFrame);
  const webcamActive = useVisionStore((s) => s.webcamActive);
  const screenShareActive = useVisionStore((s) => s.screenShareActive);
  if (!lastCapturedFrame) return null;
  return (
    <div
      className={cn(
        "relative w-20 h-14 rounded-xl overflow-hidden border border-white/10 bg-black",
        !webcamActive && !screenShareActive && "hidden"
      )}
    >
      <Image
        src={lastCapturedFrame}
        alt="Live vision preview"
        fill
        unoptimized
        className="object-cover"
      />
      <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-[8px] font-mono text-green-300/90">
        LIVE
      </span>
    </div>
  );
});
PreviewThumbnail.displayName = "PreviewThumbnail";

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
          className="flex items-center gap-2"
        >
          <PreviewThumbnail />
          <div className="flex items-center gap-2">
            <SourceBadge
              icon={<Camera className="w-3.5 h-3.5 text-green-400" />}
              label="Camera"
              active={webcamActive}
              onStop={() => visionService.stopWebcam()}
              stopLabel="Turn camera off"
            />
            <SourceBadge
              icon={<Monitor className="w-3.5 h-3.5 text-green-400" />}
              label="Screen"
              active={screenShareActive}
              onStop={() => visionService.stopScreenShare()}
              stopLabel="Stop screen sharing"
            />
          </div>
        </motion.div>
      )}
    </div>
  );
}
