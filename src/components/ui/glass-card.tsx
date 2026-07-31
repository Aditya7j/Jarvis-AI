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
            "rounded-2xl border border-white/[0.05]",
            variant === "default" && "bg-white/[0.03]",
            variant === "interactive" &&
              "bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/[0.1] cursor-pointer",
            variant === "glow" &&
              "bg-white/[0.03] shadow-[0_0_30px_rgba(59,130,246,0.05)]",
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
