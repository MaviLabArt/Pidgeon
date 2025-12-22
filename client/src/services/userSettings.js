import { fetchEventsOnce, publishEvents } from "@/nostr/pool.js";
import { resolveRelays } from "@/nostr/config.js";

const SETTINGS_KIND = 30078;
const SETTINGS_DTAG = "pidgeon:settings:v1";
const SETTINGS_SCHEMA = {
  type: "settings",
  app: "pidgeon",
  version: 1,
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

function getNostr() {
  if (typeof window === "undefined") throw new Error("Connect a Nostr signer first");
  const nostr = window.nostrSigner || window.nostrShim || window.nostr;
  if (!nostr) throw new Error("Connect a Nostr signer first");
  return nostr;
}

async function getPubkey(nostr, fallback) {
  if (fallback) return fallback;
  if (typeof nostr.getPublicKey === "function") return nostr.getPublicKey();
  return "";
}

function pickNip44Encryptor(nostr) {
  if (typeof nostr?.nip44Encrypt === "function") {
    return (pubkey, plaintext) => nostr.nip44Encrypt(pubkey, plaintext);
  }
  if (typeof nostr?._call === "function") {
    return (pubkey, plaintext) => nostr._call("nip44.encrypt", [pubkey, plaintext]);
  }
  if (typeof nostr?.nip44?.encrypt === "function") {
    return (pubkey, plaintext) => nostr.nip44.encrypt(pubkey, plaintext);
  }
  throw new Error("nip44 encryptor required");
}

function pickNip44Decryptor(nostr) {
  if (typeof nostr?.nip44Decrypt === "function") {
    return (pubkey, ciphertext) => nostr.nip44Decrypt(pubkey, ciphertext);
  }
  if (typeof nostr?._call === "function") {
    return (pubkey, ciphertext) => nostr._call("nip44.decrypt", [pubkey, ciphertext]);
  }
  if (typeof nostr?.nip44?.decrypt === "function") {
    return (pubkey, ciphertext) => nostr.nip44.decrypt(pubkey, ciphertext);
  }
  throw new Error("nip44 decryptor required");
}

function looksLikeCiphertext(content) {
  if (typeof content !== "string") return false;
  const s = content.trim();
  if (!s) return false;
  // Support both encrypted and plaintext JSON settings payloads.
  if (s.startsWith("{") || s.startsWith("[")) return false;
  if (s.includes("?iv=")) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(s);
}

function normalizeUploadBackend(input) {
  return input === "nip96" ? "nip96" : "blossom";
}

function normalizeText(val) {
  if (val === undefined || val === null) return "";
  return String(val);
}

function normalizePublishRelaysMode(input) {
  const mode = String(input || "").trim();
  if (mode === "nip65" || mode === "custom") return mode;
  return "recommended";
}

function normalizePublishRelays(input) {
  const v = input && typeof input === "object" ? input : {};
  const mode = normalizePublishRelaysMode(v.mode);
  const custom = normalizeText(v.custom).trim();
  return { mode, custom };
}

function normalizeMediaServersMode(input) {
  const mode = String(input || "").trim();
  if (mode === "recommended" || mode === "my" || mode === "custom") return mode;
  // Backwards compatible default: older versions used explicit backend + server fields.
  return "custom";
}

function normalizeMediaServersPrefer(input) {
  return String(input || "").trim() === "nip96" ? "nip96" : "blossom";
}

function normalizeMediaServers(input) {
  const v = input && typeof input === "object" ? input : {};
  const mode = normalizeMediaServersMode(v.mode);
  const prefer = normalizeMediaServersPrefer(v.prefer);
  return { mode, prefer };
}

function normalizeDvm(input) {
  const v = input && typeof input === "object" ? input : null;
  if (!v) return null;
  const pubkey = normalizeText(v.pubkey).trim();
  const rawRelays = Array.isArray(v.relays)
    ? v.relays.map((x) => normalizeText(x).trim()).filter(Boolean)
    : normalizeText(v.relays)
        .split(/[, \n]/)
        .map((x) => normalizeText(x).trim())
        .filter(Boolean);
  const relays = rawRelays.slice(0, 50).join("\n");
  if (!pubkey && !relays) return null;
  return { pubkey, relays };
}

function normalizeSupportInvoiceSats(input) {
  const n = Math.floor(Number(input) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function buildPayload(settings) {
  const updatedAt = nowSeconds();
  const dvm = normalizeDvm(settings?.dvm);
  return {
    ...SETTINGS_SCHEMA,
    updatedAt,
    uploadBackend: normalizeUploadBackend(settings?.uploadBackend),
    nip96Service: normalizeText(settings?.nip96Service).trim(),
    blossomServers: normalizeText(settings?.blossomServers).trim(),
    mediaServers: normalizeMediaServers(settings?.mediaServers),
    analyticsEnabled: Boolean(settings?.analyticsEnabled),
    publishRelays: normalizePublishRelays(settings?.publishRelays),
    supportInvoiceSats: normalizeSupportInvoiceSats(settings?.supportInvoiceSats),
    ...(dvm ? { dvm } : {}),
  };
}

function parsePayload(raw) {
  const parsed = raw && typeof raw === "object" ? raw : null;
  if (!parsed) throw new Error("Invalid settings payload");
  if (
    parsed.type !== SETTINGS_SCHEMA.type ||
    parsed.app !== SETTINGS_SCHEMA.app ||
    Number(parsed.version) !== SETTINGS_SCHEMA.version
  ) {
    throw new Error("Not a Pidgeon settings payload");
  }
  const dvm = normalizeDvm(parsed.dvm);
  return {
    uploadBackend: normalizeUploadBackend(parsed.uploadBackend),
    nip96Service: normalizeText(parsed.nip96Service).trim(),
    blossomServers: normalizeText(parsed.blossomServers).trim(),
    mediaServers: normalizeMediaServers(parsed.mediaServers),
    analyticsEnabled: Boolean(parsed.analyticsEnabled),
    publishRelays: normalizePublishRelays(parsed.publishRelays),
    supportInvoiceSats: normalizeSupportInvoiceSats(parsed.supportInvoiceSats),
    ...(dvm ? { dvm } : {}),
  };
}

async function decryptSettings(nostr, pubkey, ciphertext) {
  const fn44 = pickNip44Decryptor(nostr);
  const plaintext = await fn44(pubkey, ciphertext);
  const parsed = JSON.parse(plaintext);
  return parsePayload(parsed);
}

async function encryptSettings(nostr, pubkey, payload) {
  const fn44 = pickNip44Encryptor(nostr);
  // Keep the Amber draft workaround (avoid decrypted plaintext starting with `{`/`[`).
  const plaintext = `\n${JSON.stringify(payload)}`;
  return fn44(pubkey, plaintext);
}

function latestEvent(events = []) {
  return (Array.isArray(events) ? events : []).reduce((acc, ev) => {
    if (!ev) return acc;
    if (!acc) return ev;
    return (Number(ev.created_at) || 0) > (Number(acc.created_at) || 0) ? ev : acc;
  }, null);
}

export async function fetchUserSettings(pubkey, relays = []) {
  if (!pubkey) return null;
  const nostr = getNostr();
  const targetRelays = resolveRelays(relays);
  if (!targetRelays.length) throw new Error("No relays configured for settings");

  const events = await fetchEventsOnce(targetRelays, {
    kinds: [SETTINGS_KIND],
    authors: [pubkey],
    "#d": [SETTINGS_DTAG],
    limit: 16,
  });
  const ev = latestEvent(events);
  if (!ev?.content) return null;

  const content = String(ev.content || "");
  if (looksLikeCiphertext(content)) {
    try {
      const settings = await decryptSettings(nostr, pubkey, content);
      return {
        settings,
        eventId: ev.id || "",
        createdAt: Number(ev.created_at) || 0,
      };
    } catch (err) {
      throw new Error(err?.message || "Failed to decrypt settings");
    }
  }

  return {
    settings: parsePayload(JSON.parse(content)),
    eventId: ev.id || "",
    createdAt: Number(ev.created_at) || 0,
  };
}

export async function saveUserSettings({ pubkey, settings, relays = [] }) {
  const nostr = getNostr();
  const signerPubkey = await getPubkey(nostr, pubkey);
  if (!signerPubkey) throw new Error("Connect a Nostr signer first");

  const payload = buildPayload(settings);
  const targetRelays = resolveRelays(relays);
  if (!targetRelays.length) throw new Error("No relays configured for settings");

  let content = "";
  let encrypted = false;
  try {
    content = await encryptSettings(nostr, signerPubkey, payload);
    encrypted = true;
  } catch {
    content = JSON.stringify(payload);
  }

  const event = await nostr.signEvent({
    kind: SETTINGS_KIND,
    created_at: payload.updatedAt || nowSeconds(),
    tags: [
      ["d", SETTINGS_DTAG],
      ["k", String(SETTINGS_SCHEMA.version)],
    ],
    content,
    pubkey: signerPubkey,
  });

  await publishEvents(targetRelays, event);

  return {
    settings: parsePayload(payload),
    eventId: event.id || "",
    createdAt: Number(event.created_at) || payload.updatedAt || nowSeconds(),
    encrypted,
  };
}
