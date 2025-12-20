import { fetchEventsOnce, publishEvents } from "@/nostr/pool.js";
import { resolveRelays } from "@/nostr/config.js";
import { buildDraftPayload, decryptDraft, encryptDraft } from "@/utils/draftEncryption.js";
import { isDemoMailboxEnabled } from "@/services/demoMailbox.js";

const DRAFT_KIND = 31234;
const DEFAULT_LIMIT = 300;
const DRAFT_TARGET_KIND = "1";
const DEMO_STORAGE_PREFIX = "pidgeon.demoDrafts.";
const DEMO_DEFAULT_COUNT = 8;

function getNostr() {
  if (typeof window === "undefined") throw new Error("Connect a Nostr signer first");
  const nostr = window.nostrSigner || window.nostrShim || window.nostr;
  if (!nostr) throw new Error("Connect a Nostr signer first");
  return nostr;
}

function hasTag(ev, key, value) {
  if (!Array.isArray(ev?.tags)) return false;
  return ev.tags.some((t) => t?.[0] === key && (value === undefined || t?.[1] === value));
}

function looksLikeDraftCiphertext(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (!s) return false;
  // Drafts are stored as raw NIP-44 ciphertext (not JSON and not NIP-04).
  if (s.startsWith("{") || s.startsWith("[")) return false;
  if (s.includes("?iv=")) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(s);
}

async function getPubkey(nostr, fallback) {
  if (fallback) return fallback;
  if (typeof nostr.getPublicKey === "function") return nostr.getPublicKey();
  return "";
}

function draftIdFromEvent(ev) {
  const tag = Array.isArray(ev?.tags) ? ev.tags.find((t) => t[0] === "d" && t[1]) : null;
  return tag ? tag[1] : "";
}

function generateDraftId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
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

function demoKey(pubkey) {
  return `${DEMO_STORAGE_PREFIX}${String(pubkey || "").trim()}`;
}

