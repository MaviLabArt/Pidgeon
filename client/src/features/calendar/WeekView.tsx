import React, { useEffect, useMemo, useRef, useState } from "react";
import { addDays, differenceInMinutes, format, startOfDay } from "date-fns";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CalendarEvent } from "./types";
import EventCard from "./EventCard";
import { cn, dayKey, minutesFromMidnight, snapMinutes, toZonedDate } from "./utils";

const SLOT_HEIGHT = 48; // px per 15 minutes
const SLOT_MINUTES = 15;
const TOTAL_SLOTS = (24 * 60) / SLOT_MINUTES;
const pxPerMinute = SLOT_HEIGHT / SLOT_MINUTES;
const MIN_EVENT_PX = 32;
const MIN_EVENT_MINUTES = Math.ceil(MIN_EVENT_PX / pxPerMinute);
const TIME_COL_WIDTH_PX = 48;
const DAY_MIN_WIDTH_PX = 180;

interface WeekViewProps {
  date: Date;
  timezone: string;
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent, rect?: DOMRect) => void;
  onCreateRange: (range: { start: string; end: string }) => void;
}

type PositionedEvent = {
  event: CalendarEvent;
  top: number;
  height: number;
  timeLabel: string;
  col: number;
  cols: number;
  startMin: number;
  endMin: number;
};

