import { fetchEventsOnce, countEventsOnce } from "@/nostr/pool.js";
import { isDemoMailboxEnabled } from "@/services/demoMailbox.js";

const DAY_SEC = 24 * 60 * 60;

export const DEFAULT_WEIGHTS = Object.freeze({
  replyShort: 1,
  replyMedium: 5,
  replyLong: 10,
  quote: 7,
  repost: 7,
  zap: 5,
  bookmark: 3,
  like: 1
});

function uniq(list = []) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function chunk(list = [], size = 50) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dateKeyFromSec(ts) {
  const d = new Date((Number(ts) || 0) * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function getTagValues(tags, name) {
  const t = Array.isArray(tags) ? tags : [];
  return t.filter((x) => Array.isArray(x) && x[0] === name && typeof x[1] === "string").map((x) => String(x[1] || "").trim()).filter(Boolean);
}

function getETags(tags) {
  const t = Array.isArray(tags) ? tags : [];
  return t
    .filter((x) => Array.isArray(x) && x[0] === "e" && typeof x[1] === "string")
    .map((x) => ({ id: String(x[1] || "").trim(), marker: String(x[3] || "").trim().toLowerCase() }))
    .filter((x) => x.id);
}

function reactionIsPositive(ev) {
  const c = String(ev?.content || "").trim();
  return c !== "-";
}

function replyBucket(content = "") {
  const len = String(content || "").trim().length;
  if (len < 50) return "short";
  if (len <= 200) return "medium";
  return "long";
}

function ensureMetricRow(map, noteId) {
  const id = String(noteId || "").trim();
  if (!id) return null;
  const prev = map.get(id);
  if (prev) return prev;
  const row = {
    noteId: id,
    likes: 0,
    replies: 0,
    replyShort: 0,
    replyMedium: 0,
    replyLong: 0,
    quotes: 0,
    reposts: 0,
    zaps: 0,
    zapMsat: 0,
    bookmarks: 0,
    score: 0
  };
  map.set(id, row);
  return row;
}

function finalizeScore(row, weights) {
  const w = weights || DEFAULT_WEIGHTS;
  row.score =
    (row.replyShort || 0) * w.replyShort +
    (row.replyMedium || 0) * w.replyMedium +
    (row.replyLong || 0) * w.replyLong +
    (row.quotes || 0) * w.quote +
    (row.reposts || 0) * w.repost +
    (row.zaps || 0) * w.zap +
    (row.bookmarks || 0) * w.bookmark +
    (row.likes || 0) * w.like;
  return row;
}

function safeIsDemo() {
  try {
    return Boolean(isDemoMailboxEnabled?.());
  } catch {
    return false;
  }
}

function hash32(str) {
  const s = String(str ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDemoPerformance({ noteIds, rangeDays = 7, weights = DEFAULT_WEIGHTS } = {}) {
  const targets = uniq(noteIds);
  const targetSet = new Set(targets);
  const w = weights || DEFAULT_WEIGHTS;

  const perNote = new Map();
  const byDay = new Map();
  const nowSec = Math.floor(Date.now() / 1000);
  const days = Math.max(1, Number(rangeDays) || 7);
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKeyFromSec(nowSec - i * DAY_SEC);
    byDay.set(key, { date: key, score: 0, likes: 0, replies: 0, quotes: 0, reposts: 0, zaps: 0, bookmarks: 0 });
  }

  const dayKeys = Array.from(byDay.keys());
  const bumpDay = (dayKey, field, n = 1, scoreDelta = 0) => {
    if (!dayKey || !byDay.has(dayKey)) return;
    const row = byDay.get(dayKey);
    row[field] = (row[field] || 0) + n;
    row.score = (row.score || 0) + (scoreDelta || 0);
  };

  // Conservative, deterministic fake engagement:
  // - most notes get 0
  // - small occasional hits spread across days
  for (const noteId of targets) {
    if (!targetSet.has(noteId)) continue;
    const rng = mulberry32(hash32(`pidgeon-demo-analytics|${noteId}`));
    const row = ensureMetricRow(perNote, noteId);

    // Likes: common-ish
    if (rng() < 0.28) row.likes = 1 + (rng() < 0.25 ? 1 : 0) + (rng() < 0.12 ? 1 : 0); // 1–3
    // Replies: less common; bucketed small/medium
    if (rng() < 0.14) row.replies = 1 + (rng() < 0.18 ? 1 : 0); // 1–2
    // Quotes / reposts: rare
    if (rng() < 0.06) row.quotes = 1;
    if (rng() < 0.07) row.reposts = 1;
    // Zaps: very rare, amount tag only (msats)
    if (rng() < 0.035) {
      row.zaps = 1;
      const sats = 5 + Math.floor(rng() * 45); // 5–49 sats
      row.zapMsat = sats * 1000;
    }
    // Bookmarks: rare
    if (rng() < 0.025) row.bookmarks = 1;

    // Split replies into buckets for score realism
    if (row.replies > 0) {
      for (let i = 0; i < row.replies; i += 1) {
        if (rng() < 0.7) row.replyShort += 1;
        else row.replyMedium += 1;
      }
    }

    finalizeScore(row, w);

    // Distribute to daily series (engagement-time buckets)
    const pickDay = () => dayKeys[Math.floor(rng() * dayKeys.length)] || dayKeys[dayKeys.length - 1];
    for (let i = 0; i < (row.likes || 0); i += 1) bumpDay(pickDay(), "likes", 1, w.like);
    for (let i = 0; i < (row.quotes || 0); i += 1) bumpDay(pickDay(), "quotes", 1, w.quote);
    for (let i = 0; i < (row.reposts || 0); i += 1) bumpDay(pickDay(), "reposts", 1, w.repost);
    for (let i = 0; i < (row.bookmarks || 0); i += 1) bumpDay(pickDay(), "bookmarks", 1, w.bookmark);
    for (let i = 0; i < (row.zaps || 0); i += 1) bumpDay(pickDay(), "zaps", 1, w.zap);
    for (let i = 0; i < (row.replyShort || 0); i += 1) bumpDay(pickDay(), "replies", 1, w.replyShort);
    for (let i = 0; i < (row.replyMedium || 0); i += 1) bumpDay(pickDay(), "replies", 1, w.replyMedium);
    for (let i = 0; i < (row.replyLong || 0); i += 1) bumpDay(pickDay(), "replies", 1, w.replyLong);
  }

  const global = {
    rangeDays,
    noteCount: targets.length,
    likes: 0,
    replies: 0,
    quotes: 0,
    reposts: 0,
    zaps: 0,
    zapMsat: 0,
    bookmarks: 0,
    score: 0
  };
  for (const row of perNote.values()) {
    global.likes += row.likes || 0;
    global.replies += row.replies || 0;
    global.quotes += row.quotes || 0;
    global.reposts += row.reposts || 0;
    global.zaps += row.zaps || 0;
    global.zapMsat += row.zapMsat || 0;
    global.bookmarks += row.bookmarks || 0;
    global.score += row.score || 0;
  }

  return { global, perNote, series: Array.from(byDay.values()) };
}

async function fetchByChunks(relays, { kinds, tag, ids, since, until, limit = 500 }) {
  const list = uniq(ids);
  if (!list.length) return [];
  const filters = chunk(list, 50).map((part) => {
    const f = { kinds, since, limit };
    if (until) f.until = until;
    f[tag] = part;
    return f;
  });
  return await fetchEventsOnce(relays, filters);
}

export async function computePerformance({
  relays,
  noteIds,
  sinceSec,
  untilSec,
  rangeDays = 7,
  weights = DEFAULT_WEIGHTS
} = {}) {
  if (safeIsDemo()) {
    return makeDemoPerformance({ noteIds, rangeDays, weights });
  }

  const targets = uniq(noteIds);
  const targetSet = new Set(targets);
  const since = Number(sinceSec) || 0;
  const until = Number(untilSec) || 0;
  const w = weights || DEFAULT_WEIGHTS;

  if (!Array.isArray(relays) || !relays.length) {
    return {
      global: { rangeDays, noteCount: targets.length, likes: 0, replies: 0, quotes: 0, reposts: 0, zaps: 0, zapMsat: 0, bookmarks: 0, score: 0 },
      perNote: new Map(),
      series: []
    };
  }

  const [replies, quotes, reposts, reactions, zaps, bookmarksA, bookmarksB] = await Promise.all([
    fetchByChunks(relays, { kinds: [1], tag: "#e", ids: targets, since, until, limit: 800 }),
    fetchByChunks(relays, { kinds: [1], tag: "#q", ids: targets, since, until, limit: 800 }),
    fetchByChunks(relays, { kinds: [6, 16], tag: "#e", ids: targets, since, until, limit: 800 }),
    fetchByChunks(relays, { kinds: [7], tag: "#e", ids: targets, since, until, limit: 800 }),
    fetchByChunks(relays, { kinds: [9735], tag: "#e", ids: targets, since, until, limit: 800 }),
    fetchByChunks(relays, { kinds: [10003], tag: "#e", ids: targets, since, until, limit: 200 }),
    (async () => {
      // Deprecated bookmark lists: kind 30001 with d=bookmark (NIP-51)
      const list = uniq(targets);
      if (!list.length) return [];
      const filters = chunk(list, 50).map((part) => {
        const f = { kinds: [30001], since, limit: 200, "#e": part, "#d": ["bookmark"] };
        if (until) f.until = until;
        return f;
      });
      return await fetchEventsOnce(relays, filters);
    })()
  ]);

  const perNote = new Map();

  // Daily series (engagement-time buckets)
  const byDay = new Map();
  const nowSec = Math.floor(Date.now() / 1000);
  const days = Math.max(1, Number(rangeDays) || 7);
  for (let i = days - 1; i >= 0; i--) {
    const key = dateKeyFromSec(nowSec - i * DAY_SEC);
    byDay.set(key, { date: key, score: 0, likes: 0, replies: 0, quotes: 0, reposts: 0, zaps: 0, bookmarks: 0 });
  }
  const bumpDay = (tsSec, field, n = 1, scoreDelta = 0) => {
    const key = dateKeyFromSec(tsSec);
    if (!key || !byDay.has(key)) return;
    const row = byDay.get(key);
    row[field] = (row[field] || 0) + n;
    row.score = (row.score || 0) + (scoreDelta || 0);
  };

  // Quotes (approx: only events with q-tags)
  for (const ev of quotes || []) {
    const qs = getTagValues(ev.tags, "q");
    const hit = qs.filter((id) => targetSet.has(id));
    if (!hit.length) continue;
    for (const noteId of hit) {
      const row = ensureMetricRow(perNote, noteId);
      row.quotes += 1;
    }
    bumpDay(ev.created_at, "quotes", hit.length, w.quote * hit.length);
  }

  // Replies (kind 1 with #e hits), excluding explicit q-tag quotes and mention-only refs
  for (const ev of replies || []) {
    const qs = new Set(getTagValues(ev.tags, "q"));
    const eTags = getETags(ev.tags);
    const bucket = replyBucket(ev.content || "");
    const weight = bucket === "short" ? w.replyShort : bucket === "medium" ? w.replyMedium : w.replyLong;

    for (const t of eTags) {
      const noteId = t.id;
      if (!targetSet.has(noteId)) continue;
      if (qs.has(noteId)) continue; // count as quote, not reply
      if (t.marker === "mention") continue;
      const row = ensureMetricRow(perNote, noteId);
      row.replies += 1;
      if (bucket === "short") row.replyShort += 1;
      else if (bucket === "medium") row.replyMedium += 1;
      else row.replyLong += 1;
      bumpDay(ev.created_at, "replies", 1, weight);
    }
  }

  // Reposts
  for (const ev of reposts || []) {
    const eIds = getETags(ev.tags).map((t) => t.id);
    const hit = eIds.filter((id) => targetSet.has(id));
    if (!hit.length) continue;
    for (const noteId of hit) {
      const row = ensureMetricRow(perNote, noteId);
      row.reposts += 1;
    }
    bumpDay(ev.created_at, "reposts", hit.length, w.repost * hit.length);
  }

  // Zaps (amount tag only)
  for (const ev of zaps || []) {
    const amountTag = (Array.isArray(ev.tags) ? ev.tags : []).find((t) => Array.isArray(t) && t[0] === "amount");
    const msat = amountTag ? Number.parseInt(String(amountTag[1] || "0"), 10) : 0;
    const eIds = getETags(ev.tags).map((t) => t.id);
    const hit = eIds.filter((id) => targetSet.has(id));
    if (!hit.length) continue;
    for (const noteId of hit) {
      const row = ensureMetricRow(perNote, noteId);
      row.zaps += 1;
      row.zapMsat += Number.isFinite(msat) ? msat : 0;
    }
    bumpDay(ev.created_at, "zaps", hit.length, w.zap * hit.length);
  }

  // Reactions (likes): dedupe latest by (noteId, pubkey), then count positives
  const latestReaction = new Map(); // `${noteId}:${pubkey}` -> ev
  for (const ev of reactions || []) {
    if (!ev?.pubkey) continue;
    const eIds = getETags(ev.tags).map((t) => t.id);
    for (const noteId of eIds) {
      if (!targetSet.has(noteId)) continue;
      const key = `${noteId}:${ev.pubkey}`;
      const prev = latestReaction.get(key);
      if (!prev || (Number(ev.created_at) || 0) >= (Number(prev.created_at) || 0)) {
        latestReaction.set(key, ev);
      }
    }
  }
  for (const [key, ev] of latestReaction.entries()) {
    if (!reactionIsPositive(ev)) continue;
    const noteId = key.split(":")[0];
    const row = ensureMetricRow(perNote, noteId);
    row.likes += 1;
    bumpDay(ev.created_at, "likes", 1, w.like);
  }

  // Bookmarks (approx): unique bookmarkers seen in any matching list event
  const bookmarkersByNote = new Map(); // noteId -> Set(pubkey)
  for (const ev of [...(bookmarksA || []), ...(bookmarksB || [])]) {
    const pk = String(ev?.pubkey || "").trim();
    if (!pk) continue;
    const eIds = getETags(ev.tags).map((t) => t.id);
    for (const noteId of eIds) {
      if (!targetSet.has(noteId)) continue;
      const set = bookmarkersByNote.get(noteId) || new Set();
      set.add(pk);
      bookmarkersByNote.set(noteId, set);
    }
    bumpDay(ev.created_at, "bookmarks", 1, w.bookmark);
  }
  for (const [noteId, set] of bookmarkersByNote.entries()) {
    const row = ensureMetricRow(perNote, noteId);
    row.bookmarks = set.size;
  }

  // Finalize per-note scores
  for (const row of perNote.values()) {
    finalizeScore(row, w);
  }

  // Global totals
  const global = {
    rangeDays,
    noteCount: targets.length,
    likes: 0,
    replies: 0,
    quotes: 0,
    reposts: 0,
    zaps: 0,
    zapMsat: 0,
    bookmarks: 0,
    score: 0
  };
  for (const row of perNote.values()) {
    global.likes += row.likes || 0;
    global.replies += row.replies || 0;
    global.quotes += row.quotes || 0;
    global.reposts += row.reposts || 0;
    global.zaps += row.zaps || 0;
    global.zapMsat += row.zapMsat || 0;
    global.bookmarks += row.bookmarks || 0;
    global.score += row.score || 0;
  }

  return { global, perNote, series: Array.from(byDay.values()) };
}

export async function quickEstimateFromRelay({
  relay,
  noteIds,
  sinceSec,
  untilSec,
  rangeDays = 7
} = {}) {
  if (safeIsDemo()) {
    const { global } = makeDemoPerformance({ noteIds, rangeDays });
    return {
      relay: relay || "demo",
      rangeDays,
      likes: global.likes || 0,
      replies: global.replies || 0,
      quotes: global.quotes || 0,
      reposts: global.reposts || 0,
      zaps: global.zaps || 0,
      approximate: true
    };
  }

  const ids = uniq(noteIds);
  const since = Number(sinceSec) || 0;
  const until = Number(untilSec) || 0;
  if (!relay || !ids.length) {
    return { relay: relay || "", rangeDays, likes: 0, replies: 0, quotes: 0, reposts: 0, zaps: 0, approximate: true };
  }

  // COUNT is relay-specific and not deduped; treat as a quick approximation.
  const withTime = (f) => {
    const out = { ...f, since };
    if (until) out.until = until;
    return out;
  };

  const [likes, replies, quotes, reposts, zaps] = await Promise.all([
    countEventsOnce(relay, withTime({ kinds: [7], "#e": ids })),
    countEventsOnce(relay, withTime({ kinds: [1], "#e": ids })),
    countEventsOnce(relay, withTime({ kinds: [1], "#q": ids })),
    countEventsOnce(relay, withTime({ kinds: [6, 16], "#e": ids })),
    countEventsOnce(relay, withTime({ kinds: [9735], "#e": ids }))
  ]);

  const approximate =
    Boolean(likes?.approximate) ||
    Boolean(replies?.approximate) ||
    Boolean(quotes?.approximate) ||
    Boolean(reposts?.approximate) ||
    Boolean(zaps?.approximate);

  return {
    relay: likes?.relay || relay,
    rangeDays,
    likes: likes?.count || 0,
    replies: replies?.count || 0,
    quotes: quotes?.count || 0,
    reposts: reposts?.count || 0,
    zaps: zaps?.count || 0,
    approximate: approximate || true
  };
}
