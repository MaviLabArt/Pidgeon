import React, { forwardRef, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export const Switch = forwardRef(function Switch(
  { className, checked, defaultChecked = false, disabled, onCheckedChange, ...props },
  ref
) {
  const isControlled = checked !== undefined;
  const [internal, setInternal] = useState(defaultChecked);
  const isOn = useMemo(() => (isControlled ? checked : internal), [isControlled, checked, internal]);

  function toggle() {
    if (disabled) return;
    if (!isControlled) setInternal(!isOn);
    onCheckedChange?.(!isOn);
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      disabled={disabled}
      onClick={toggle}
      ref={ref}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 ring-1 ring-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        isOn ? "bg-indigo-500/90" : "bg-slate-800",
        disabled && "opacity-60",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform",
          isOn ? "translate-x-5" : "translate-x-1"
        )}
      />
    </button>
  );
});
