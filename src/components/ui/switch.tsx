"use client";

import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  description?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  label,
  description,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className="inline-flex items-center gap-3 group disabled:opacity-40 disabled:pointer-events-none text-left"
    >
      <span
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200",
          checked
            ? "bg-blue-600 shadow-[0_0_10px_rgba(59,130,246,0.4)]"
            : "bg-white/[0.08] border border-white/[0.08]"
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform duration-200",
            checked ? "translate-x-[19px]" : "translate-x-[2px]"
          )}
        />
      </span>
      {(label || description) && (
        <span className="flex flex-col">
          {label && (
            <span className="text-sm text-white/70 group-hover:text-white/90 transition-colors">
              {label}
            </span>
          )}
          {description && (
            <span className="text-xs text-white/30">{description}</span>
          )}
        </span>
      )}
    </button>
  );
}
