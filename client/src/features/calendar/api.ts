import api from "@/services/api.js";
import type { CalendarEvent, CalendarFilters, CalendarRange, EventMutation } from "./types";
import { isCancelledStatus } from "./utils";

export async function fetchEvents(range: CalendarRange, filters: CalendarFilters): Promise<CalendarEvent[]> {
  const res = await api.get<CalendarEvent[]>("/events", {
    params: { start: range.start, end: range.end, q: filters.q },
  });
  // Filter out cancelled events at the API level
  return res.data.filter((evt) => !isCancelledStatus(evt.status));
}

export async function createEvent(payload: EventMutation): Promise<CalendarEvent> {
  const res = await api.post<CalendarEvent>("/events", payload);
  return res.data;
}

export async function updateEvent(id: string, payload: EventMutation): Promise<CalendarEvent> {
  const res = await api.patch<CalendarEvent>(`/events/${id}`, payload);
  return res.data;
}

export async function deleteEvent(id: string): Promise<void> {
  await api.delete(`/events/${id}`);
}