function layoutDayEvents(dayEvents: CalendarEvent[], fallbackTimezone: string): PositionedEvent[] {
  const prepared = (Array.isArray(dayEvents) ? dayEvents : [])
    .map((evt) => {
      const tz = evt.timezone || fallbackTimezone;
      const start = toZonedDate(new Date(evt.start), tz);
      const end = toZonedDate(new Date(evt.end), tz);

      const startMin = minutesFromMidnight(start, tz);
      const durationMinutes = Math.max(0, differenceInMinutes(end, start));
      const displayDuration = Math.max(durationMinutes, MIN_EVENT_MINUTES);
      const top = startMin * pxPerMinute;
      const height = Math.max(displayDuration * pxPerMinute, MIN_EVENT_PX);
      const endMin = startMin + displayDuration;

      return {
        event: evt,
        top,
        height,
        timeLabel: format(start, "HH:mm"),
        col: 0,
        cols: 1,
        startMin,
        endMin,
      };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const positioned: PositionedEvent[] = [];
  let cluster: PositionedEvent[] = [];
  let active: PositionedEvent[] = [];
  let clusterMaxCols = 1;

  const flushCluster = () => {
    const cols = Math.max(1, clusterMaxCols);
    cluster.forEach((item) => {
      item.cols = cols;
    });
    positioned.push(...cluster);
    cluster = [];
    active = [];
    clusterMaxCols = 1;
  };

  prepared.forEach((item) => {
    active = active.filter((evt) => evt.endMin > item.startMin);
    if (cluster.length && active.length === 0) flushCluster();

    const used = new Set(active.map((evt) => evt.col));
    let col = 0;
    while (used.has(col)) col += 1;
    item.col = col;

    active.push(item);
    cluster.push(item);
    clusterMaxCols = Math.max(clusterMaxCols, active.length);
  });

  if (cluster.length) flushCluster();

  return positioned;
}

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

export function WeekView({ date, timezone, events, onEventClick, onCreateRange }: WeekViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(new Date());
  const isMobile = useIsMobile();
  const [mobileDayOffset, setMobileDayOffset] = useState(0); // For mobile day navigation
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const defaultDurationMinutes = useMemo(() => {
    const raw = import.meta?.env?.VITE_CALENDAR_BLOCK_MINUTES;
    const val = Number(raw);
    if (!Number.isNaN(val) && val > 0) return val;
    return 30;
  }, []);

  const weekStart = useMemo(() => startOfDay(date), [date]);

  // Mobile: show only 1 day, Desktop: show all 7 days
  const days = useMemo(() => {
    if (isMobile) {
      // Show single day based on offset
      return [addDays(weekStart, mobileDayOffset)];
    }
    return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  }, [weekStart, isMobile, mobileDayOffset]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    days.forEach((d) => map.set(dayKey(d, timezone), []));
    events.forEach((evt) => {
      const key = dayKey(new Date(evt.start), evt.timezone || timezone);
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(evt);
    });
    // Sort by start time so later events are last in array (will appear on top due to higher z-index)
    map.forEach((list) => list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()));
    return map;
  }, [days, events, timezone]);

  const virtualizer = useVirtualizer({
    count: TOTAL_SLOTS,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SLOT_HEIGHT,
    overscan: 6,
  });
  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  // Reset mobile day offset when week changes
  useEffect(() => {
    setMobileDayOffset(0);
  }, [weekStart]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const minutes = minutesFromMidnight(new Date(), timezone);
    const y = minutes * pxPerMinute - 200;
    el.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }, [timezone]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Track horizontal scroll position for scroll indicators and sync header
  useEffect(() => {
    if (isMobile) return;

    const handleScroll = () => {
      const el = scrollRef.current;
      const header = headerRef.current;
      if (!el) return;

      const { scrollLeft, scrollWidth, clientWidth } = el;
      setCanScrollLeft(scrollLeft > 10);
      setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);

      // Sync header horizontal scroll with content
      if (header) {
        header.scrollLeft = scrollLeft;
      }
    };

    const el = scrollRef.current;
    if (el) {
      handleScroll(); // Initial check
      el.addEventListener('scroll', handleScroll);
      return () => el.removeEventListener('scroll', handleScroll);
    }
  }, [isMobile]);

  const scrollHorizontal = (direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollAmount = 200;
    el.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    });
  };

  const todayKey = dayKey(now, timezone);
  const nowMinutes = minutesFromMidnight(now, timezone);
  const nowOffset = nowMinutes * pxPerMinute;

  const canGoPrevDay = mobileDayOffset > 0;
  const canGoNextDay = mobileDayOffset < 6;

  return (
    <div className="overflow-hidden rounded-3xl bg-slate-900 ring-1 ring-white/10">
      {/* Header with day labels and mobile navigation */}
      <div className="sticky top-0 z-10 border-b border-white/10 bg-slate-900">
        {isMobile && (
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <button
              onClick={() => setMobileDayOffset((prev) => Math.max(0, prev - 1))}
              disabled={!canGoPrevDay}
              className={cn(
                "ps-cal-nav rounded-lg p-2 transition",
                canGoPrevDay
                  ? "text-white/80 hover:bg-white/5"
                  : "text-white/30 cursor-not-allowed"
              )}
              aria-label="Previous day"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="text-center">
              <div className="font-display text-sm font-semibold text-white">
                {format(days[0], "EEEE")}
              </div>
              <div className="text-xs text-white/60">{format(days[0], "MMM d, yyyy")}</div>
            </div>
            <button
              onClick={() => setMobileDayOffset((prev) => Math.min(6, prev + 1))}
              disabled={!canGoNextDay}
              className={cn(
                "ps-cal-nav rounded-lg p-2 transition",
                canGoNextDay
                  ? "text-white/80 hover:bg-white/5"
                  : "text-white/30 cursor-not-allowed"
              )}
              aria-label="Next day"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>
        )}
        <div
          ref={headerRef}
          className={cn(
            "grid items-center gap-0 py-3 text-xs font-medium text-white/60 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            isMobile
              ? "grid-cols-[48px_1fr]"
              : "grid-cols-[48px_repeat(7,minmax(180px,1fr))]"
          )}
        >
          <div className="text-center text-[11px] uppercase tracking-wide text-white/30"></div>
          {!isMobile &&
            days.map((d, idx) => {
              const isToday = dayKey(d, timezone) === todayKey;
              return (
                <div key={idx} className="flex items-center justify-between px-2 border-l border-white/10">
                  <div className="text-white/60">{format(d, "EEE")}</div>
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
                      isToday ? "bg-indigo-500/90 text-white" : "text-white/80"
                    )}
                  >
                    {format(d, "d")}
                  </div>
                </div>
              );
            })}
          {isMobile && (
            <div className="flex items-center justify-center">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
                  dayKey(days[0], timezone) === todayKey
                    ? "bg-indigo-500/90 text-white"
                    : "text-white/80"
                )}
              >
                {format(days[0], "d")}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="relative h-[calc(100vh-240px)]">
        {/* Horizontal scroll indicators - desktop only */}
        {!isMobile && canScrollLeft && (
          <button
            onClick={() => scrollHorizontal('left')}
            className="absolute left-14 top-1/2 z-20 -translate-y-1/2 rounded-full bg-slate-900/90 p-2 text-white ring-1 ring-white/10 shadow-lg transition hover:bg-slate-800 active:translate-y-px"
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {!isMobile && canScrollRight && (
          <button
            onClick={() => scrollHorizontal('right')}
            className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-full bg-slate-900/90 p-2 text-white ring-1 ring-white/10 shadow-lg transition hover:bg-slate-800 active:translate-y-px"
            aria-label="Scroll right"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}

        <div
          ref={scrollRef}
          className={cn(
            "custom-scrollbar absolute inset-0 overflow-y-auto",
            !isMobile && "overflow-x-auto" // Enable horizontal scroll on desktop
          )}
        >
          <div style={{ height: totalHeight }} className="relative">
            {/* Time column - fixed width, reduced from 64px to 48px */}
            <div className="absolute left-0 top-0 w-12 z-10">
              {items.map((row) => {
                const minutes = row.index * SLOT_MINUTES;
                const label = row.index % 4 === 0 ? `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00` : "";
                return (
                  <div
                    key={row.key}
                    className="absolute left-0 right-0 flex items-start justify-end pr-1.5 text-[12px] font-medium text-white/50"
                    style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                  >
                    {label}
                  </div>
                );
              })}
            </div>

            <div
              ref={gridRef}
              className="absolute left-12 top-0"
              style={{
                right: 0,
                minWidth: isMobile ? undefined : `${DAY_MIN_WIDTH_PX * days.length}px`,
              }}
            >
              {/* Time grid */}
              <div className="absolute inset-0" aria-hidden style={{ height: totalHeight }}>
                {items.map((row) => (
                  <div
                    key={row.key}
                    className="absolute left-0 right-0 border-b border-white/10"
                    style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                  />
                ))}
              </div>

              <div
                className={cn(
                  "absolute inset-0 grid h-full gap-0",
                  isMobile ? "grid-cols-1" : "grid-cols-7"
                )}
                style={{ height: totalHeight }}
              >
                {days.map((day, dayIndex) => {
                  const dayEvents = eventsByDay.get(dayKey(day, timezone)) || [];
                  const isToday = dayKey(day, timezone) === todayKey;
                  const positionedEvents = layoutDayEvents(dayEvents, timezone);
                  const handleDayClick = (e: React.MouseEvent) => {
                    // Ignore clicks on existing events
                    if ((e.target as HTMLElement).closest("[data-event-block]")) return;
                    if (!scrollRef.current) return;
                    const containerRect = scrollRef.current.getBoundingClientRect();
                    const y = e.clientY - containerRect.top + scrollRef.current.scrollTop;
                    const minutes = snapMinutes(y / pxPerMinute, SLOT_MINUTES);
                    const start = addDays(startOfDay(toZonedDate(day, timezone)), 0);
                    start.setMinutes(minutes);
                    const end = new Date(start.getTime() + defaultDurationMinutes * 60 * 1000);
                    onCreateRange({ start: start.toISOString(), end: end.toISOString() });
                  };
                  return (
                    <div
                      key={dayIndex}
                      className="relative border-l border-white/10 bg-slate-900 transition-colors hover:bg-slate-800/30"
                      onClick={handleDayClick}
                    >
                      {isToday && nowOffset <= totalHeight && (
                        <div
                          className="pointer-events-none absolute left-0 right-0 z-50 flex items-center gap-2"
                          style={{ top: nowOffset }}
                        >
                          <div className="h-[2px] w-full bg-amber-500" />
                          <div className="rounded-full bg-amber-500 px-2 py-[2px] text-[10px] font-semibold text-white shadow">
                            Now
                          </div>
                        </div>
                      )}
                      <div className="absolute inset-y-0 inset-x-[6px]">
                        {positionedEvents.map((pos, eventIndex) => {
                          const cols = Math.max(1, pos.cols);
                          const col = Math.max(0, pos.col);
                          const columnGap = 6; // px
                          const width =
                            cols === 1 ? "100%" : `calc((100% - ${(cols - 1) * columnGap}px) / ${cols})`;
                          const left =
                            cols === 1
                              ? "0px"
                              : `calc(${col} * (((100% - ${(cols - 1) * columnGap}px) / ${cols}) + ${columnGap}px))`;
                          return (
                            <div
                              key={pos.event.id}
                              className="absolute"
                              style={{
                                top: pos.top,
                                height: pos.height,
                                width,
                                left,
                                zIndex: 20 + eventIndex,
                              }}
                              data-event-block
                            >
                              <EventCard
                                event={pos.event}
                                timeLabel={pos.timeLabel}
                                compact
                                className="h-full"
                                onClick={(event, rect) => {
                                  onEventClick(event, rect);
                                }}
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default WeekView;
