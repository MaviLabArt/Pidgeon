export type EventStatus =
  | "draft"
  | "scheduled"
  | "queued"
  | "published"
  | "failed"
  | "posted"
  | "paused"
  | "cancelled"
  | "canceled"
  | "error";

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  noteId?: string;
  dvmEventId?: string;
  timezone?: string;
  imageUrl?: string;
  caption?: string;
  quoteTargetId?: string;
  quoteTargetContent?: string;
  tags?: string[];
  status: EventStatus;
  color?: string; // tailwind color key e.g. "rose"
}

export interface CalendarFilters {
  q: string;
}

export interface CalendarRange {
  start: string;
  end: string;
}

export interface EventMutation extends Partial<CalendarEvent> {
  id?: string;
}
