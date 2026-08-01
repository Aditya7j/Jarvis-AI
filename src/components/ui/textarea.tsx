"use client";

import { cn } from "@/lib/utils";
import { forwardRef, type TextareaHTMLAttributes } from "react";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.05] text-sm text-white/70 placeholder:text-white/20 outline-none focus:border-blue-500/30 focus:ring-1 focus:ring-blue-500/20 transition-all resize-y min-h-[80px]",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";
