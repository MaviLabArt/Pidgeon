const URL_REGEX = /\bhttps?:\/\/[^\s<]+/gi;

function countChar(input, char) {
  let count = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === char) count += 1;
  }
  return count;
}

function shouldStripTrailingCloser(url, closer, opener) {
  const openCount = countChar(url, opener);
  const closeCount = countChar(url, closer);
  return closeCount > openCount;
}

function splitUrlSuffix(raw) {
  let url = String(raw || "").trim();
  let suffix = "";

  const stripAlways = new Set([".", ",", ";", ":", "!", "?", "\"", "'", "”", "’", "»"]);
  const bracketPairs = [
    { closer: ")", opener: "(" },
    { closer: "]", opener: "[" },
    { closer: "}", opener: "{" },
    { closer: ">", opener: "<" },
  ];

  while (url) {
    const last = url[url.length - 1];
    if (stripAlways.has(last)) {
      suffix = last + suffix;
      url = url.slice(0, -1);
      continue;
    }

    const pair = bracketPairs.find((p) => p.closer === last);
    if (pair && shouldStripTrailingCloser(url, pair.closer, pair.opener)) {
      suffix = last + suffix;
      url = url.slice(0, -1);
      continue;
    }

    break;
  }

  return { url, suffix };
}

export function tokenizeTextWithUrls(text) {
  const input = String(text ?? "");
  const tokens = [];
  let lastIndex = 0;

  const regex = new RegExp(URL_REGEX.source, URL_REGEX.flags);
  let match;
  while ((match = regex.exec(input)) !== null) {
    const start = match.index;
    const raw = match[0];
    if (start > lastIndex) {
      tokens.push({ type: "text", value: input.slice(lastIndex, start) });
    }

    const { url, suffix } = splitUrlSuffix(raw);
    if (url) {
      tokens.push({ type: "url", value: url });
    } else {
      tokens.push({ type: "text", value: raw });
    }
    if (suffix) tokens.push({ type: "text", value: suffix });

    lastIndex = start + raw.length;
  }

  if (lastIndex < input.length) {
    tokens.push({ type: "text", value: input.slice(lastIndex) });
  }

  return tokens;
}

export function extractUrls(text) {
  return tokenizeTextWithUrls(text)
    .filter((t) => t.type === "url")
    .map((t) => t.value);
}

export function isImageUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    if (host === "picsum.photos" || host.endsWith(".picsum.photos")) return true;
    return /\.(png|jpe?g|gif|webp|avif)$/.test(path);
  } catch {
    return /\.(png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(raw);
  }
}

export function extractImageUrls(text, { limit = 6 } = {}) {
  const out = [];
  const seen = new Set();
  for (const url of extractUrls(text)) {
    if (!isImageUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}
