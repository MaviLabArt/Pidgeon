import { addDays, addHours, addMinutes, formatISO, startOfWeek } from "date-fns";
import type { CalendarEvent, EventStatus } from "./types";

const sampleStatus: EventStatus[] = ["scheduled", "draft", "queued", "published", "failed"];

const now = new Date();
const currentWeekStart = startOfWeek(now, { weekStartsOn: 0 });

const iso = (date: Date) => formatISO(date);

const baseMock: CalendarEvent[] = [
  {
    id: "evt_1",
    title: "Rancilio Classe 90 teaser",
    start: "2025-12-10T04:17:00Z",
    end: "2025-12-10T04:47:00Z",
    imageUrl: "/demo/rancilio.jpg",
    caption: "RGBライトで接続情報を確認！",
    tags: ["コーヒー", "カフェ巡り"],
    status: "scheduled",
    timezone: "Asia/Tokyo",
    color: "rose",
  },
  {
    id: "evt_2",
    title: "Weekly product update",
    start: iso(addHours(currentWeekStart, 10)),
    end: iso(addHours(currentWeekStart, 11)),
    caption: "Outline what shipped this week.",
    tags: ["product"],
    status: "scheduled",
    color: "sky",
  },
  {
    id: "evt_3",
    title: "Creator spotlight",
    start: iso(addHours(addDays(currentWeekStart, 1), 14)),
    end: iso(addMinutes(addHours(addDays(currentWeekStart, 1), 14), 45)),
    caption: "Feature of the week.",
    tags: ["social", "video"],
    status: "draft",
    color: "emerald",
    imageUrl: "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?auto=format&fit=crop&w=800&q=60",
  },
  {
    id: "evt_4",
    title: "Release AMA",
    start: iso(addHours(addDays(currentWeekStart, 3), 17)),
    end: iso(addMinutes(addHours(addDays(currentWeekStart, 3), 17), 60)),
    tags: ["community"],
    status: "queued",
    color: "amber",
  },
  {
    id: "evt_5",
    title: "Evergreen repost",
    start: iso(addHours(addDays(currentWeekStart, 5), 8)),
    end: iso(addMinutes(addHours(addDays(currentWeekStart, 5), 8), 30)),
    status: "published",
    color: "violet",
  },
  {
    id: "evt_6",
    title: "Failsafe alert",
    start: iso(addHours(addDays(currentWeekStart, 6), 6)),
    end: iso(addMinutes(addHours(addDays(currentWeekStart, 6), 6), 30)),
    status: "failed",
    color: "red",
  },
];

let mockStore: CalendarEvent[] = [...baseMock];

export function getMockEvents() {
  return mockStore;
}

export function resetMockEvents() {
  mockStore = [...baseMock];
  return mockStore;
}

export function createMockEvent(evt: CalendarEvent) {
  mockStore = [evt, ...mockStore];
  return evt;
}

export function updateMockEvent(id: string, patch: Partial<CalendarEvent>) {
  mockStore = mockStore.map((evt) => (evt.id === id ? { ...evt, ...patch } : evt));
  return mockStore.find((evt) => evt.id === id);
}

export function deleteMockEvent(id: string) {
  mockStore = mockStore.filter((evt) => evt.id !== id);
  return true;
}

export function randomStatus() {
  return sampleStatus[Math.floor(Math.random() * sampleStatus.length)];
}

export function makeMockEvent(partial: Partial<CalendarEvent>): CalendarEvent {
  const start = partial.start ? new Date(partial.start) : now;
  const end = partial.end ? new Date(partial.end) : addMinutes(start, 30);
  return {
    id: `evt_${Math.random().toString(36).slice(2, 8)}`,
    title: partial.title || "Untitled",
    start: iso(start),
    end: iso(end),
    status: partial.status || "draft",
    tags: partial.tags || [],
    caption: partial.caption,
    timezone: partial.timezone,
    imageUrl: partial.imageUrl,
    color: partial.color || "neutral",
  };
}
