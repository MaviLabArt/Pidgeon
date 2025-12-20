import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Calendar, Clock, Trash2, X } from "lucide-react";
import type { CalendarEvent } from "./types";
import { cn, formatInTimeZone, isCancelledStatus } from "./utils";
import { extractImageUrls, isImageUrl, tokenizeTextWithUrls } from "@/utils/contentUrls.js";

interface EventPreviewProps {
  event: CalendarEvent | null;
  timezone: string;
  anchorRect?: DOMRect | null;
  onClose: () => void;
  onDelete?: (event: CalendarEvent) => void;
  onReschedule?: (event: CalendarEvent) => void;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth <= 768 : false
  );
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

export function EventPreview({
  event,
  timezone,
  anchorRect,
  onClose,
  onDelete,
  onReschedule,
}: EventPreviewProps) {
  const isMobile = useIsMobile();
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const showNoteId = event?.status === "posted" && Boolean(event?.noteId);
  const canMutate = event && event.status !== "posted" && !isCancelledStatus(event.status);
  const canReschedule = Boolean(
    onReschedule &&
      event &&
      (event.status === "scheduled" || event.status === "queued" || event.status === "paused")
  );

  return createPortal(
    <AnimatePresence>
      {event ? (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn(
              "fixed inset-0 z-50 flex justify-center",
              isMobile ? "items-start p-4 pt-16" : "items-center p-6"
            )}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
          >
            <div className="custom-scrollbar w-[min(560px,92vw)] max-h-[90vh] overflow-y-auto rounded-3xl bg-slate-900 text-white shadow-2xl ring-1 ring-white/10">
              <div className="flex items-start justify-between gap-4 border-b border-white/10 px-4 py-3">
                <div>
                  <div className="text-xs uppercase tracking-wide text-white/60">{event.status}</div>
                  <div className="mt-1 flex items-center gap-3 text-sm text-white/70">
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      {formatInTimeZone(event.start, timezone, {
                        month: "short",
                        day: "numeric",
                        weekday: "short",
                      })}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      Scheduled {formatInTimeZone(event.start, timezone, { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close preview"
                  className="rounded-xl p-2 text-white/60 transition hover:bg-white/5 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-3 px-4 py-4">
                <RenderCaption caption={event.caption} primaryImage={event.imageUrl} />
                {event.quoteTargetContent ? (
                  <div className="rounded-3xl bg-slate-950/60 p-4 ring-1 ring-white/10">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-white/50">Quoted note</div>
                    <RenderCaption caption={event.quoteTargetContent} />
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-3 border-t border-white/10 px-4 py-3 md:flex-row md:items-center md:justify-between">
                <div className="flex flex-col gap-2 text-xs text-white/60">
                  <div>Scheduled {formatInTimeZone(event.start, timezone, { dateStyle: "full", timeStyle: "short" })}</div>
                  {showNoteId ? (
                    <div className="grid gap-2">
                      <IdRow label="Note Event ID" value={event.noteId} />
                    </div>
                  ) : null}
                </div>
                {canMutate ? (
                  <div className="flex items-center gap-2 self-start md:self-end">
                    {canReschedule ? (
                      <button
                        className="inline-flex items-center gap-1 rounded-2xl bg-slate-800 px-3 py-2 text-sm font-medium text-white/90 ring-1 ring-white/10 transition hover:bg-slate-700"
                        onClick={() => onReschedule?.(event)}
                      >
                        <Clock className="h-4 w-4" />
                        Reschedule
                      </button>
                    ) : null}
                    <button
                      className="inline-flex items-center gap-1 rounded-2xl bg-red-500/15 px-3 py-2 text-sm font-medium text-red-200 ring-1 ring-red-400/30 transition hover:bg-red-500/20"
                      onClick={() => onDelete?.(event)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}

export default EventPreview;

function copyToClipboard(value: string) {
  if (!value) return;
  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
    return;
  }
  fallbackCopy(value);
}

function fallbackCopy(value: string) {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  } catch {
    // ignore
  }
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-slate-950 px-2 py-1 text-[11px] text-white/80 ring-1 ring-white/10">
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-wide text-white/50">{label}</div>
        <div className="mt-[2px] truncate font-mono text-[11px] text-white" title={value}>
          {value}
        </div>
      </div>
      <button
        className="ml-2 rounded-xl bg-white/10 px-2 py-[3px] text-[10px] font-semibold text-white/80 ring-1 ring-white/10 transition hover:bg-white/15 hover:text-white"
        onClick={() => copyToClipboard(value)}
        title="Copy ID"
      >
        Copy
      </button>
    </div>
  );
}

function RenderCaption({ caption, primaryImage }: { caption?: string; primaryImage?: string }) {
  const lines = (caption || "").split(/\n/);
  const primaryUrl = String(primaryImage || "").trim();
  return (
    <div className="space-y-2">
      {primaryUrl && (
        <div className="overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/20">
          <img src={primaryUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
        </div>
      )}
      <div className="rounded-2xl bg-slate-950 px-3 py-2 text-sm leading-relaxed text-white/90 ring-1 ring-white/10">
        {lines.map((line, lineIdx) => {
          const trimmed = line.trim();
          if (!trimmed) return <div key={`gap-${lineIdx}`} className="h-2" />;
          const tokens = tokenizeTextWithUrls(line);
          const inlineImages = extractImageUrls(line, { limit: 6 }).filter((url) => url !== primaryUrl);
          const standaloneImage =
            tokens.length === 1 &&
            tokens[0]?.type === "url" &&
            isImageUrl(tokens[0]?.value) &&
            trimmed === tokens[0]?.value;

          if (standaloneImage) {
            return (
              <div key={`img-${lineIdx}`} className="overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/20">
                <img src={tokens[0].value} alt="" className="h-full w-full object-contain" loading="lazy" />
              </div>
            );
          }
          return (
            <div key={`line-${lineIdx}`} className="space-y-2">
              <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {tokens.map((token, idx) => {
                  if (!token?.value) return null;
                  if (token.type === "url") {
                    const href = token.value;
                    return (
                      <a
                        key={`${lineIdx}-${idx}`}
                        href={href}
                        className="underline decoration-white/30 underline-offset-4 hover:decoration-white/70"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {href}
                      </a>
                    );
                  }
                  return <span key={`${lineIdx}-${idx}`}>{token.value}</span>;
                })}
              </div>
              {inlineImages.length > 0 && (
                <div className="space-y-2">
                  {inlineImages.map((url) => (
                    <div key={url} className="overflow-hidden rounded-2xl ring-1 ring-white/10 bg-black/20">
                      <img src={url} alt="" className="h-full w-full object-contain" loading="lazy" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
