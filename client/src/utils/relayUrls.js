export function normalizeWsRelayUrl(input, { allowWs = true } = {}) {
  const trimmed = String(input || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
  if (!trimmed) return "";
  const base = trimmed.replace(/\/+$/, "");
  const withScheme = /^wss?:\/\//i.test(base) ? base : `wss://${base}`;
  try {
    const url = new URL(withScheme);
    if (url.username || url.password) return "";
    if (url.protocol === "ws:" && !allowWs) return "";
    if (!["ws:", "wss:"].includes(url.protocol)) return "";
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function parseRelayListText(text, { allowWs = true, max = 50 } = {}) {
  const lines = String(text || "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const relays = [];
  const invalid = [];
  for (const raw of lines) {
    if (relays.length >= max) break;
    const normalized = normalizeWsRelayUrl(raw, { allowWs });
    if (!normalized) {
      invalid.push(raw);
      continue;
    }
    if (!relays.includes(normalized)) relays.push(normalized);
  }

  return { relays, invalid };
}
