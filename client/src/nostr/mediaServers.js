import { fetchEventsOnce } from "@/nostr/pool.js";
import { DEFAULT_RELAYS } from "@/nostr/config.js";

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

function latestEvent(events = []) {
  return (Array.isArray(events) ? events : []).reduce((acc, ev) => {
    if (!ev) return acc;
    if (!acc) return ev;
    return (Number(ev.created_at) || 0) > (Number(acc.created_at) || 0) ? ev : acc;
  }, null);
}

function normalizeHttpOrigin(input) {
  const trimmed = String(input || "").replace(ZERO_WIDTH_RE, "").trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.username || url.password) return "";
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function extractServerTags(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const servers = [];
  const seen = new Set();
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag[0] !== "server" || typeof tag[1] !== "string") continue;
    const url = normalizeHttpOrigin(tag[1]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    servers.push(url);
  }
  return servers;
}

export function extractServersFromKind10063(ev) {
  return extractServerTags(ev);
}

export function extractServersFromKind10096(ev) {
  return extractServerTags(ev);
}

export async function fetchUserMediaServers({ pubkey, relays = [] } = {}) {
  const author = String(pubkey || "").trim();
  if (!author) {
    return {
      blossom: [],
      nip96: [],
      blossomEvent: null,
      nip96Event: null,
    };
  }

  const relayList = Array.from(new Set([...(Array.isArray(relays) ? relays : []), ...DEFAULT_RELAYS])).filter(Boolean);
  const events = await fetchEventsOnce(relayList, {
    kinds: [10063, 10096],
    authors: [author],
    limit: 32,
  });

  const blossomEvent = latestEvent(events.filter((ev) => Number(ev?.kind) === 10063));
  const nip96Event = latestEvent(events.filter((ev) => Number(ev?.kind) === 10096));

  return {
    blossom: extractServersFromKind10063(blossomEvent),
    nip96: extractServersFromKind10096(nip96Event),
    blossomEvent,
    nip96Event,
  };
}

