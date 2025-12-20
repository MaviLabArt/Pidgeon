import { addMinutes } from "date-fns";
import type { CalendarEvent } from "./types";
import { isCancelledStatus } from "./utils";
import { parseManualTags } from "@/lib/draft.js";
import { getJobDisplayContent } from "@/utils/repostPreview.js";

export function getDefaultDurationMinutes() {
  const raw = import.meta?.env?.VITE_CALENDAR_BLOCK_MINUTES;
  const val = Number(raw);
  if (!Number.isNaN(val) && val > 0) return val;
  return 30;
}

const statusColorMap: Record<string, string> = {
  scheduled: "sky",
  queued: "amber",
  published: "emerald",
  draft: "neutral",
  failed: "red",
  error: "red",
  canceled: "red",
  cancelled: "red",
  paused: "amber",
  posted: "emerald",
};

function extractNostrTags(tags: any): string[] {
  if (!tags) return [];
  // If tags are Nostr tag tuples, keep only "t" entries (ignore client tags, relays, etc.)
  if (Array.isArray(tags) && tags.every((t) => Array.isArray(t))) {
    return tags.filter((t) => t[0] === "t" && t[1]).map((t) => t[1]);
  }
  // If tags are plain strings, parse as manual tags and drop any "client" markers
  if (Array.isArray(tags)) {
    return tags
      .map((t) => String(t).trim())
      .filter((t) => t && !t.toLowerCase().startsWith("client"))
      .flatMap((t) => parseManualTags(t));
  }
  if (typeof tags === "string") {
    return parseManualTags(tags).filter((t) => !t.toLowerCase().startsWith("client"));
  }
  return [];
}

/**
 * Convert a scheduler job (id, content, scheduledAt, status, tags, etc.) to a CalendarEvent.
 */
export function jobToCalendarEvent(job: any, defaultDurationMinutes = getDefaultDurationMinutes()): CalendarEvent {
  const displayContent = getJobDisplayContent(job);
  const start = job.scheduledAt || job.start || job.createdAt || new Date().toISOString();
  const end =
    job.end ||
    addMinutes(new Date(start), defaultDurationMinutes).toISOString();

  const stableId =
    job.id ||
    job.requestId ||
    job.dvmEventId ||
    job.noteId ||
    job.noteEvent?.id ||
    job.requestEvent?.id ||
    `${start}|${job.content || ""}`; // deterministic fallback to avoid React key thrash/flicker

  return {
    id: stableId,
    noteId: job.noteId || job.note_id || job.noteEvent?.id,
    dvmEventId: job.requestId || job.dvmEventId || job.requestEvent?.id,
    title: job.title || displayContent?.slice(0, 80) || "Untitled",
    caption: displayContent || job.caption,
    start,
    end,
    status: job.status || "scheduled",
    tags: extractNostrTags(job.tags),
    timezone: job.timezone,
    color: job.color || statusColorMap[(job.status || "").toLowerCase()] || "neutral",
    imageUrl: job.imageUrl,
  };
}

export function jobsToCalendarEvents(jobs: any[] = [], defaultDurationMinutes = getDefaultDurationMinutes()) {
  // Filter out cancelled events before converting to calendar events
  return jobs
    .filter((j) => !isCancelledStatus(j.status))
    .map((j) => jobToCalendarEvent(j, defaultDurationMinutes));
}
