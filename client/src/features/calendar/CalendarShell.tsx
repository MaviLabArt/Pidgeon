import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  addDays,
  addMonths,
  addWeeks,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ChevronLeft, ChevronRight, Search, Calendar as CalendarIcon } from "lucide-react";
import WeekView from "./WeekView";
import DayView from "./DayView";
import MonthView from "./MonthView";
import EventPreview from "./EventPreview";
import EventComposer from "./EventComposer";
import { createEvent, deleteEvent, fetchEvents, updateEvent } from "./api";
import type { CalendarEvent, CalendarFilters } from "./types";
import { cn, isCancelledStatus } from "./utils";

type ViewMode = "week" | "month" | "day";

interface CalendarShellProps {
  events?: CalendarEvent[];
  loading?: boolean;
  error?: string | null;
  onRangeChange?: (range: { start: string; end: string }) => void;
  onCreateEvent?: (payload: Partial<CalendarEvent>) => Promise<CalendarEvent> | CalendarEvent;
  onUpdateEvent?: (id: string, patch: Partial<CalendarEvent>) => Promise<CalendarEvent> | CalendarEvent;
  onDeleteEvent?: (event: CalendarEvent) => Promise<void> | void;
  pubkey?: string;
  nip96Service?: string;
  uploadBackend?: string;
  blossomServers?: string;
  uploads?: Array<{ file: File; name: string; progress: number; cancel?: () => void }>;
  onUploadStart?: (file: File, cancel: () => void) => void;
  onUploadProgress?: (file: File, progress: number) => void;
  onUploadEnd?: (file: File) => void;
  onUploadSuccess?: (result: { url: string; tags: string[] }) => void;
  onUploadError?: (error: string) => void;
}

