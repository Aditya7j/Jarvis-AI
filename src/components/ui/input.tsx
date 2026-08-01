"use client";

import { cn } from "@/lib/utils";
import { forwardRef, type InputHTMLAttributes } from "react";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "w-full px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.05] text-sm text-white/70 placeholder:text-white/20 outline-none focus:border-blue-500/30 focus:ring-1 focus:ring-blue-500/20 transition-all",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";
