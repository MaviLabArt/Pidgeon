import { absoluteApiUrl } from "./api.js";

const cache = new Map();

function normalizeServiceUrl(service) {
  const trimmed = String(service || "").trim();
  if (!trimmed) return "";
  const base = trimmed.replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  try {
    const url = new URL(withScheme);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export async function resolveServiceUrl(service) {
  const base = normalizeServiceUrl(service);
  if (!base) throw new Error("service required");
  const key = `nip96:${base}`;
  if (cache.has(key)) return cache.get(key);

  let lastErr = null;

  const fetchWellKnown = async () => {
    const wellKnown = `${base}/.well-known/nostr/nip96.json`;
    const resp = await fetch(wellKnown).catch(() => null);
    if (!resp || !resp.ok) throw new Error("Failed to fetch nip96.json");
    const data = await resp.json();
    const url = data?.api_url;
    if (!url) throw new Error("nip96.json missing api_url");
    return url;
  };

  const fetchViaProxy = async () => {
    const url = absoluteApiUrl(`/api/nip96/resolve?service=${encodeURIComponent(base)}`);
    const resp = await fetch(url, { credentials: "include" }).catch(() => null);
    if (!resp || !resp.ok) throw new Error("Failed to resolve nip96 via proxy");
    const data = await resp.json().catch(() => ({}));
    const apiUrl = data?.uploadUrl;
    if (!apiUrl) throw new Error("Failed to resolve nip96 service");
    return apiUrl;
  };

  for (const resolver of [fetchWellKnown, fetchViaProxy]) {
    try {
      const url = await resolver();
      cache.set(key, url);
      return url;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error("Failed to resolve nip96 service");
}

export async function signNip98Auth(url, method = "POST", signal) {
  if (typeof window === "undefined" || !window.nostr?.signEvent || !window.nostr?.getPublicKey) {
    throw new Error("Nostr signer required for upload");
  }
  const pubkey = await window.nostr.getPublicKey();
  const ev = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
    ],
    content: "",
    pubkey,
  };
  if (signal?.aborted) throw new Error("Upload aborted");
  const signed = await window.nostr.signEvent(ev);
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(signed))));
  return `Nostr ${payload}`;
}
