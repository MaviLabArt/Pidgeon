function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstTagValue(tags, name) {
  const list = safeArray(tags);
  const t = list.find((x) => Array.isArray(x) && x[0] === name);
  return t ? String(t[1] || "").trim() : "";
}

function findRepostTarget(tags) {
  const list = safeArray(tags);
  const match = list.find((x) => Array.isArray(x) && x[0] === "pidgeon" && x[1] === "repost");
  return match ? String(match[2] || "").trim() : "";
}

function findQuoteTarget(tags) {
  const list = safeArray(tags);
  const match = list.find((x) => Array.isArray(x) && x[0] === "pidgeon" && x[1] === "quote");
  return match ? String(match[2] || "").trim() : "";
}

function findQTagTarget(tags) {
  const list = safeArray(tags);
  const match = list.find((x) => Array.isArray(x) && x[0] === "q" && typeof x[1] === "string");
  return match ? String(match[1] || "").trim() : "";
}

function findQTagRelay(tags) {
  const list = safeArray(tags);
  const match = list.find((x) => Array.isArray(x) && x[0] === "q" && typeof x[1] === "string");
  const relay = match && typeof match[2] === "string" ? String(match[2] || "").trim() : "";
  return relay;
}

function findQTagPubkey(tags) {
  const list = safeArray(tags);
  const match = list.find((x) => Array.isArray(x) && x[0] === "q" && typeof x[1] === "string");
  const pk = match && typeof match[3] === "string" ? String(match[3] || "").trim() : "";
  return pk;
}

export function parseEmbeddedNostrEventContent(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const pubkey = typeof parsed.pubkey === "string" ? parsed.pubkey : "";
    const sig = typeof parsed.sig === "string" ? parsed.sig : "";
    const kind = Number(parsed.kind) || 0;
    const content = typeof parsed.content === "string" ? parsed.content : "";
    if (!id || !pubkey || !sig || !kind) return null;
    return { id, pubkey, sig, kind, content };
  } catch {
    return null;
  }
}

export function isRepostJob(job) {
  if (!job) return false;
  if (job?.jobType === "dm17") return false;
  if (Number(job?.noteEvent?.kind) === 6) return true;
  if (Boolean(job?.isRepost)) return true;
  return Boolean(findRepostTarget(job?.tags));
}

export function isQuoteJob(job) {
  if (!job) return false;
  if (job?.jobType === "dm17") return false;
  if (findQTagTarget(job?.noteEvent?.tags)) return true;
  if (findQTagTarget(job?.tags)) return true;
  return Boolean(findQuoteTarget(job?.tags));
}

export function getRepostTargetId(job) {
  if (!job) return "";
  if (typeof job?.repostTargetId === "string" && job.repostTargetId.trim()) return job.repostTargetId.trim();
  const tagged = findRepostTarget(job?.tags);
  if (tagged) return tagged;
  const fromNoteEvent = firstTagValue(job?.noteEvent?.tags, "e");
  if (fromNoteEvent) return fromNoteEvent;
  return firstTagValue(job?.tags, "e");
}

export function getQuoteTargetId(job) {
  if (!job) return "";
  const tagged = findQuoteTarget(job?.tags);
  if (tagged) return tagged;
  const fromQTag = findQTagTarget(job?.noteEvent?.tags) || findQTagTarget(job?.tags);
  if (fromQTag) return fromQTag;
  return "";
}

export function getQuoteTargetInfo(job) {
  const noteTags = safeArray(job?.noteEvent?.tags);
  const baseTags = safeArray(job?.tags);
  const id = findQuoteTarget(baseTags) || findQTagTarget(noteTags) || findQTagTarget(baseTags) || "";
  const relay = findQTagRelay(noteTags) || findQTagRelay(baseTags) || "";
  const pubkey = findQTagPubkey(noteTags) || findQTagPubkey(baseTags) || "";
  return { id, relay, pubkey };
}

function stripTrailingNostrRefLine(content = "") {
  const s = String(content || "");
  if (!s.trim()) return s;
  const lines = s.split(/\r?\n/);
  while (lines.length && !String(lines[lines.length - 1] || "").trim()) lines.pop();
  if (!lines.length) return "";
  const last = String(lines[lines.length - 1] || "").trim();
  if (/^(?:nostr:)?(?:note1|nevent1)[023456789acdefghjklmnpqrstuvwxyz]+$/i.test(last)) {
    lines.pop();
    while (lines.length && !String(lines[lines.length - 1] || "").trim()) lines.pop();
  }
  return lines.join("\n");
}

export function getJobDisplayContent(job) {
  const base = String(job?.content || "");
  if (isQuoteJob(job)) return stripTrailingNostrRefLine(base);
  if (!isRepostJob(job)) return base;

  const embeddedFromNote = parseEmbeddedNostrEventContent(job?.noteEvent?.content);
  if (embeddedFromNote && Number(embeddedFromNote.kind) === 1 && String(embeddedFromNote.content || "").trim()) {
    return String(embeddedFromNote.content || "");
  }

  const embeddedFromBase = parseEmbeddedNostrEventContent(base);
  if (embeddedFromBase && Number(embeddedFromBase.kind) === 1 && String(embeddedFromBase.content || "").trim()) {
    return String(embeddedFromBase.content || "");
  }

  const targetId = getRepostTargetId(job);
  if (targetId && (!base || base.trim().startsWith("{"))) return `Repost ${targetId.slice(0, 12)}…`;
  return base;
}
