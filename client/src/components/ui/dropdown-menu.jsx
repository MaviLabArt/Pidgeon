import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const DropdownContext = createContext();

export function DropdownMenu({ children }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const contentRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (!open) return;
      if (contentRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <DropdownContext.Provider value={{ open, setOpen, triggerRef, contentRef }}>
      <div className="relative inline-block text-left">{children}</div>
    </DropdownContext.Provider>
  );
}

function useDropdown() {
  const ctx = useContext(DropdownContext);
  if (!ctx) throw new Error("Dropdown components must be used within <DropdownMenu>");
  return ctx;
}

export function DropdownMenuTrigger({ asChild, children, ...props }) {
  const { open, setOpen, triggerRef } = useDropdown();

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      ref: triggerRef,
      onClick: (e) => {
        children.props.onClick?.(e);
        setOpen(!open);
      },
    });
  }

  return (
    <button
      type="button"
      ref={triggerRef}
      onClick={() => setOpen(!open)}
      {...props}
    >
      {children}
    </button>
  );
}

export function DropdownMenuContent({ className, align = "start", children, ...props }) {
  const { open, contentRef } = useDropdown();
  if (!open) return null;
  const alignment = align === "end" ? "right-0" : "left-0";

  return (
    <div
      ref={contentRef}
      className={cn(
        "absolute z-50 mt-2 min-w-[180px] overflow-hidden rounded-2xl bg-slate-900 text-white ring-1 ring-white/10 shadow-xl",
        alignment,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function DropdownMenuLabel({ className, ...props }) {
  return <div className={cn("px-3 py-2 text-xs font-semibold text-white/60", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }) {
  return <div className={cn("my-1 h-px bg-white/10", className)} {...props} />;
}

export function DropdownMenuItem({ className, children, onClick, ...props }) {
  const { setOpen } = useDropdown();
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center px-3 py-2 text-left text-sm text-white/80 hover:bg-white/5 hover:text-white transition-colors duration-150",
        className
      )}
      onClick={(e) => {
        onClick?.(e);
        setOpen(false);
      }}
      {...props}
    >
      {children}
    </button>
  );
}
