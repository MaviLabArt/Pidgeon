import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Smile, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const loadEmojiPicker = () => import("@/components/EmojiPicker.jsx");
const LazyEmojiPicker = React.lazy(loadEmojiPicker);

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 768 : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

export default function EmojiPickerButton({
  onSelect,
  title = "Emoji",
  className,
  disabled = false,
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);

  const anchorStyle = useMemo(() => {
    if (!open || !buttonRef.current || typeof window === "undefined") return null;
    const rect = buttonRef.current.getBoundingClientRect();
    const panelWidth = 352;
    const margin = 12;
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - panelWidth - margin);
    const top = Math.min(rect.bottom + 10, window.innerHeight - 420 - margin);
    return { left, top, width: panelWidth };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <Button
        ref={buttonRef}
        variant="outline"
        size="icon"
        className={cn("rounded-xl", className)}
        title={title}
        disabled={disabled}
        onMouseEnter={() => loadEmojiPicker().catch(() => {})}
        onFocus={() => loadEmojiPicker().catch(() => {})}
        onClick={() => setOpen(true)}
      >
        <Smile className="h-4 w-4" />
      </Button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <>
              <div
                className="fixed inset-0 z-50"
                onClick={() => setOpen(false)}
                aria-hidden="true"
              />
              {isMobile ? (
                <div
                  className="fixed inset-x-0 bottom-0 z-50 max-h-[78vh] rounded-t-3xl bg-slate-900 ring-1 ring-white/10 shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <div className="text-sm font-semibold text-white/90">Emoji</div>
                    <button
                      className="rounded-xl p-2 text-white/60 transition hover:bg-white/5 hover:text-white"
                      onClick={() => setOpen(false)}
                      aria-label="Close emoji picker"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="p-2">
                    <Suspense fallback={<div className="h-[420px] w-full animate-pulse rounded-2xl bg-white/5" />}>
                      <LazyEmojiPicker
                        width="100%"
                        height={420}
                        onEmojiClick={(emoji, event) => {
                          event?.stopPropagation?.();
                          if (emoji) onSelect?.(emoji);
                          setOpen(false);
                        }}
                      />
                    </Suspense>
                  </div>
                </div>
              ) : (
                <div
                  className="fixed z-50 overflow-hidden rounded-2xl bg-slate-950 ring-1 ring-white/10 shadow-2xl"
                  style={anchorStyle || undefined}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Suspense fallback={<div className="h-[420px] w-[350px] animate-pulse rounded-2xl bg-white/5" />}>
                    <LazyEmojiPicker
                      width={anchorStyle?.width || 350}
                      height={420}
                      onEmojiClick={(emoji, event) => {
                        event?.stopPropagation?.();
                        if (emoji) onSelect?.(emoji);
                        setOpen(false);
                      }}
                    />
                  </Suspense>
                </div>
              )}
            </>,
            document.body
          )
        : null}
    </>
  );
}
