import React, { forwardRef } from "react";
import { cn } from "@/lib/utils";

const variantStyles = {
  default:
    "bg-indigo-500/90 text-white ring-1 ring-white/10 hover:bg-indigo-500 active:translate-y-px",
  secondary:
    "bg-slate-900 text-white/90 ring-1 ring-white/10 hover:bg-slate-800 hover:ring-white/20 active:translate-y-px",
  draft:
    "bg-amber-500/30 text-white/90 ring-1 ring-white/10 hover:bg-amber-500/40 hover:ring-white/20 active:translate-y-px",
  outline:
    "bg-transparent text-white/80 ring-1 ring-white/15 hover:bg-white/5 hover:text-white active:translate-y-px",
  ghost:
    "bg-transparent text-white/70 hover:bg-white/5 hover:text-white active:translate-y-px",
  destructive:
    "bg-red-500/90 text-white ring-1 ring-white/10 hover:bg-red-500 active:translate-y-px",
};

const sizeStyles = {
  default: "h-10 px-4 py-2 text-sm",
  sm: "h-9 px-3 text-xs",
  lg: "h-11 px-6 text-sm rounded-2xl",
  icon: "h-9 w-9",
};

export const Button = forwardRef(function Button(
  {
    className,
    variant = "default",
    size = "default",
    asChild,
    loading = false,
    busyText = "Loading…",
    showDots = true,
    disabled,
    children,
    ...props
  },
  ref
) {
  const Comp = asChild ? "span" : "button";
  const isDisabled = Boolean(disabled || loading);
  const ariaLabel = props["aria-label"];
  return (
    <Comp
      ref={ref}
      aria-busy={loading || undefined}
      aria-live={loading ? "polite" : undefined}
      aria-label={loading ? busyText : ariaLabel}
      disabled={!asChild ? isDisabled : undefined}
      aria-disabled={asChild ? isDisabled : undefined}
      className={cn(
        "relative inline-flex select-none items-center justify-center gap-2 rounded-xl font-semibold transition-[transform,background-color,border-color,color,opacity,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50",
        loading && "btn-loading cursor-not-allowed opacity-90",
        variantStyles[variant] || variantStyles.default,
        sizeStyles[size] || sizeStyles.default,
        className
      )}
      {...props}
    >
      <span className={cn(loading ? "opacity-0" : "opacity-100 transition-opacity")}>
        {children}
      </span>
      {loading && showDots ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <span className="inline-flex items-center">
            <span className="ps-loading-dot mx-0.5 h-1.5 w-1.5 rounded-full bg-current" />
            <span className="ps-loading-dot mx-0.5 h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: "120ms" }} />
            <span className="ps-loading-dot mx-0.5 h-1.5 w-1.5 rounded-full bg-current" style={{ animationDelay: "240ms" }} />
          </span>
        </span>
      ) : null}
    </Comp>
  );
});
