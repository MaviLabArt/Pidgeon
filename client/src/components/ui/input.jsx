import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef(function Input({ className, type = "text", ...props }, ref) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-11 w-full rounded-2xl bg-slate-950 px-4 py-2 text-sm text-white placeholder:text-white/40 ring-1 ring-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 transition-colors duration-150",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
