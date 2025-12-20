import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const Label = forwardRef(function Label({ className, ...props }, ref) {
  return (
    <label
      ref={ref}
      className={cn("text-sm font-medium leading-none text-white/70", className)}
      {...props}
    />
  );
});
