// Lightweight draft builder inspired by Jumble. Adds hashtags, manual tags, mentions, reply/quote refs, imeta, client tag, and optional NSFW tag.
import { nip19 } from "nostr-tools";
import { getImetaTagByUrl } from "../services/mediaUpload.js";

const CLIENT_TAG = ["client", "Pidgeon"];

function unique(array) {
  return Array.from(new Set(array.filter(Boolean)));
}

function extractUrls(content = "") {
  return (content.match(/\bhttps?:\/\/\S+/gi) || []).map((u) => u.trim());
}

export function extractHashtags(content = "") {
  const regex = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
  const tags = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    tags.push(match[2].toLowerCase());
  }
  return unique(tags);
}

export function parseManualTags(input = "") {
  return unique(
    String(input)
      .split(/[,\n]/)
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean)
  );
}

function decodeNostrRef(ref) {
  try {
    const decoded = nip19.decode(ref);
    return decoded;
  } catch {
    return null;
  }
}

function extractReferences(content = "") {
  const pTags = [];
  const eTags = [];
  const matches = content.match(/\b(?:nostr:)?(npub1\w+|nprofile1\w+|note1\w+|nevent1\w+)\b/gi) || [];
  for (const raw of matches) {
    const ref = raw.replace(/^nostr:/i, "");
    const decoded = decodeNostrRef(ref);
    if (!decoded) continue;
    if (decoded.type === "npub" || decoded.type === "nprofile") {
      const pub = typeof decoded.data === "string" ? decoded.data : decoded.data?.pubkey;
      if (pub) pTags.push(["p", pub]);
    }
    if (decoded.type === "note" || decoded.type === "nevent") {
      const id = typeof decoded.data === "string" ? decoded.data : decoded.data?.id;
      const relay = Array.isArray(decoded.data?.relays) ? decoded.data.relays[0] : "";
      if (id) eTags.push(["e", id, relay, "mention"]);
    }
  }
  return { pTags: unique(pTags.map((t) => JSON.stringify(t))).map((s) => JSON.parse(s)), eTags: unique(eTags.map((t) => JSON.stringify(t))).map((s) => JSON.parse(s)) };
}

export function buildDraftEvent({
  content = "",
  manualTags = "",
  uploadTags = [],
  imetaResolver = getImetaTagByUrl,
  addClientTag = true,
  nsfw = false,
  relayHints = []
} = {}) {
  const tags = [];
  if (addClientTag) tags.push(CLIENT_TAG);
  if (nsfw) tags.push(["content-warning", "nsfw"]);

  const tagSet = new Set();
  parseManualTags(manualTags).forEach((t) => tagSet.add(t));
  extractHashtags(content).forEach((t) => tagSet.add(t));
  Array.from(tagSet).forEach((t) => tags.push(["t", t]));

  const { pTags, eTags } = extractReferences(content);
  tags.push(...pTags, ...eTags);

  const imetaSeen = new Set();
  uploadTags.forEach((tag) => {
    if (Array.isArray(tag) && tag.length > 1) {
      if (tag[0] === "imeta") imetaSeen.add(JSON.stringify(tag));
      tags.push(tag);
    }
  });

  if (typeof imetaResolver === "function") {
    extractUrls(content).forEach((url) => {
      const imetaTag = imetaResolver(url);
      if (Array.isArray(imetaTag) && imetaTag[0] === "imeta") {
        const key = JSON.stringify(imetaTag);
        if (!imetaSeen.has(key)) {
          imetaSeen.add(key);
          tags.push(imetaTag);
        }
      }
    });
  }

  if (relayHints.length) {
    tags.push(["relays", ...relayHints]);
  }

  return {
    kind: 1,
    content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };
}
