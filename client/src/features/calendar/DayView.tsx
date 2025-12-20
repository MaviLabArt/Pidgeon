import React, { useEffect, useMemo, useRef, useState } from "react";
import { differenceInMinutes, format, startOfDay } from "date-fns";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CalendarEvent } from "./types";
import EventCard from "./EventCard";
import { cn, dayKey, minutesFromMidnight, snapMinutes, toZonedDate } from "./utils";

const SLOT_HEIGHT = 48; // px per 15 minutes
const SLOT_MINUTES = 15;
const TOTAL_SLOTS = (24 * 60) / SLOT_MINUTES;
const pxPerMinute = SLOT_HEIGHT / SLOT_MINUTES;
const MIN_EVENT_PX = 32;
const MIN_EVENT_MINUTES = Math.ceil(MIN_EVENT_PX / pxPerMinute);

interface DayViewProps {
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

export function DayView({ date, timezone, events, onEventClick, onCreateRange }: DayViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(new Date());

  const defaultDurationMinutes = useMemo(() => {
    const raw = import.meta?.env?.VITE_CALENDAR_BLOCK_MINUTES;
    const val = Number(raw);
    if (!Number.isNaN(val) && val > 0) return val;
    return 30;
  }, []);

  const day = useMemo(() => startOfDay(date), [date]);
  const dayId = useMemo(() => dayKey(day, timezone), [day, timezone]);
  const todayId = useMemo(() => dayKey(now, timezone), [now, timezone]);
  const isToday = dayId === todayId;

  const dayEvents = useMemo(() => {
    const list = (Array.isArray(events) ? events : []).filter((evt) => {
      const tz = evt.timezone || timezone;
      return dayKey(new Date(evt.start), tz) === dayId;
    });
    list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return list;
  }, [events, timezone, dayId]);

  const positionedEvents = useMemo(() => layoutDayEvents(dayEvents, timezone), [dayEvents, timezone]);

  const virtualizer = useVirtualizer({
    count: TOTAL_SLOTS,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SLOT_HEIGHT,
    overscan: 6,
  });
  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const focusMinutes = isToday ? minutesFromMidnight(new Date(), timezone) : 9 * 60;
    const y = focusMinutes * pxPerMinute - 200;
    el.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }, [timezone, dayId, isToday]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  const nowMinutes = minutesFromMidnight(now, timezone);
  const nowOffset = nowMinutes * pxPerMinute;

  const handleDayClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-event-block]")) return;
    if (!scrollRef.current) return;
    const containerRect = scrollRef.current.getBoundingClientRect();
    const y = e.clientY - containerRect.top + scrollRef.current.scrollTop;
    const minutes = snapMinutes(y / pxPerMinute, SLOT_MINUTES);
    const start = startOfDay(toZonedDate(day, timezone));
    start.setMinutes(minutes);
    const end = new Date(start.getTime() + defaultDurationMinutes * 60 * 1000);
    onCreateRange({ start: start.toISOString(), end: end.toISOString() });
  };

  return (
    <div className="overflow-hidden rounded-3xl bg-slate-900 ring-1 ring-white/10">
      <div className="sticky top-0 z-10 border-b border-white/10 bg-slate-900">
        <div className="grid grid-cols-[48px_1fr] items-center gap-0 py-3 text-xs font-medium text-white/60">
          <div className="text-center text-[11px] uppercase tracking-wide text-white/30"></div>
          <div className="flex items-center justify-between px-2 border-l border-white/10">
            <div className="text-white/60">{format(day, "EEE")}</div>
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold",
                isToday ? "bg-indigo-500/90 text-white" : "text-white/80"
              )}
            >
              {format(day, "d")}
            </div>
          </div>
        </div>
      </div>

      <div className="relative h-[calc(100vh-240px)]">
        <div ref={scrollRef} className="custom-scrollbar absolute inset-0 overflow-y-auto">
          <div style={{ height: totalHeight }} className="relative">
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

            <div ref={gridRef} className="absolute left-12 top-0 right-0">
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
                className="absolute inset-0 h-full border-l border-white/10 bg-slate-900 transition-colors hover:bg-slate-800/30"
                onClick={handleDayClick}
                style={{ height: totalHeight }}
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DayView;

