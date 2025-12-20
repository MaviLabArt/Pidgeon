import { bech32 } from "@scure/base";

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;

function normalizeHttpUrl(input) {
  const trimmed = String(input || "").replace(ZERO_WIDTH_RE, "").trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.username || url.password) return "";
    if (!["https:", "http:"].includes(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function lightningDeepLink(input) {
  const trimmed = String(input || "").replace(ZERO_WIDTH_RE, "").trim();
  if (!trimmed) return "";
  if (/^lightning:/i.test(trimmed)) return trimmed;
  return `lightning:${trimmed}`;
}

export function decodeLnurlToUrl(input) {
  const trimmed = String(input || "").replace(ZERO_WIDTH_RE, "").trim();
  if (!trimmed) return "";

  const bare = trimmed.replace(/^lightning:/i, "");
  if (!/^lnurl1/i.test(bare)) return "";

  try {
    const decoded = bech32.decode(bare, 2048);
    if (String(decoded.prefix || "").toLowerCase() !== "lnurl") return "";
    const bytes = bech32.fromWords(decoded.words);
    const text = new TextDecoder().decode(Uint8Array.from(bytes));
    return normalizeHttpUrl(text);
  } catch {
    return "";
  }
}

export function resolveLnurlPayUrl(input) {
  const trimmed = String(input || "").replace(ZERO_WIDTH_RE, "").trim();
  if (!trimmed) return "";
  const bare = trimmed.replace(/^lightning:/i, "");

  if (/^lnurl1/i.test(bare)) return decodeLnurlToUrl(bare);
  if (/^https?:\/\//i.test(bare)) return normalizeHttpUrl(bare);

  const match = bare.match(/^([^@\s]+)@([^@\s]+)$/);
  if (match) {
    const name = match[1];
    const domain = match[2];
    return normalizeHttpUrl(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`);
  }

  return "";
}