function useDebouncedValue<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function formatRangeLabel(view: ViewMode, date: Date) {
  if (view === "month") return format(date, "LLLL yyyy");
  if (view === "day") return format(date, "LLLL d, yyyy");
  const start = startOfDay(date);
  const end = addDays(start, 6);
  return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
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

export function CalendarShell({
  events: controlledEvents,
  loading: controlledLoading,
  error: controlledError,
  onRangeChange,
  onCreateEvent,
  onUpdateEvent,
  onDeleteEvent,
  pubkey,
  nip96Service,
  uploadBackend,
  blossomServers,
  uploads = [],
  onUploadStart,
  onUploadProgress,
  onUploadEnd,
  onUploadSuccess,
  onUploadError,
}: CalendarShellProps) {
  const isMobile = useIsMobile();
  const calendarMobileViewKey = "pidgeon.calendar.mobileView";
  // Default to Day on mobile, Week on desktop
  const [view, setView] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "week";
    if (window.innerWidth >= 768) return "week";
    try {
      const saved = localStorage.getItem(calendarMobileViewKey);
      if (saved === "month" || saved === "day") return saved;
    } catch {}
    return "day";
  });
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [desktopWeekAnchor, setDesktopWeekAnchor] = useState(() => new Date());
  const prevIsMobileRef = useRef<boolean>(false);
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    []
  );
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const filters: CalendarFilters = useMemo(() => ({ tags: [], q: debouncedSearch }), [debouncedSearch]);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [composerRange, setComposerRange] = useState<{ start: Date; end: Date } | null>(null);
  const [toast, setToast] = useState("");

  const range = useMemo(() => {
    if (view === "week") {
      const start = startOfDay(currentDate);
      const end = endOfDay(addDays(start, 6));
      return { start: start.toISOString(), end: end.toISOString() };
    }
    if (view === "day") {
      const start = startOfDay(currentDate);
      const end = endOfDay(start);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    const start = startOfWeek(startOfMonth(currentDate), { weekStartsOn: 0 });
    const end = endOfWeek(endOfMonth(currentDate), { weekStartsOn: 0 });
    return { start: start.toISOString(), end: end.toISOString() };
  }, [view, currentDate]);

  useEffect(() => {
    onRangeChange?.(range);
  }, [range.start, range.end, onRangeChange]);

  const isControlled = Array.isArray(controlledEvents);

  useEffect(() => {
    if (isControlled) return;
    let cancelled = false;
    setLoading(true);
    fetchEvents(range, filters)
      .then((data) => {
        if (cancelled) return;
        // Double-check: filter out cancelled events
        const filteredData = data.filter((evt) => !isCancelledStatus(evt.status));
        setEvents(filteredData);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load events");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range.start, range.end, filters, isControlled]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  // Track the last desktop Week anchor so mobile day navigation doesn't change desktop Week on resize.
  useEffect(() => {
    if (!isMobile && view === "week") setDesktopWeekAnchor(currentDate);
  }, [isMobile, view, currentDate]);

  // Keep Day view mobile-only; restore Week anchor when returning to desktop.
  useEffect(() => {
    const prevIsMobile = prevIsMobileRef.current;
    prevIsMobileRef.current = isMobile;

    if (isMobile) {
      if (view === "week") setView("day");
      return;
    }

    if (prevIsMobile && !isMobile && view === "day") {
      setView("week");
      setCurrentDate(desktopWeekAnchor);
      return;
    }

    if (view === "day") setView("week");
  }, [isMobile, view, desktopWeekAnchor]);

  useEffect(() => {
    if (!isMobile) return;
    if (view === "day" || view === "month") {
      try {
        localStorage.setItem(calendarMobileViewKey, view);
      } catch {}
    }
  }, [isMobile, view]);

  const rangeStart = useMemo(() => new Date(range.start), [range.start]);
  const rangeEnd = useMemo(() => new Date(range.end), [range.end]);

  const visibleEvents = useMemo(() => {
    const baseEvents = isControlled ? controlledEvents || [] : events;
    return baseEvents.filter((evt) => {
      // CRITICAL: Filter out cancelled events first
      if (isCancelledStatus(evt.status)) return false;

      const evtStart = new Date(evt.start);
      const evtEnd = new Date(evt.end || evt.start);
      // Proper interval intersection (covers events that fully wrap the range too).
      const inRange = evtStart <= rangeEnd && evtEnd >= rangeStart;
      if (!inRange) return false;

      const matchesSearch =
        !filters.q ||
        evt.title.toLowerCase().includes(filters.q.toLowerCase()) ||
        (evt.caption || "").toLowerCase().includes(filters.q.toLowerCase());
      return matchesSearch;
    });
  }, [events, controlledEvents, filters, rangeStart, rangeEnd, isControlled]);

  // Update selected event when events change to reflect real-time updates
  useEffect(() => {
    if (!selectedEvent) return;
    const baseEvents = isControlled ? controlledEvents || [] : events;
    const updatedEvent = baseEvents.find((evt) => evt.id === selectedEvent.id);
    if (updatedEvent && JSON.stringify(updatedEvent) !== JSON.stringify(selectedEvent)) {
      setSelectedEvent(updatedEvent);
    }
  }, [events, controlledEvents, selectedEvent, isControlled]);

  async function handleUpdateEvent(id: string, patch: Partial<CalendarEvent>) {
    try {
      if (isControlled && onUpdateEvent) {
        await onUpdateEvent(id, patch);
        setToast("Updated");
        return;
      }
      if (isControlled) return;
      setEvents((prev) => prev.map((evt) => (evt.id === id ? { ...evt, ...patch } : evt)));
      const saved = await updateEvent(id, patch);
      setEvents((prev) => prev.map((evt) => (evt.id === id ? saved : evt)));
      setToast("Updated");
    } catch (err: any) {
      setToast(err?.message || "Update failed");
    }
  }

  async function handleCreate(range: { start: string; end: string }) {
    setComposerRange({ start: new Date(range.start), end: new Date(range.end) });
  }

  async function handleSaveNew(payload: Partial<CalendarEvent>) {
    try {
      if (isControlled && onCreateEvent) {
        await onCreateEvent(payload);
        setToast("Created");
      } else if (!isControlled) {
        const saved = await createEvent(payload);
        setEvents((prev) => [saved, ...prev]);
        setToast("Created");
      }
    } catch (err: any) {
      setToast(err?.message || "Create failed");
    } finally {
      setComposerRange(null);
    }
  }

  async function handleDelete(evt: CalendarEvent) {
    try {
      if (isControlled && onDeleteEvent) {
        await onDeleteEvent(evt);
      } else if (!isControlled) {
        setEvents((prev) => prev.filter((e) => e.id !== evt.id));
        await deleteEvent(evt.id);
      }
      setToast("Deleted");
    } catch (err: any) {
      setToast(err?.message || "Delete failed");
    }
    setSelectedEvent(null);
  }

  return (
    <div className="w-full h-full">
      <div className="flex flex-col h-full gap-4">
        <div className="sticky top-0 z-20 rounded-3xl bg-slate-900/80 backdrop-blur p-3 ring-1 ring-white/10">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1">
              <button
                className="rounded-xl bg-slate-900 p-2 text-white/80 ring-1 ring-white/10 transition hover:text-white hover:ring-indigo-400/60 active:translate-y-px"
                onClick={() =>
                  setCurrentDate((d) =>
                    view === "week" ? addWeeks(d, -1) : view === "day" ? addDays(d, -1) : addMonths(d, -1)
                  )
                }
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                className="rounded-xl bg-slate-900 p-2 text-white/80 ring-1 ring-white/10 transition hover:text-white hover:ring-indigo-400/60 active:translate-y-px"
                onClick={() =>
                  setCurrentDate((d) =>
                    view === "week" ? addWeeks(d, 1) : view === "day" ? addDays(d, 1) : addMonths(d, 1)
                  )
                }
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                className="rounded-xl bg-indigo-500/90 px-3 py-1.5 text-xs font-semibold text-white ring-1 ring-white/10 transition hover:bg-indigo-500 active:translate-y-px"
                onClick={() => setCurrentDate(new Date())}
              >
                Today
              </button>
              {/* Expanded month/year label on mobile */}
              <div className={cn(
                "flex items-center gap-2 rounded-2xl bg-slate-950 px-3 py-2 font-semibold text-white ring-1 ring-white/10",
                isMobile ? "ml-0 flex-1 justify-center text-sm" : "ml-2 text-sm"
              )}>
                <CalendarIcon className="h-4 w-4 text-white/70" />
                {formatRangeLabel(view, currentDate)}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* Hide search bar on mobile */}
              {!isMobile && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search"
                    className="w-32 rounded-2xl bg-slate-950 pl-9 pr-3 py-2 text-sm text-white placeholder:text-white/40 ring-1 ring-white/10 outline-none focus:ring-2 focus:ring-indigo-400 md:w-40"
                  />
                </div>
              )}
              {/* Desktop view toggle (Week/Month) */}
              {!isMobile && (
                <div className="flex items-center gap-1 rounded-2xl bg-slate-900 p-1 text-sm ring-1 ring-white/10">
                  <button
                    className={cn(
                      "rounded-xl px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 md:px-3 md:text-sm",
                      view === "week" ? "bg-indigo-500/90 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
                    )}
                    onClick={() => setView("week")}
                  >
                    Week
                  </button>
                  <button
                    className={cn(
                      "rounded-xl px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 md:px-3 md:text-sm",
                      view === "month" ? "bg-indigo-500/90 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
                    )}
                    onClick={() => setView("month")}
                  >
                    Month
                  </button>
                </div>
              )}
              {/* Mobile view toggle (Day/Month) */}
              {isMobile && (
                <div className="flex items-center gap-1 rounded-2xl bg-slate-900 p-1 text-sm ring-1 ring-white/10">
                  <button
                    className={cn(
                      "rounded-xl px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
                      view === "day" ? "bg-indigo-500/90 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
                    )}
                    onClick={() => setView("day")}
                  >
                    Day
                  </button>
                  <button
                    className={cn(
                      "rounded-xl px-2.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400",
                      view === "month" ? "bg-indigo-500/90 text-white" : "text-white/70 hover:bg-white/5 hover:text-white"
                    )}
                    onClick={() => setView("month")}
                  >
                    Month
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-white/60">
            {(controlledError || error) && <span className="text-red-300">{controlledError || error}</span>}
            {(controlledLoading || loading) && <span className="text-xs text-white/50">Loading…</span>}
          </div>
        </div>

        {view === "week" ? (
          <WeekView
            date={currentDate}
            timezone={timezone}
            events={visibleEvents}
            onEventClick={(evt, rect) => {
              setSelectedEvent(evt);
              setAnchorRect(rect || null);
            }}
            onCreateRange={handleCreate}
          />
        ) : view === "day" ? (
          <DayView
            date={currentDate}
            timezone={timezone}
            events={visibleEvents}
            onEventClick={(evt, rect) => {
              setSelectedEvent(evt);
              setAnchorRect(rect || null);
            }}
            onCreateRange={handleCreate}
          />
        ) : (
          <MonthView
            date={currentDate}
            timezone={timezone}
            events={visibleEvents}
            onEventClick={(evt, rect) => {
              setSelectedEvent(evt);
              setAnchorRect(rect || null);
            }}
            onCreateRange={handleCreate}
          />
        )}
      </div>

      <EventPreview
        event={selectedEvent}
        timezone={timezone}
        anchorRect={anchorRect}
        onClose={() => setSelectedEvent(null)}
        onDelete={handleDelete}
      />

      <EventComposer
        open={Boolean(composerRange)}
        start={composerRange?.start || new Date()}
        end={composerRange?.end || new Date()}
        timezone={timezone}
        onClose={() => setComposerRange(null)}
        onSave={handleSaveNew}
        pubkey={pubkey}
        nip96Service={nip96Service}
        uploadBackend={uploadBackend}
        blossomServers={blossomServers}
        uploads={uploads}
        onUploadStart={onUploadStart}
        onUploadProgress={onUploadProgress}
        onUploadEnd={onUploadEnd}
        onUploadSuccess={onUploadSuccess}
        onUploadError={onUploadError}
      />

      <AnimatePresence>
        {toast && (
          <motion.div
            className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white ring-1 ring-white/10 shadow-lg"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default CalendarShell;
