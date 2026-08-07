"use client";

import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";
import { forwardRef, memo } from "react";

type GlassCardVariant = "default" | "interactive" | "glow";

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: GlassCardVariant;
}

const GlassCard = memo(
  forwardRef<HTMLDivElement, GlassCardProps>(
    ({ className, variant = "default", children, ...props }, ref) => {
      return (
        <div
          ref={ref}
          className={cn(
            "hud-frame relative rounded-2xl border border-white/[0.06] transition-all duration-300",
            variant === "default" &&
              "bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
            variant === "interactive" &&
              "bg-white/[0.03] hover:bg-white/[0.06] hover:border-cyan-500/20 cursor-pointer hover:shadow-[0_0_24px_rgba(56,189,248,0.1)]",
            variant === "glow" &&
              "bg-white/[0.03] shadow-[0_0_30px_rgba(59,130,246,0.07)]",
            className
          )}
          {...props}
        >
          {children}
        </div>
      );
    }
  )
);
GlassCard.displayName = "GlassCard";

export { GlassCard };
