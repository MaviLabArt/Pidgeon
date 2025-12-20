import React from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-white/10 text-white/90 ring-1 ring-white/10",
  secondary: "bg-slate-800 text-white/80 ring-1 ring-white/10",
  destructive: "bg-red-500/15 text-red-200 ring-1 ring-red-400/30",
  outline: "bg-transparent text-white/70 ring-1 ring-white/15",
};

export function Badge({ className, variant = "default", ...props }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-150",
        variants[variant] || variants.default,
        className
      )}
      {...props}
    />
  );
}
