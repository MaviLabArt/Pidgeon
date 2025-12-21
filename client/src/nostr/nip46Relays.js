import { parseRelayListText } from "@/utils/relayUrls.js";

export const LS_NIP46_RELAYS = "pidgeon.nip46.relays";

export const DEFAULT_NIP46_RELAYS = [
  // nsec.app / nsecBunker default relay
  "wss://relay.nsec.app",
  // Fallback public relays
  "wss://nos.lol",
  "wss://relay.damus.io"
];

function allowWsByContext() {
  const protocol = typeof window !== "undefined" ? window.location?.protocol : "";
  return protocol !== "https:";
}

function readLocalString(key) {
  try {
    return String(window?.localStorage?.getItem(key) || "");
  } catch {
    return "";
  }
}

function parseRelayTextFlexible(text, { allowWs, max = 20 } = {}) {
  const normalized = String(text || "").replace(/[ \t]+/g, "\n");
  return parseRelayListText(normalized, { allowWs, max });
}

export function getNip46RelayConfig({ allowWs } = {}) {
  const effectiveAllowWs = typeof allowWs === "boolean" ? allowWs : allowWsByContext();
  const wsBlockedHint = effectiveAllowWs ? "" : " (ws:// relays are blocked on https://)";
  const fixHint = " Set relays in Settings → Advanced → Signer relays (NIP-46), or VITE_NIP46_RELAYS.";

  const lsRaw = readLocalString(LS_NIP46_RELAYS).trim();
  if (lsRaw) {
    const parsed = parseRelayTextFlexible(lsRaw, { allowWs: effectiveAllowWs, max: 20 });
    if (!parsed.relays.length) {
      return {
        relays: [],
        source: "localStorage",
        invalid: parsed.invalid || [],
        error: `No valid signer relays configured${wsBlockedHint}.${fixHint}`
      };
    }
    return { relays: parsed.relays, source: "localStorage", invalid: parsed.invalid || [], error: "" };
  }

  const envRaw = String(import.meta.env.VITE_NIP46_RELAYS || "").trim();
  if (envRaw) {
    const parsed = parseRelayTextFlexible(envRaw, { allowWs: effectiveAllowWs, max: 20 });
    if (!parsed.relays.length) {
      return {
        relays: [],
        source: "env",
        invalid: parsed.invalid || [],
        error: `No valid signer relays configured in VITE_NIP46_RELAYS${wsBlockedHint}.`
      };
    }
    return { relays: parsed.relays, source: "env", invalid: parsed.invalid || [], error: "" };
  }

  const relays = DEFAULT_NIP46_RELAYS.filter((r) => (effectiveAllowWs ? r.startsWith("ws") : r.startsWith("wss://")));
  return {
    relays,
    source: "default",
    invalid: [],
    error: relays.length ? "" : "No default signer relays available."
  };
}

export function getNip46Relays(opts) {
  return getNip46RelayConfig(opts).relays;
}
