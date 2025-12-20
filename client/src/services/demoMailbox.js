import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

function truthy(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function clampInt(n, { min = 0, max = 10000, fallback = 0 } = {}) {
  const v = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toIso(tsSec) {
  return new Date((Number(tsSec) || 0) * 1000).toISOString();
}

function hexId(...parts) {
  const input = parts.map((p) => String(p ?? "")).join("|");
  return bytesToHex(sha256(new TextEncoder().encode(input)));
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

function parseDemoMailboxConfig() {
  let params = null;
  try {
    params = new URLSearchParams(window.location.search || "");
  } catch {
    params = new URLSearchParams();
  }

  const enabled =
    truthy(params.get("demoMailbox")) ||
    truthy(localStorage.getItem("pidgeon.demoMailbox"));

  const scheduled = clampInt(params.get("demoScheduled") ?? localStorage.getItem("pidgeon.demoScheduled"), {
    min: 0,
    max: 50000,
    fallback: 50
  });
  const posted = clampInt(params.get("demoPosted") ?? localStorage.getItem("pidgeon.demoPosted"), {
    min: 0,
    max: 50000,
    fallback: 100
  });
  const contentLen = clampInt(
    params.get("demoContentLen") ?? localStorage.getItem("pidgeon.demoContentLen"),
    { min: 10, max: 5000, fallback: 180 }
  );

  return { enabled, scheduled, posted, contentLen };
}

export function isDemoMailboxEnabled() {
  return parseDemoMailboxConfig().enabled;
}

function defer(fn) {
  if (typeof queueMicrotask === "function") return queueMicrotask(fn);
  return Promise.resolve().then(fn);
}

const DEMO_IMAGE_POOL = Array.from({ length: 20 }).map((_, idx) => {
  const seed = `pidgeon-${String(idx + 1).padStart(2, "0")}`;
  // picsum is a real photo CDN; URL has no extension, but our URL parsing treats it as an image host.
  return `https://picsum.photos/seed/${seed}/1200/675`;
});

const DEMO_POST_POOL = [
  { body: "Today’s goal: ship one tiny improvement, then iterate. I’m keeping the scope small so it actually lands. What’s your focus today?", tags: ["coffee", "buildinpublic"] },
  { body: "Small change, big clarity. I’m optimizing for fewer clicks and calmer flows, especially on the “schedule” path. UX is a stack of tiny wins.", tags: ["ux", "product"] },
  { body: "Bug squashed. The best feeling is closing the loop and moving on without carrying mental debt. If you hit anything weird, I want to know.", tags: ["dev", "shipping"] },
  { body: "Weekly review time: wins, lessons, and one thing to stop doing. Consistency beats intensity, and boring routines beat heroic sprints.", tags: ["weekly", "systems"] },
  { body: "Rewired the data flow so the UI stays snappy even under load. Less re-render churn, fewer network round trips, better caching. Feels good.", tags: ["performance", "frontend"] },
  { body: "Notifications off, timer on. Deep work for 45 minutes, then a break. It’s amazing how much noise disappears when you protect focus.", tags: ["focus", "deepwork"] },
  { body: "Spacing, type scale, and a single accent color. I’m aiming for “quiet confidence” rather than “look at me”. It’s the little things.", tags: ["design", "ui"] },
  { body: "Quick lunch walk to clear the head. Ideas land better when you step away from the keyboard. Shipping is easier when you’re calm.", tags: ["life", "walk"] },
  { body: "Release candidate is ready. If nothing breaks in the next hour, we ship. I’m watching logs and keeping the rollback button close.", tags: ["release", "testing"] },
  { body: "Reading time: revisiting old notes and extracting one actionable improvement. The goal isn’t more knowledge, it’s better decisions.", tags: ["reading", "notes"] },
  { body: "Minimal desk, maximal output. One cable less, one distraction less, one clean surface. What’s one thing you can remove today?", tags: ["setup", "minimal"] },
  { body: "Sketching ideas on paper first. It’s faster than arguing with pixels, and you can throw away a bad concept in 10 seconds.", tags: ["sketch", "ideas"] },
  { body: "Loaded a heavy mailbox and watched for jank. The app is holding up, but there’s still room to smooth out hydration and caching.", tags: ["perf", "bench"] },
  { body: "Clean refactor day. No new features—just making future work easier and less fragile. I’d rather do this now than regret it later.", tags: ["refactor", "code"] },
  { body: "Evening wrap-up: three things done, one thing learned, one thing queued for tomorrow. Ending the day with clarity is underrated.", tags: ["routine", "daily"] },
  { body: "Analytics feels great when it’s client-side and deduped. Fast, private, and no servers hoarding your engagement graph. More to come.", tags: ["analytics", "nostr"] },
  { body: "Polishing the calendar view. Better previews, fewer surprises, and safer actions. Scheduling should feel calm, not risky.", tags: ["calendar", "product"] },
  { body: "Testing with a localhost relay is so much calmer. No rate limits, no noisy network variables, and you can iterate quickly.", tags: ["local", "testing"] },
  { body: "One more iteration. It’s never perfect, but it can always be better than yesterday. Small steps compound fast.", tags: ["iterate", "craft"] },
  { body: "Weekend project vibes. A small experiment that might become a real feature later, or might teach me why it’s a bad idea.", tags: ["weekend", "prototype"] },
];

const DEMO_QUOTE_TEXT_POOL = [
  "cool",
  "wow",
  "nice",
  "so true",
  "love this",
  "great point",
  "100%",
  "agree",
  "this",
  "🔥",
  "✨",
  "exactly",
  "well said",
  "facts",
  "big yes",
];

function makeContent(rng, i, { targetLen }) {
  const img = DEMO_IMAGE_POOL[i % DEMO_IMAGE_POOL.length];
  const post = DEMO_POST_POOL[i % DEMO_POST_POOL.length];

  const tail = [
    "Thoughts?",
    "Curious what you’d do.",
    "More soon.",
    "Keeping it simple.",
    "Iterating in public.",
    "Testing under load.",
  ][Math.floor(rng() * 6)] || "More soon.";

  const tags = (post.tags || []).slice(0, 3).map((t) => `#${t}`).join(" ");
  const base = `${post.body}\n\n${tail}${tags ? `\n\n${tags}` : ""}`;

  const availableForText = Math.max(20, (Number(targetLen) || 180) - (img.length + 2 + 2)); // keep room for "\n\n" + url
  const text = base.length > availableForText ? base.slice(0, Math.max(0, availableForText - 1)).trimEnd() + "…" : base;
  return `${text}\n\n${img}`;
}

function makeQuoteText(rng, i) {
  const fallback = "cool";
  const pick = DEMO_QUOTE_TEXT_POOL[i % DEMO_QUOTE_TEXT_POOL.length] || fallback;
  // Add tiny variation but keep it short (quotes should feel like quick commentary).
  const maybe = rng() < 0.2 ? `${pick}!` : pick;
  return String(maybe || fallback).trim() || fallback;
}

function pickDemoJobMode(rng) {
  const r = rng();
  if (r < 0.15) return "quote";
  if (r < 0.3) return "repost";
  return "note";
}

function makeDemoTarget(rng, pubkey, i, { contentLen }) {
  const id = hexId("target-note", pubkey, i);
  const authorPubkey = hexId("target-author", pubkey, i).slice(0, 64);
  const content = makeContent(rng, i + 11, { targetLen: Math.max(140, Number(contentLen) || 180) });
  const relayHint = "wss://demo.relay";
  return { id, authorPubkey, content, relayHint };
}

function makeJobs(pubkey, { scheduledCount, postedCount, contentLen }) {
  const seed = Number.parseInt(hexId("seed", pubkey).slice(0, 8), 16) || 1;
  const rng = mulberry32(seed);
  const now = nowSec();

  const scheduled = [];
  for (let i = 0; i < scheduledCount; i++) {
    const mode = pickDemoJobMode(rng);
    const offsetSec = Math.floor(rng() * 14 * 24 * 3600) + 60; // next 14d
    const scheduledAt = now + offsetSec;
    const id = hexId("job", pubkey, "scheduled", i, scheduledAt);
    const target = mode === "note" ? null : makeDemoTarget(rng, pubkey, i, { contentLen });
    const content =
      mode === "repost"
        ? ""
        : mode === "quote"
          ? makeQuoteText(rng, i)
          : makeContent(rng, i, { targetLen: contentLen });
    const baseTags = [["t", "demo"], ["t", "scheduled"]];
    if (mode === "repost" && target) baseTags.push(["pidgeon", "repost", target.id]);
    if (mode === "quote" && target) baseTags.push(["pidgeon", "quote", target.id], ["q", target.id, target.relayHint, target.authorPubkey]);
    scheduled.push({
      jobType: "note",
      id,
      requestId: id,
      noteId: hexId("note", pubkey, "scheduled", i),
      content,
      tags: baseTags,
      scheduledAt: toIso(scheduledAt),
      createdAt: toIso(scheduledAt),
      updatedAt: toIso(now),
      status: "scheduled",
      relays: [],
      statusInfo: "",
      lastError: "",
      noteBlob: null,
      isRepost: mode === "repost",
      repostTargetId: mode === "repost" && target ? target.id : "",
      quoteTargetId: mode === "quote" && target ? target.id : "",
      quoteTargetContent: mode === "quote" && target ? target.content : ""
    });
  }

  const posted = [];
  for (let i = 0; i < postedCount; i++) {
    const mode = pickDemoJobMode(rng);
    const offsetSec = Math.floor(rng() * 90 * 24 * 3600) + 60; // last 90d
    const createdAt = now - offsetSec;
    const noteId = hexId("note", pubkey, "posted", i, createdAt);
    const target = mode === "note" ? null : makeDemoTarget(rng, pubkey, i + 1000, { contentLen });
    const content =
      mode === "repost"
        ? ""
        : mode === "quote"
          ? makeQuoteText(rng, i)
          : makeContent(rng, i, { targetLen: contentLen });
    const baseTags = [["t", "demo"], ["t", "posted"]];
    if (mode === "repost" && target) baseTags.push(["pidgeon", "repost", target.id], ["e", target.id, target.relayHint], ["p", target.authorPubkey]);
    if (mode === "quote" && target)
      baseTags.push(["pidgeon", "quote", target.id], ["q", target.id, target.relayHint, target.authorPubkey], ["p", target.authorPubkey]);
    posted.push({
      jobType: "note",
      id: noteId,
      requestId: "",
      noteId,
      content,
      tags: baseTags,
      scheduledAt: toIso(createdAt),
      createdAt: toIso(createdAt),
      updatedAt: toIso(createdAt),
      status: "posted",
      relays: [],
      statusInfo: "",
      lastError: "",
      noteBlob: null,
      isRepost: mode === "repost",
      repostTargetId: mode === "repost" && target ? target.id : "",
      quoteTargetId: mode === "quote" && target ? target.id : "",
      quoteTargetContent: mode === "quote" && target ? target.content : "",
      noteEvent: {
        id: noteId,
        pubkey,
        created_at: createdAt,
        kind: mode === "repost" ? 6 : 1,
        tags: baseTags,
        content,
        sig: "0".repeat(128)
      }
    });
  }

  // Approximate the real sort: newest updated first.
  posted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  scheduled.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

  return [...posted, ...scheduled];
}

export async function subscribeDemoMailbox(pubkey, { onJobs, onSync, onCounts } = {}) {
  const cfg = parseDemoMailboxConfig();
  const scheduledCount = cfg.scheduled;
  const postedCount = cfg.posted;
  const contentLen = cfg.contentLen;
  const jobs = makeJobs(pubkey, { scheduledCount, postedCount, contentLen });

  let closed = false;
  const sub = {
    close() {
      closed = true;
    },
    retryNow() {
      if (closed) return;
      defer(() => {
        if (closed) return;
        onJobs?.(jobs);
        onCounts?.({ queued: scheduledCount, posted: postedCount });
        onSync?.({ status: "up_to_date", rev: 1, missing: 0 });
      });
    },
    hasMorePending() {
      return false;
    },
    hasMoreHistory() {
      return false;
    },
    async loadMorePending() {},
    async loadMoreHistory() {}
  };

  defer(() => {
    if (closed) return;
    onJobs?.(jobs);
    onCounts?.({ queued: scheduledCount, posted: postedCount });
    onSync?.({ status: "up_to_date", rev: 1, missing: 0 });
  });

  return sub;
}
