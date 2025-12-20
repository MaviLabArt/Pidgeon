import { motion } from "framer-motion";
import { Clock } from "lucide-react";
import type { CalendarEvent } from "./types";
import { cn } from "./utils";

const palette = {
  rose: { bg: "rgba(244, 114, 182, 0.15)", border: "rgba(244, 114, 182, 0.35)" },
  emerald: { bg: "rgba(52, 211, 153, 0.18)", border: "rgba(16, 185, 129, 0.5)" },
  sky: { bg: "rgba(99, 102, 241, 0.16)", border: "rgba(99, 102, 241, 0.45)" },
  amber: { bg: "rgba(245, 158, 11, 0.18)", border: "rgba(234, 179, 8, 0.45)" },
  violet: { bg: "rgba(139, 92, 246, 0.18)", border: "rgba(139, 92, 246, 0.45)" },
  red: { bg: "rgba(239, 68, 68, 0.18)", border: "rgba(239, 68, 68, 0.45)" },
  neutral: { bg: "rgba(148, 163, 184, 0.12)", border: "rgba(100, 116, 139, 0.3)" },
};

export interface EventCardProps {
  event: CalendarEvent;
  compact?: boolean;
  showStatus?: boolean;
  timeLabel?: string;
  onClick?: (event: CalendarEvent, rect?: DOMRect) => void;
  className?: string;
  style?: React.CSSProperties;
  dragging?: boolean;
  resizeStartHandle?: React.ReactNode;
  resizeEndHandle?: React.ReactNode;
}

export function EventCard({
  event,
  compact,
  showStatus = true,
  timeLabel,
  onClick,
  className,
  style,
  dragging,
  resizeStartHandle,
  resizeEndHandle,
}: EventCardProps) {
  const colors = palette[event.color as keyof typeof palette] || palette.neutral;
  const scheduleLabel = timeLabel ? timeLabel : undefined;
  const showThumb = compact && event.imageUrl;

  // Compact mode: vertical stack layout for better mobile/narrow views
  if (compact) {
    return (
      <motion.div
        layout
        onClick={(e) => {
          e.stopPropagation();
          onClick?.(event, (e.currentTarget as HTMLElement).getBoundingClientRect());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.(event, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={event.title}
        className={cn(
          "group relative cursor-pointer overflow-hidden rounded-xl border px-2 py-1.5 text-sm shadow-sm transition-colors hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
          dragging ? "ring-2 ring-indigo-400/60" : "",
          className
        )}
        style={{ background: colors.bg, borderColor: colors.border, ...style }}
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
      >
        {resizeStartHandle}
        {resizeEndHandle}
        <div className="flex flex-col gap-1">
          {/* Time badge - always visible in compact */}
          {scheduleLabel && (
            <div className="inline-flex w-fit items-center gap-1 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-semibold text-white/90 ring-1 ring-white/20 backdrop-blur-sm">
              <Clock className="h-2.5 w-2.5" />
              {scheduleLabel}
            </div>
          )}
          {/* Title with optional thumbnail */}
          <div className="flex items-center gap-1.5">
            {showThumb && (
              <div className="h-4 w-4 flex-shrink-0 overflow-hidden rounded-full ring-1 ring-white/20 shadow-sm bg-black/20">
                <img src={event.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
              </div>
            )}
            <div className="min-w-0 flex-1 truncate text-xs font-semibold text-white/90">
              {event.title}
            </div>
          </div>
          {/* Status badge - hidden on very small screens */}
          {showStatus && (
            <div className="hidden md:block">
              <span className="inline-block rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/80 ring-1 ring-white/20 backdrop-blur-sm">
                {event.status}
              </span>
            </div>
          )}
        </div>
      </motion.div>
    );
  }

  // Expanded mode: keep original horizontal layout
  return (
    <motion.div
      layout
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(event, (e.currentTarget as HTMLElement).getBoundingClientRect());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.(event, (e.currentTarget as HTMLElement).getBoundingClientRect());
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={event.title}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-2xl border px-3 py-2 text-sm shadow-sm transition-colors hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
        dragging ? "ring-2 ring-indigo-400/60" : "",
        className
      )}
      style={{ background: colors.bg, borderColor: colors.border, ...style }}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.99 }}
    >
      {resizeStartHandle}
      {resizeEndHandle}
      <div className="flex items-start gap-2">
        {event.imageUrl && (
          <div className="h-12 w-12 flex-shrink-0 overflow-hidden rounded-xl bg-black/30 ring-1 ring-white/10">
            <img src={event.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-white/70">
            {showStatus && (
              <span className="rounded-full bg-black/45 px-2 py-[2px] text-[11px] uppercase tracking-wide text-white/80 ring-1 ring-white/20 backdrop-blur-sm">
                {event.status}
              </span>
            )}
            {scheduleLabel && (
              <span className="inline-flex items-center gap-1 text-[11px] text-white/80">
                <Clock className="h-3 w-3" />
                {scheduleLabel}
              </span>
            )}
          </div>
          {event.caption && (
            <div className="line-clamp-2 text-[12px] text-white/70">{event.caption}</div>
          )}
          {event.tags && event.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {event.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-black/35 px-2 py-[2px] text-[11px] font-medium text-white/80 ring-1 ring-white/20 backdrop-blur-sm"
                >
                  #{tag}
                </span>
              ))}
              {event.tags.length > 3 && (
                <span className="text-[11px] text-white/50">+{event.tags.length - 3}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

export default EventCard;
