export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function toZonedDate(date: Date, timeZone: string) {
  const invDate = new Date(date.toLocaleString("en-US", { timeZone }));
  const diff = invDate.getTime() - date.getTime();
  return new Date(date.getTime() - diff);
}

export function minutesFromMidnight(date: Date, timeZone: string) {
  const zoned = toZonedDate(date, timeZone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

export function formatInTimeZone(
  date: string | Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions
) {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(undefined, { timeZone, ...options }).format(d);
}

export function snapMinutes(value: number, interval = 15) {
  return Math.round(value / interval) * interval;
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function dayKey(date: Date, timeZone: string) {
  const zoned = toZonedDate(date, timeZone);
  // IMPORTANT: avoid `toISOString()` here, since it converts to UTC and can shift the day,
  // which causes events to appear under the wrong day column for non-UTC timezones.
  const y = zoned.getFullYear();
  const m = String(zoned.getMonth() + 1).padStart(2, "0");
  const d = String(zoned.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isCancelledStatus(status?: string | null) {
  const normalized = String(status || "").toLowerCase();
  return normalized === "cancelled" || normalized === "canceled";
}

export const ALL_TIMEZONES: string[] =
  typeof Intl !== "undefined" && "supportedValuesOf" in Intl
    ? // @ts-ignore
      Intl.supportedValuesOf("timeZone")
    : ["UTC"];
