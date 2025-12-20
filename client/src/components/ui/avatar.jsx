import React from "react";
import { cn } from "@/lib/utils";

export function Avatar({ className, children, ...props }) {
  return (
    <div
      className={cn("relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-full bg-slate-200", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function AvatarFallback({ className, children, ...props }) {
  return (
    <div
      className={cn(
        "flex h-full w-full items-center justify-center bg-slate-900 text-sm font-medium text-white",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
