const WEEKDAY_INDEX = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const NUMBER_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function normalizeText(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeNow(d) {
  const now = d instanceof Date ? d : new Date();
  return Number.isNaN(now.getTime()) ? new Date() : now;
}

function clampInt(val, min, max) {
  const n = Math.floor(Number(val));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function addMonthsClamped(date, months) {
  const base = new Date(date);
  if (!Number.isFinite(months) || months === 0) return base;
  const day = base.getDate();
  const hours = base.getHours();
  const minutes = base.getMinutes();
  const seconds = base.getSeconds();
  const ms = base.getMilliseconds();
  base.setDate(1);
  base.setMonth(base.getMonth() + months);
  const maxDay = daysInMonth(base.getFullYear(), base.getMonth());
  base.setDate(Math.min(day, maxDay));
  base.setHours(hours, minutes, seconds, ms);
  return base;
}

function addYearsClamped(date, years) {
  const base = new Date(date);
  if (!Number.isFinite(years) || years === 0) return base;
  return addMonthsClamped(base, years * 12);
}

function parseNumberToken(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  if (t === "a" || t === "an") return 1;
  if (t === "couple") return 2;
  if (t === "few") return 3;
  if (t === "half") return 0.5;
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, t)) return NUMBER_WORDS[t];
  return null;
}

function parseUnitToken(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;

  const normalized = t.replace(/\.$/, "");
  if (["y", "yr", "yrs", "year", "years"].includes(normalized)) return "year";
  if (["mo", "mos", "month", "months"].includes(normalized)) return "month";
  if (["w", "wk", "wks", "week", "weeks"].includes(normalized)) return "week";
  if (["d", "day", "days"].includes(normalized)) return "day";
  if (["h", "hr", "hrs", "hour", "hours"].includes(normalized)) return "hour";
  if (["m", "min", "mins", "minute", "minutes"].includes(normalized)) return "minute";
  if (["s", "sec", "secs", "second", "seconds"].includes(normalized)) return "second";
  return null;
}

function splitNumberUnitToken(token) {
  const raw = String(token || "").trim().toLowerCase();
  if (!raw) return null;
  const matches = raw.matchAll(/(\d+(?:\.\d+)?)([a-z]+)/g);
  const out = [];
  for (const m of matches) {
    const qty = Number(m[1]);
    const unit = parseUnitToken(m[2]);
    if (!Number.isFinite(qty) || !unit) continue;
    out.push({ qty, unit });
  }
  return out.length ? out : null;
}

function parseDuration(text) {
  const cleaned = normalizeText(text)
    .replace(/^\+/, "")
    .replace(/^in\s+/, "")
    .replace(/-/g, " ");
  if (!cleaned) return null;

  const tokens = cleaned
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);

  let years = 0;
  let months = 0;
  let ms = 0;
  let matched = false;
  let lastUnit = null;

  const addByUnit = (qty, unit) => {
    if (!Number.isFinite(qty) || qty === 0) return;
    matched = true;
    lastUnit = unit;
    if (unit === "year") years += qty;
    else if (unit === "month") months += qty;
    else if (unit === "week") ms += qty * 7 * 24 * 60 * 60 * 1000;
    else if (unit === "day") ms += qty * 24 * 60 * 60 * 1000;
    else if (unit === "hour") ms += qty * 60 * 60 * 1000;
    else if (unit === "minute") ms += qty * 60 * 1000;
    else if (unit === "second") ms += qty * 1000;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "and" || token === "after" || token === "later" || token === "from") continue;

    const compactPairs = splitNumberUnitToken(token);
    if (compactPairs) {
      for (const p of compactPairs) addByUnit(p.qty, p.unit);
      continue;
    }

    const qty = parseNumberToken(token);
    if (qty === null) {
      // Support: "an hour and a half"
      if (
        lastUnit &&
        token === "half"
      ) {
        addByUnit(0.5, lastUnit);
      }
      continue;
    }

    // Support: "one and a half hours"
    let nextQty = qty;
    if (
      tokens[i + 1] === "and" &&
      (tokens[i + 2] === "a" || tokens[i + 2] === "an") &&
      tokens[i + 3] === "half"
    ) {
      nextQty += 0.5;
      i += 3;
    }

    const unitToken = tokens[i + 1] || "";
    const unit = parseUnitToken(unitToken);
    if (!unit) continue;
    addByUnit(nextQty, unit);
    i += 1;

    if (tokens[i + 1] === "and" && (tokens[i + 2] === "a" || tokens[i + 2] === "an") && tokens[i + 3] === "half") {
      addByUnit(0.5, unit);
      i += 3;
    }
  }

  if (!matched) return null;
  return { years, months, ms };
}