function readDemoDrafts(pubkey) {
  const key = demoKey(pubkey);
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDemoDrafts(pubkey, drafts) {
  const key = demoKey(pubkey);
  try {
    localStorage.setItem(key, JSON.stringify(Array.isArray(drafts) ? drafts : []));
  } catch {}
}

function seedDemoDrafts(pubkey) {
  const existing = readDemoDrafts(pubkey);
  if (existing.length) return existing;

  const pool = [
    { content: "Quick update: shipping a small UX tweak today. The goal is fewer clicks and a calmer flow.", tags: "ux,product" },
    { content: "Testing mailbox fetching under load. If you notice jank, tell me where it happens and what device you’re on.", tags: "perf,testing" },
    { content: "Refactor day. No new features—just making future work safer and faster.", tags: "refactor,dev" },
    { content: "Tiny design polish: spacing, type scale, and a single accent color. Quiet confidence.", tags: "design,ui" },
    { content: "Local relay testing is underrated. Less noise, more signal.", tags: "local,nostr" },
    { content: "A note on focus: notifications off, timer on. Deep work, then a break.", tags: "focus,systems" },
    { content: "Weekly review: wins, lessons, and one thing to stop doing. Consistency beats intensity.", tags: "weekly,routine" },
    { content: "Weekend experiment: a small idea that might become a real feature later.", tags: "weekend,prototype" },
    { content: "Analytics should feel fast and private. Client-side counting + dedupe is the vibe.", tags: "analytics,nostr" },
    { content: "Shipping a fix. Closing the loop is the best feeling.", tags: "shipping,dev" },
  ];

  const rng = mulberry32(hash32(`pidgeon-demo-drafts|${pubkey}`));
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  for (let i = 0; i < DEMO_DEFAULT_COUNT; i += 1) {
    const pick = pool[Math.floor(rng() * pool.length)] || pool[0];
    const ageSec = (Math.floor(rng() * 21) + 1) * 3600; // up to ~21h old
    const createdAt = now - ageSec;
    const updatedAt = createdAt + Math.floor(rng() * 1800); // within 30m
    out.push({
      id: generateDraftId(),
      content: pick.content,
      tags: pick.tags,
      createdAt,
      updatedAt,
      eventId: `demo-${i}`
    });
  }

  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  writeDemoDrafts(pubkey, out);
  return out;
}

export async function fetchDrafts(pubkey, relays = []) {
  if (!pubkey) return [];
  if (safeIsDemo()) return seedDemoDrafts(pubkey);
  const nostr = getNostr();
  const targetRelays = resolveRelays(relays);
  const events = await fetchEventsOnce(targetRelays, {
    kinds: [DRAFT_KIND],
    authors: [pubkey],
    limit: DEFAULT_LIMIT
  });

  // Keep the latest event per draft id
  const latestById = new Map();
  events.forEach((ev) => {
    if (!hasTag(ev, "k", DRAFT_TARGET_KIND)) return;
    const id = draftIdFromEvent(ev);
    if (!id) return;
    const prev = latestById.get(id);
    if (!prev || ev.created_at > prev.created_at) latestById.set(id, ev);
  });

  const drafts = [];
  for (const ev of latestById.values()) {
    if (!ev.content) continue; // deleted draft
    if (!looksLikeDraftCiphertext(ev.content)) {
      console.warn("[drafts] Skipping non-encrypted draft event", ev.id);
      continue;
    }
    try {
      const blob = await decryptDraft(nostr, pubkey, ev.content);
      drafts.push({
        id: blob.id,
        content: blob.content,
        tags: blob.tags,
        createdAt: blob.createdAt || ev.created_at,
        updatedAt: blob.updatedAt || ev.created_at,
        eventId: ev.id
      });
    } catch (err) {
      console.warn("[drafts] Failed to decrypt draft event", ev.id, err?.message || err);
    }
  }

  return drafts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function saveDraft({ id, pubkey, content, tags, relays = [] }) {
  if (safeIsDemo()) {
    const signerPubkey = String(pubkey || "").trim();
    if (!signerPubkey) throw new Error("Login to save drafts");
    const payload = buildDraftPayload({ id: id || generateDraftId(), content, tags });
    const draft = {
      id: payload.id,
      content: payload.content,
      tags: payload.tags,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      eventId: `demo-${payload.id}`
    };
    const list = readDemoDrafts(signerPubkey);
    const next = [draft, ...list.filter((d) => d?.id !== draft.id)];
    writeDemoDrafts(signerPubkey, next);
    return draft;
  }

  const nostr = getNostr();
  const signerPubkey = await getPubkey(nostr, pubkey);
  const payload = buildDraftPayload({
    id: id || generateDraftId(),
    content,
    tags
  });
  const cipher = await encryptDraft(nostr, signerPubkey, payload);

  const event = await nostr.signEvent({
    kind: DRAFT_KIND,
    created_at: payload.updatedAt,
    tags: [
      ["d", payload.id],
      ["k", "1"]
    ],
    content: cipher,
    pubkey: signerPubkey
  });

  const targetRelays = resolveRelays(relays);
  if (!targetRelays.length) throw new Error("No relays configured for drafts");
  await publishEvents(targetRelays, event);

  return {
    id: payload.id,
    content: payload.content,
    tags: payload.tags,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    eventId: event.id
  };
}

export async function removeDraft(pubkey, id, relays = []) {
  if (!pubkey || !id) return;
  if (safeIsDemo()) {
    const list = readDemoDrafts(pubkey);
    writeDemoDrafts(pubkey, list.filter((d) => d?.id !== id));
    return;
  }
  const nostr = getNostr();
  const signerPubkey = await getPubkey(nostr, pubkey);
  const event = await nostr.signEvent({
    kind: DRAFT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", id],
      ["k", "1"]
    ],
    content: "",
    pubkey: signerPubkey
  });
  const targetRelays = resolveRelays(relays);
  if (!targetRelays.length) return;
  await publishEvents(targetRelays, event);
}
