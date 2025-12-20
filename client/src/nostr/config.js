import { nip19 } from "nostr-tools";

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol"
];

export function resolveRelays(candidate) {
  const normalized = Array.isArray(candidate)
    ? candidate
        .map((url) => String(url || "").trim())
        .filter((url) => url.startsWith("ws"))
    : [];
  return normalized.length ? normalized : DEFAULT_RELAYS;
}

function normalizeListInput(val) {
  if (Array.isArray(val)) {
    return val
      .map((v) => String(v || "").trim())
      .filter(Boolean);
  }
  if (typeof val === "string") {
    return val
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePubkey(str) {
  const raw = String(str || "").trim();
  if (!raw) return "";
  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded?.type === "npub" && typeof decoded.data === "string") {
        return decoded.data;
      }
    } catch {
      // ignore decode errors
    }
  }
  return raw;
}

export function getBlockedPubkeys(settings) {
  return normalizeListInput(settings?.nostrBlockedPubkeys || []).map(normalizePubkey).filter(Boolean);
}
