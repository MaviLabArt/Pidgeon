import { fetchEventsOnce } from "@/nostr/pool.js";
import { DEFAULT_RELAYS } from "@/nostr/config.js";
import { normalizeWsRelayUrl } from "@/utils/relayUrls.js";

function latestEvent(events = []) {
  return (Array.isArray(events) ? events : []).reduce((acc, ev) => {
    if (!ev) return acc;
    if (!acc) return ev;
    return (Number(ev.created_at) || 0) > (Number(acc.created_at) || 0) ? ev : acc;
  }, null);
}

export function extractWriteRelaysFromKind10002(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const relays = [];
  tags.forEach((t) => {
    if (!Array.isArray(t) || t[0] !== "r") return;
    const url = normalizeWsRelayUrl(t[1]);
    if (!url) return;
    const marker = String(t[2] || "").trim();
    if (!marker || marker === "write") relays.push(url);
  });
  return Array.from(new Set(relays));
}

export function extractReadRelaysFromKind10002(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const relays = [];
  tags.forEach((t) => {
    if (!Array.isArray(t) || t[0] !== "r") return;
    const url = normalizeWsRelayUrl(t[1]);
    if (!url) return;
    const marker = String(t[2] || "").trim();
    // Treat an unmarked relay as usable for both read+write (common in the wild).
    if (!marker || marker === "read") relays.push(url);
  });
  return Array.from(new Set(relays));
}

export function extractNip65RelaysFromKind10002(ev) {
  return {
    read: extractReadRelaysFromKind10002(ev),
    write: extractWriteRelaysFromKind10002(ev)
  };
}

export async function fetchNip65Relays({ pubkey, relays = [] } = {}) {
  const author = String(pubkey || "").trim();
  if (!author) return { read: [], write: [] };
  const relayList = Array.from(new Set([...(Array.isArray(relays) ? relays : []), ...DEFAULT_RELAYS])).filter(Boolean);
  const events = await fetchEventsOnce(relayList, {
    kinds: [10002],
    authors: [author],
    limit: 16
  });
  const ev = latestEvent(events);
  if (!ev) return { read: [], write: [] };
  return extractNip65RelaysFromKind10002(ev);
}

export async function fetchNip65WriteRelays({ pubkey, relays = [] } = {}) {
  const res = await fetchNip65Relays({ pubkey, relays });
  return res.write;
}
