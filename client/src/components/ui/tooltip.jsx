import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export function Tooltip({ children, content, className }) {
  const [isVisible, setIsVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setIsVisible(false);
      }
    };
    if (isVisible) {
      document.addEventListener("mousedown", handleClickOutside);
      window.addEventListener("blur", () => setIsVisible(false));
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("blur", () => setIsVisible(false));
    };
  }, [isVisible]);

  const open = (e) => {
    e.stopPropagation();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({
        top: rect.top - 10,
        left: rect.left + rect.width / 2,
      });
    }
    setIsVisible((v) => !v);
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <div ref={triggerRef} onClick={open}>
        {children}
      </div>
      {isVisible && (
        <div
          className={cn(
            "fixed z-[9999] -translate-x-1/2 -translate-y-full rounded-xl bg-slate-900 px-3 py-2 text-xs text-white/90 shadow-xl ring-1 ring-white/10",
            className
          )}
          style={{ top: pos.top, left: pos.left }}
        >
          {content}
          <div className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-4 border-transparent border-t-slate-900" />
        </div>
      )}
    </div>
  );
}
