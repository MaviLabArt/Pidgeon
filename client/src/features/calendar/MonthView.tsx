import React, { useEffect, useMemo, useState } from "react";
import { addDays, addMinutes, eachDayOfInterval, format, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import type { CalendarEvent } from "./types";
import EventCard from "./EventCard";
import { cn, dayKey, toZonedDate } from "./utils";

interface MonthViewProps {
  date: Date;
  timezone: string;
  events: CalendarEvent[];
  onCreateRange: (range: { start: string; end: string }) => void;
  onEventClick: (event: CalendarEvent, rect?: DOMRect) => void;
}

const palette = {
  rose: "bg-rose-400",
  emerald: "bg-emerald-500",
  sky: "bg-indigo-400",
  amber: "bg-amber-500",
  violet: "bg-violet-500",
  red: "bg-red-500",
  neutral: "bg-slate-400",
};

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

export function MonthView({ date, timezone, events, onCreateRange, onEventClick }: MonthViewProps) {
  const monthStart = startOfMonth(date);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const isMobile = useIsMobile();
  const days = useMemo(
    () => eachDayOfInterval({ start: gridStart, end: addDays(gridStart, 6 * 7 - 1) }),
    [gridStart]
  );
  const [drawerDay, setDrawerDay] = useState<Date | null>(null);
  const [drawerEvents, setDrawerEvents] = useState<CalendarEvent[]>([]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    days.forEach((d) => map.set(dayKey(d, timezone), []));
    events.forEach((evt) => {
      const key = dayKey(new Date(evt.start), evt.timezone || timezone);
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(evt);
    });
    map.forEach((list) => list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()));
    return map;
  }, [days, events, timezone]);

  function handleCellCreate(day: Date) {
    const start = startOfDay(toZonedDate(day, timezone));
    start.setHours(9, 0, 0, 0);
    const end = addMinutes(start, 30);
    onCreateRange({ start: start.toISOString(), end: end.toISOString() });
  }

  return (
    <div className="overflow-hidden rounded-3xl bg-slate-900 ring-1 ring-white/10">
      <div className="grid grid-cols-7 border-b border-white/10 bg-slate-950 text-center text-xs font-semibold uppercase tracking-wide text-white/60">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-3">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-white/5">
        {days.map((d, idx) => {
          const key = dayKey(d, timezone);
          const list = eventsByDay.get(key) || [];
          const isCurrentMonth = d.getMonth() === monthStart.getMonth();
          const isToday = dayKey(d, timezone) === dayKey(new Date(), timezone);
          const hasEvents = list.length > 0;

          return (
            <div
              key={idx}
              className={cn(
                "flex flex-col gap-2 bg-slate-900 p-2 text-sm transition-colors hover:bg-slate-800/70",
                isMobile ? "min-h-[80px] md:min-h-[100px]" : "min-h-[140px]",
                !isCurrentMonth && "text-white/30"
              )}
              onClick={() => {
                // On mobile with events, open drawer instead of creating
                if (isMobile && hasEvents) {
                  setDrawerDay(d);
                  setDrawerEvents(list);
                } else {
                  handleCellCreate(d);
                }
              }}
            >
              <div className="flex items-center justify-between">
                <div
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                    isToday ? "bg-indigo-500/90 text-white" : "text-white/80"
                  )}
                >
                  {format(d, "d")}
                </div>
                {!isMobile && list.length > 3 && (
                  <button
                    className="rounded-full bg-white/10 px-2 py-[2px] text-[10px] font-semibold text-white/80 ring-1 ring-white/10 transition hover:bg-white/15"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDrawerDay(d);
                      setDrawerEvents(list);
                    }}
                  >
                    +{list.length - 3}
                  </button>
                )}
              </div>

              {/* Desktop: Show event cards */}
              {!isMobile && (
                <div className="space-y-1.5">
                  {list.slice(0, 3).map((evt) => (
                    <EventCard
                      key={evt.id}
                      event={evt}
                      compact
                      onClick={onEventClick}
                      timeLabel={format(toZonedDate(new Date(evt.start), evt.timezone || timezone), "HH:mm")}
                      className="bg-slate-950/60 ring-1 ring-white/10"
                    />
                  ))}
                </div>
              )}

              {/* Mobile: Show colored dots */}
              {isMobile && list.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                  {list.slice(0, 10).map((evt, i) => {
                    const colorClass = palette[evt.color as keyof typeof palette] || palette.neutral;
                    return (
                      <div
                        key={evt.id || i}
                        className={cn("h-1.5 w-1.5 rounded-full", colorClass)}
                        title={evt.title}
                      />
                    );
                  })}
                  {list.length > 10 && (
                    <span className="text-[10px] text-white/50 font-medium">...</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {drawerDay && drawerEvents.length > 0 && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => {
            setDrawerDay(null);
            setDrawerEvents([]);
          }}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-3xl bg-slate-900 text-white shadow-2xl ring-1 ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-shrink-0 items-center justify-between border-b border-white/10 bg-slate-900 px-4 py-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-white/60">
                  {drawerEvents.length} {drawerEvents.length === 1 ? "event" : "events"}
                </div>
                <div className="font-display text-lg font-semibold text-white">
                  {format(drawerDay, "EEEE, MMM d, yyyy")}
                </div>
              </div>
              <button
                className="rounded-xl p-2 text-white/60 transition hover:bg-white/5 hover:text-white"
                onClick={() => {
                  setDrawerDay(null);
                  setDrawerEvents([]);
                }}
                aria-label="Close"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {drawerEvents.map((evt) => (
                <EventCard
                  key={evt.id}
                  event={evt}
                  compact={false}
                  onClick={(event, rect) => {
                    onEventClick(event, rect);
                    // Don't close the drawer - keep it open
                  }}
                  timeLabel={format(toZonedDate(new Date(evt.start), evt.timezone || timezone), "HH:mm")}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {events.length === 0 && (
        <div className="py-10 text-center text-sm text-white/50">No items this month</div>
      )}
    </div>
  );
}

export default MonthView;