function parseTimeOfDay(text) {
  const s = normalizeText(text);
  if (!s) return null;

  if (/\bnoon\b/.test(s)) return { hours: 12, minutes: 0 };
  if (/\bmidnight\b/.test(s)) return { hours: 0, minutes: 0 };

  const meridiemMatch = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (meridiemMatch) {
    let hours = clampInt(meridiemMatch[1], 1, 12);
    const minutes = clampInt(meridiemMatch[2] ?? 0, 0, 59);
    const meridiem = meridiemMatch[3];
    if (meridiem === "pm" && hours !== 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;
    return { hours, minutes };
  }

  const twentyFourMatch = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (twentyFourMatch) {
    const hours = clampInt(twentyFourMatch[1], 0, 23);
    const minutes = clampInt(twentyFourMatch[2], 0, 59);
    return { hours, minutes };
  }

  const atHourMatch = s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (atHourMatch) {
    const hours = clampInt(atHourMatch[1], 0, 23);
    const minutes = clampInt(atHourMatch[2] ?? 0, 0, 59);
    return { hours, minutes };
  }

  return null;
}

function parseWeekday(text) {
  const s = normalizeText(text);
  if (!s) return null;
  const m = s.match(/\b(next|this)?\s*(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/);
  if (!m) return null;
  const qualifier = m[1] || "";
  const dayToken = m[2] || "";
  const dayIdx = WEEKDAY_INDEX[String(dayToken).replace(/\s+/g, "")] ?? null;
  if (dayIdx === null || dayIdx === undefined) return null;
  return { weekday: dayIdx, qualifier };
}

function applyTime(date, time, fallbackTime) {
  const d = new Date(date);
  const hours =
    Number.isFinite(Number(time?.hours)) ? clampInt(time.hours, 0, 23) : clampInt(fallbackTime?.hours ?? d.getHours(), 0, 23);
  const minutes =
    Number.isFinite(Number(time?.minutes)) ? clampInt(time.minutes, 0, 59) : clampInt(fallbackTime?.minutes ?? d.getMinutes(), 0, 59);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function fmtExampleExamples() {
  return "Try: “in 2h”, “tomorrow 9am”, “next friday”, “at 18:30”.";
}

export function parseNaturalWhen(input, { now, defaultTime } = {}) {
  const raw = String(input || "").trim();
  const text = normalizeText(raw);
  const baseNow = safeNow(now);
  if (!text) {
    return { ok: false, error: fmtExampleExamples() };
  }

  if (text === "now" || text === "asap") {
    const d = new Date(baseNow);
    d.setMinutes(d.getMinutes() + 5);
    d.setSeconds(0, 0);
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }

  const time = parseTimeOfDay(text);
  const duration = parseDuration(text);
  if (duration) {
    const years = Number(duration.years) || 0;
    const months = Number(duration.months) || 0;
    const ms = Number(duration.ms) || 0;
    if (years === 0 && months === 0 && ms === 0) {
      return { ok: false, error: "Duration must be greater than zero. " + fmtExampleExamples() };
    }
    let d = new Date(baseNow);
    d = addYearsClamped(d, years);
    d = addMonthsClamped(d, months);
    d = new Date(d.getTime() + ms);
    d = applyTime(d, time, defaultTime);
    if (d.getTime() <= baseNow.getTime()) {
      return { ok: false, error: "That resolves to the past. " + fmtExampleExamples() };
    }
    return { ok: true, date: d, meta: { kind: "duration" } };
  }

  // Date keywords
  if (/\btomorrow\b/.test(text)) {
    let d = new Date(baseNow);
    d.setDate(d.getDate() + 1);
    d = applyTime(d, time, defaultTime);
    if (d.getTime() <= baseNow.getTime()) {
      d.setDate(d.getDate() + 1);
    }
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }

  if (/\btonight\b/.test(text)) {
    let d = applyTime(baseNow, time || { hours: 20, minutes: 0 }, defaultTime);
    if (d.getTime() <= baseNow.getTime()) {
      d.setDate(d.getDate() + 1);
      d = applyTime(d, time || { hours: 20, minutes: 0 }, defaultTime);
    }
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }

  if (/\btoday\b/.test(text)) {
    let d = applyTime(baseNow, time, defaultTime);
    if (d.getTime() <= baseNow.getTime()) {
      return { ok: false, error: "That time today has already passed." };
    }
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }

  // Next week/month/year shortcuts
  if (/\bnext\s+week\b/.test(text)) {
    let d = new Date(baseNow);
    d.setDate(d.getDate() + 7);
    d = applyTime(d, time, defaultTime);
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }
  if (/\bnext\s+month\b/.test(text)) {
    let d = addMonthsClamped(baseNow, 1);
    d = applyTime(d, time, defaultTime);
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }
  if (/\bnext\s+year\b/.test(text)) {
    let d = addYearsClamped(baseNow, 1);
    d = applyTime(d, time, defaultTime);
    return { ok: true, date: d, meta: { kind: "keyword" } };
  }

  // Weekday
  const weekday = parseWeekday(text);
  if (weekday) {
    const dayIdx = weekday.weekday;
    const qualifier = weekday.qualifier;
    const base = new Date(baseNow);
    const todayIdx = base.getDay();
    let diff = (dayIdx - todayIdx + 7) % 7;
    let candidate = applyTime(base, time, defaultTime);

    if (diff === 0 && candidate.getTime() <= baseNow.getTime()) diff = 7;
    if (qualifier === "next") diff = diff === 0 ? 7 : diff + 7;
    if (diff !== 0) {
      candidate = new Date(candidate);
      candidate.setDate(candidate.getDate() + diff);
      candidate = applyTime(candidate, time, defaultTime);
    }
    if (candidate.getTime() <= baseNow.getTime()) {
      candidate.setDate(candidate.getDate() + 7);
      candidate = applyTime(candidate, time, defaultTime);
    }
    return { ok: true, date: candidate, meta: { kind: "weekday" } };
  }

  // Time-only ("at 5pm", "18:30")
  if (time) {
    let d = applyTime(baseNow, time, defaultTime);
    if (d.getTime() <= baseNow.getTime()) {
      d.setDate(d.getDate() + 1);
      d = applyTime(d, time, defaultTime);
    }
    return { ok: true, date: d, meta: { kind: "time" } };
  }

  return { ok: false, error: `Couldn’t understand “${raw}”. ${fmtExampleExamples()}` };
}
