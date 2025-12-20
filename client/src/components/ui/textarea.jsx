import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Textarea = forwardRef(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      className={cn(
        "flex min-h-[120px] w-full rounded-2xl bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-white/40 ring-1 ring-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 transition-colors duration-150 break-words [overflow-wrap:anywhere]",
        className
      )}
      ref={ref}
      {...props}
    />
  );
});
