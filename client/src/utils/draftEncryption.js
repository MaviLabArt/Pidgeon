// Nostr draft encryption helpers.
//
// Draft payloads are encrypted and published as kind 31234 events.
//
// - Drafts use NIP-44 only.

export const DRAFT_ENCRYPTION_SCHEMA = {
  type: "draft",
  app: "pidgeon",
  version: 2
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const normalizeNumericSeconds = (num) => {
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  // Treat large values as milliseconds and down-convert to seconds.
  return Math.floor(abs >= 1e11 ? num / 1000 : num);
};

const normalizeTags = (tags) => {
  if (Array.isArray(tags)) return tags.join(",");
  if (tags === undefined || tags === null) return "";
  return String(tags);
};

const toSeconds = (val, fallback = nowSeconds()) => {
  if (typeof val === "number" && Number.isFinite(val)) {
    const normalized = normalizeNumericSeconds(val);
    return normalized === null ? fallback : normalized;
  }
  if (val instanceof Date && !Number.isNaN(val.valueOf())) {
    return Math.floor(val.valueOf() / 1000);
  }
  if (typeof val === "string") {
    const str = val.trim();
    if (!str) return fallback;
    if (/^-?\d+(?:\.\d+)?$/.test(str)) {
      const num = Number(str);
      const normalized = normalizeNumericSeconds(num);
      if (normalized !== null) return normalized;
    }
    const n = Date.parse(str);
    return Number.isNaN(n) ? fallback : Math.floor(n / 1000);
  }
  return fallback;
};

export function buildDraftPayload(draft) {
  const ts = nowSeconds();
  return {
    ...DRAFT_ENCRYPTION_SCHEMA,
    id: draft.id,
    content: draft.content || "",
    tags: normalizeTags(draft.tags),
    createdAt: toSeconds(draft.createdAt, ts),
    updatedAt: draft.updatedAt ? toSeconds(draft.updatedAt, ts) : ts
  };
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

export async function encryptDraft(nostr, pubkey, draft) {
  if (!nostr || !pubkey) throw new Error("Nostr signer/pubkey required for draft encryption");
  // Amber 4.0.3+ attempts to parse decrypted plaintext that starts with `{`/`[` as a Nostr event/tag array
  // (before it even shows the approval UI). Our drafts are JSON but not Nostr events, so we add a leading
  // newline to keep the plaintext from starting with `{` and avoid Amber crashing/hanging on decrypt.
  const payload = `\n${JSON.stringify(buildDraftPayload(draft))}`;
  const fn44 = pickNip44Encryptor(nostr);
  return await fn44(pubkey, payload);
}

export async function decryptDraft(nostr, pubkey, ciphertext) {
  if (!nostr || !pubkey) throw new Error("Nostr signer/pubkey required for draft decryption");
  const fn44 = pickNip44Decryptor(nostr);
  const plaintext = await fn44(pubkey, ciphertext);

  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Not a valid draft payload");
  }
  if (
    parsed?.type !== DRAFT_ENCRYPTION_SCHEMA.type ||
    parsed?.app !== DRAFT_ENCRYPTION_SCHEMA.app ||
    parsed?.version !== DRAFT_ENCRYPTION_SCHEMA.version
  ) {
    throw new Error("Not a valid draft payload");
  }
  if (!parsed?.id || typeof parsed.id !== "string") {
    throw new Error("Not a valid draft payload");
  }
  const createdAt = toSeconds(parsed.createdAt);
  const updatedAt = toSeconds(parsed.updatedAt, createdAt);
  return {
    ...parsed,
    id: parsed.id,
    content: typeof parsed.content === "string" ? parsed.content : "",
    tags: normalizeTags(parsed.tags),
    createdAt,
    updatedAt
  };
}
