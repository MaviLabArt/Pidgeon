import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, nip44 } from "nostr-tools";
import { publishEvents } from "./pool.js";
import { nip44EncryptWithKey, nip44DecryptWithKey, b64uToBytesSafe, bytesToB64uString } from "./crypto.js";
import { REQUIRED_NIP46_PERMS } from "./auth/nip46Perms.js";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { bytesToHex } from "@noble/hashes/utils";

const envRelays = (import.meta.env.VITE_DVM_RELAYS || "")
  .split(/[, \n]/)
  .map((s) => s.trim())
  .filter(Boolean);
const envPublishRelays = (import.meta.env.VITE_DVM_PUBLISH_RELAYS || "")
  .split(/[, \n]/)
  .map((s) => s.trim())
  .filter(Boolean);
const envPubkey = import.meta.env.VITE_DVM_PUBKEY || "";
const LS_DVM_PUBKEY = "pidgeon.dvm.pubkey";
const LS_DVM_RELAYS = "pidgeon.dvm.relays";
const LS_DVM_PUBLISH_RELAYS = "pidgeon.dvm.publishRelays";

function normalizeRelays(list = []) {
  const protocol = typeof window !== "undefined" ? window.location.protocol : "";
  const isHttps = protocol === "https:";
  return list
    .map((u) => String(u || "").trim())
    .filter(Boolean)
    .filter((u) => {
      // When served over https, browsers block ws:// mixed content.
      if (isHttps) return u.startsWith("wss://");
      // When served over http (or unknown), allow both ws:// and wss://.
      return u.startsWith("ws://") || u.startsWith("wss://");
    });
}

function normalizePubkey(pubkey = "") {
  const raw = String(pubkey || "").trim();
  if (!raw) return "";
  if (raw.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type === "npub" && typeof decoded.data === "string") return decoded.data;
    } catch {
      /* ignore */
    }
  }
  return raw;
}

function splitList(s) {
  return String(s || "")
    .split(/[, \n]/)
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function readDvmRuntimeOverrides() {
  const w = typeof window !== "undefined" ? window : null;
  if (!w) return { pubkey: "", relays: null, publishRelays: null };

  let params;
  try {
    params = new URLSearchParams(w.location?.search || "");
  } catch {
    params = new URLSearchParams();
  }

  const qPubkey = String(params.get("dvmPubkey") || params.get("dvm_pubkey") || "").trim();
  const qRelays = String(params.get("dvmRelays") || params.get("dvm_relays") || "").trim();
  const qPublishRelays = String(params.get("dvmPublishRelays") || params.get("dvm_publish_relays") || "").trim();

  let lsPubkey = "";
  let lsRelays = "";
  let lsPublishRelays = "";
  try {
    lsPubkey = String(w.localStorage?.getItem(LS_DVM_PUBKEY) || "").trim();
    lsRelays = String(w.localStorage?.getItem(LS_DVM_RELAYS) || "").trim();
    lsPublishRelays = String(w.localStorage?.getItem(LS_DVM_PUBLISH_RELAYS) || "").trim();
  } catch {}

  const pubkey = qPubkey || lsPubkey || "";
  const relaysRaw = qRelays || lsRelays;
  const publishRelaysRaw = qPublishRelays || lsPublishRelays;

  return {
    pubkey,
    relays: relaysRaw ? splitList(relaysRaw) : null,
    publishRelays: publishRelaysRaw ? splitList(publishRelaysRaw) : null
  };
}

export function getDvmConfig(overrides = {}) {
  const rt = readDvmRuntimeOverrides();
  const relays = normalizeRelays(overrides.relays || rt.relays || envRelays);
  const pubkey = normalizePubkey(overrides.pubkey || rt.pubkey || envPubkey);
  return { relays, pubkey };
}

export function getDvmPublishRelays(overrides = {}) {
  const rt = readDvmRuntimeOverrides();
  const raw =
    overrides.publishRelays ||
    rt.publishRelays ||
    (Array.isArray(envPublishRelays) && envPublishRelays.length ? envPublishRelays : envRelays);
  const relays = normalizeRelays(raw);
  return { relays };
}

const MASTER_KIND = 5900;
const MASTER_REQUEST_KIND = 5901;
const DM_REQUEST_KIND = 5906;
const DM_RETRY_KIND = 5907;
const MAILBOX_REPAIR_KIND = 5908;
const SUPPORT_ACTION_KIND = 5910;
const GIFT_WRAP_KIND = 1059;
const SEAL_KIND = 13;
const ROOT_CACHE_PREFIX = "pidgeon.root.";
const MB_CACHE_PREFIX = "pidgeon.mb.";
const PKV_CACHE_PREFIX = "pidgeon.pkv.";
const PKV_CAPSULE_PREFIX = "pidgeon.pkvCapsule.";
const secretsState = new Map(); // scoped by `${pubkey}:${dvmPubkey}` -> { promise }
const PROTO_VERSION = 3;
const MASTER_WRAP_TAG = "pidgeon-master-v3";

function hkdfKey(rootKeyBytes, label, len = 32) {
  const salt = new Uint8Array();
  const info = new TextEncoder().encode(String(label || ""));
  return hkdf(sha256, rootKeyBytes, salt, info, len);
}

function isDebugEnabled() {
  try {
    return (
      (typeof import.meta !== "undefined" && import.meta.env?.VITE_DEBUG_NOSTR === "1") ||
      (typeof import.meta !== "undefined" && import.meta.env?.VITE_DEBUG_NIP46 === "1")
    );
  } catch {
    return false;
  }
}

function isNip44DecryptBlockingError(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("nip44 not supported") ||
    msg.includes("nip44_decrypt timed out") ||
    msg.includes("remote signer nip44_decrypt")
  );
}

async function preflightGiftWrapDecrypt({ signer, userPubkey }) {
  // Avoid extra prompts for NIP-07 flows; this is mainly for remote signers that might hang on nip44_decrypt.
  const w = typeof window !== "undefined" ? window : null;
  if (!w?.nostrSigner?.nip44Decrypt || !w?.nostrSigner?.nip44Encrypt) return;

  const debug = isDebugEnabled();
  const probeSk = generateSecretKey();
  const probePk = getPublicKey(probeSk);
  const convKey = nip44.v2.utils.getConversationKey(probeSk, userPubkey);
  const plaintext = `pidgeon:nip44:probe:${Date.now()}`;
  const ciphertext = nip44EncryptWithKey(convKey, plaintext);
  if (debug) {
    try {
      console.debug("[dvm] preflight nip44_decrypt", { from: probePk.slice(0, 8) + "…" });
    } catch {}
  }
  const roundtrip = await signer.nip44Decrypt(probePk, ciphertext);
  if (roundtrip !== plaintext) {
    throw new Error("Remote signer nip44_decrypt failed preflight");
  }
}

function getSignerApi() {
  const w = typeof window !== "undefined" ? window : null;
  const signer = w?.nostrSigner;
  if (signer?.signEvent && signer?.nip44Encrypt && signer?.nip44Decrypt) {
    return {
      signEvent: signer.signEvent.bind(signer),
      nip44Encrypt: signer.nip44Encrypt.bind(signer),
      nip44Decrypt: signer.nip44Decrypt.bind(signer)
    };
  }

  const nip07 = w?.nostr;
  if (nip07?.signEvent && nip07?.nip44?.encrypt && nip07?.nip44?.decrypt) {
    return {
      signEvent: nip07.signEvent.bind(nip07),
      nip44Encrypt: nip07.nip44.encrypt.bind(nip07.nip44),
      nip44Decrypt: nip07.nip44.decrypt.bind(nip07.nip44)
    };
  }

  return null;
}

function masterStorageKey(userPubkey, dvmPubkey) {
  const dvm = dvmPubkey || "default";
  return `${ROOT_CACHE_PREFIX}${dvm}:${userPubkey}`;
}

function mbStorageKey(userPubkey, dvmPubkey) {
  const dvm = dvmPubkey || "default";
  return `${MB_CACHE_PREFIX}${dvm}:${userPubkey}`;
}

function pkvStorageKey(userPubkey, dvmPubkey) {
  const dvm = dvmPubkey || "default";
  return `${PKV_CACHE_PREFIX}${dvm}:${userPubkey}`;
}

function pkvCapsuleStorageKey(userPubkey, dvmPubkey) {
  const dvm = dvmPubkey || "default";
  return `${PKV_CAPSULE_PREFIX}${dvm}:${userPubkey}`;
}

function pkvIdForKeyBytes(pkvBytes) {
  try {
    return bytesToHex(sha256(pkvBytes));
  } catch {
    return "";
  }
}

function buildPreviewKeyCapsule({ userPubkey, pkvBytes }) {
  const pkvId = pkvIdForKeyBytes(pkvBytes);
  const ephemeralSk = generateSecretKey();
  const eph = getPublicKey(ephemeralSk);
  const key = nip44.v2.utils.getConversationKey(ephemeralSk, userPubkey);
  const plaintext = `\n${JSON.stringify({ v: 1, pkv: bytesToB64uString(pkvBytes) })}`;
  const ct = nip44EncryptWithKey(key, plaintext);
  return {
    pkvId,
    capsule: {
      v: 1,
      alg: "nip44-to-user",
      eph,
      ct
    }
  };
}

async function fetchMailboxIndexJsonOnce({ userPubkey, mailboxKey, mb }) {
  const dvm = getDvmConfig();
  if (!dvm.pubkey || !dvm.relays.length) return null;
  const { fetchEventsOnce } = await import("./pool.js");
  const indexD = `pidgeon:v3:mb:${mb}:index`;
  const events = await fetchEventsOnce(dvm.relays, {
    kinds: [30078],
    authors: [dvm.pubkey],
    "#d": [indexD],
    limit: 1
  });
  const ev = events?.[0];
  if (!ev?.content) return null;
  try {
    const plain = nip44DecryptWithKey(mailboxKey, String(ev.content || ""));
    return JSON.parse(plain || "{}");
  } catch {
    return null;
  }
}

export async function ensurePreviewKey(userPubkey, { pkvIdHint } = {}) {
  if (!userPubkey) throw new Error("pubkey required");
  const dvm = getDvmConfig();
  if (!dvm.pubkey || !dvm.relays.length) throw new Error("DVM config missing");

  const cacheKey = pkvStorageKey(userPubkey, dvm.pubkey);
  const capsuleKey = pkvCapsuleStorageKey(userPubkey, dvm.pubkey);

  // 1) Local cache fast-path.
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const pkvBytes = b64uToBytesSafe(cached);
      const pkvId = pkvIdForKeyBytes(pkvBytes);
      let capsule = null;
      try {
        capsule = JSON.parse(localStorage.getItem(capsuleKey) || "null");
      } catch {}
      if (!capsule) {
        const rebuilt = buildPreviewKeyCapsule({ userPubkey, pkvBytes });
        capsule = rebuilt.capsule;
        try {
          localStorage.setItem(capsuleKey, JSON.stringify(capsule));
        } catch {}
      }
      return { pkvBytes, pkvId, capsule };
    }
  } catch {}

  // 2) Recover from mailbox index capsule (requires one nip44_decrypt).
  try {
    const { mailboxKey, mb } = await ensureMailboxSecrets(userPubkey);
    const indexJson = await fetchMailboxIndexJsonOnce({ userPubkey, mailboxKey, mb });
    const capsules = indexJson?.previewKeyCapsules && typeof indexJson.previewKeyCapsules === "object" ? indexJson.previewKeyCapsules : null;
    if (capsules) {
      const ids = Object.keys(capsules);
      const wanted = pkvIdHint && capsules[pkvIdHint] ? pkvIdHint : ids[0];
      const cap = capsules[wanted];
      if (cap?.eph && cap?.ct) {
        const signer = getSignerApi();
        if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);
        const plain = await signer.nip44Decrypt(String(cap.eph), String(cap.ct));
        const decoded = JSON.parse(plain || "{}");
        const pkvBytes = b64uToBytesSafe(String(decoded?.pkv || ""));
        const pkvId = pkvIdForKeyBytes(pkvBytes);
        try {
          localStorage.setItem(cacheKey, bytesToB64uString(pkvBytes));
          localStorage.setItem(capsuleKey, JSON.stringify(cap));
        } catch {}
        return { pkvBytes, pkvId, capsule: cap };
      }
    }
  } catch {
    // ignore and fall through to generating a new key
  }

  // 3) First-time setup: generate new pkv and capsule.
  const pkvBytes = generateSecretKey();
  const { pkvId, capsule } = buildPreviewKeyCapsule({ userPubkey, pkvBytes });
  try {
    localStorage.setItem(cacheKey, bytesToB64uString(pkvBytes));
    localStorage.setItem(capsuleKey, JSON.stringify(capsule));
  } catch {}
  return { pkvBytes, pkvId, capsule };
}

async function buildWrappedMasterRequest({ userPubkey, dvmPubkey }) {
  const signer = getSignerApi();
  if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");
  const created_at = Math.floor(Date.now() / 1000);
  const rumor = {
    kind: MASTER_REQUEST_KIND,
    created_at,
    tags: [
      ["p", targetPubkey],
      ["k", String(PROTO_VERSION)]
    ],
    content: JSON.stringify({ t: "pidgeon-master-request", v: PROTO_VERSION }),
    pubkey: userPubkey
  };
  rumor.id = getEventHash(rumor);

  const sealPayload = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  const sealDraft = { kind: SEAL_KIND, created_at, tags: [], content: sealPayload };
  const seal = await signer.signEvent(sealDraft);

  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, targetPubkey);
  const wrapContent = nip44EncryptWithKey(wrapKey, JSON.stringify(seal));
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at,
      tags: [["p", targetPubkey]],
      content: wrapContent,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
}

async function publishWrappedMasterRequest(dvmRelays, dvmPubkey, userPubkey) {
  const wrap = await buildWrappedMasterRequest({ userPubkey, dvmPubkey });
  await publishEvents(dvmRelays, wrap);
}

export async function ensureMailboxSecrets(userPubkey) {
  if (!userPubkey) throw new Error("pubkey required");

  const dvm = getDvmConfig();
  if (!dvm.pubkey || !dvm.relays.length) throw new Error("DVM config missing");

  const stateKey = `${userPubkey}:${dvm.pubkey}`;
  const existing = secretsState.get(stateKey);
  if (existing?.promise) return existing.promise;

  const run = (async () => {
    const debug = isDebugEnabled();
    const cacheKey = masterStorageKey(userPubkey, dvm.pubkey);
    const mbKey = mbStorageKey(userPubkey, dvm.pubkey);
    try {
      const cachedRoot = localStorage.getItem(cacheKey);
      const cachedMb = localStorage.getItem(mbKey);
      if (cachedRoot && cachedMb) {
        const rootKey = b64uToBytesSafe(cachedRoot);
        return {
          rootKey,
          mailboxKey: hkdfKey(rootKey, "pidgeon:v3:key:mailbox", 32),
          submitKey: hkdfKey(rootKey, "pidgeon:v3:key:submit", 32),
          dmKey: hkdfKey(rootKey, "pidgeon:v3:key:dm", 32),
          blobKey: hkdfKey(rootKey, "pidgeon:v3:key:blob", 32),
          mb: cachedMb
        };
      }
    } catch {}

    const signer = getSignerApi();
    if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);

    await preflightGiftWrapDecrypt({ signer, userPubkey }).catch((err) => {
      if (debug) {
        console.warn("[dvm] nip44_decrypt preflight failed", err?.message || err);
      }
      throw new Error(
        "Remote signer did not complete nip44_decrypt (required to unwrap the mailbox master key). " +
          "Check your bunker/nostrconnect for a pending decrypt approval, or reconnect and grant nip44_decrypt permission."
      );
    });

    const unwrapSeal = async (wrap) => {
      const sealJson = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
      const seal = JSON.parse(sealJson);
      if (seal.kind !== SEAL_KIND || (Array.isArray(seal.tags) && seal.tags.length)) {
        throw new Error("Invalid master seal");
      }
      const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
      const rumor = JSON.parse(rumorJson);
      return { seal, rumor };
    };

    const findValidMaster = async () => {
      const { fetchEventsOnce } = await import("./pool.js");
      const filterTagged = { kinds: [GIFT_WRAP_KIND], "#p": [userPubkey], "#t": [MASTER_WRAP_TAG], limit: 10 };
      const filterFallback = { kinds: [GIFT_WRAP_KIND], "#p": [userPubkey], limit: 10 };
      let decryptBlocked = null;

      const tryEvents = async (events) => {
        const ordered = Array.isArray(events) ? events.slice() : [];
        ordered.sort(
          (a, b) =>
            (Number(b?.created_at) || 0) - (Number(a?.created_at) || 0) ||
            String(a?.id || "").localeCompare(String(b?.id || ""))
        );
        // Only try a handful of newest wraps; avoid spamming remote signers with many nip44_decrypt calls.
        for (const wrap of ordered.slice(0, 3)) {
          try {
            const { rumor, seal } = await unwrapSeal(wrap);
            if (seal.pubkey !== dvm.pubkey) continue;
            if (rumor.kind !== MASTER_KIND) continue;
            const parsed = JSON.parse(rumor.content || "{}");
            const version = Number(parsed?.v);
            const t = String(parsed?.t || "");
            if (t !== "pidgeon-job-master" || version !== PROTO_VERSION || !parsed?.kr || !parsed?.mb) {
              continue;
            }
            return { rumor, seal };
          } catch (err) {
            // If the signer can't decrypt, stop scanning and fall back to requesting a fresh master wrap.
            // Some remote signers (e.g. Amber 4.0.3+) can hang/time out on older wrap payloads.
            if (isNip44DecryptBlockingError(err)) {
              decryptBlocked = err;
              break;
            }
            // ignore other errors and keep scanning
          }
        }
        return null;
      };

      // 1) Fast path: fetch existing wraps and scan newest-first.
      const initialTagged = await fetchEventsOnce(dvm.relays, filterTagged);
      let found = await tryEvents(initialTagged);
      if (found) return found;

      const initial = await fetchEventsOnce(dvm.relays, filterFallback);
      found = await tryEvents(initial);
      if (found) return found;

      // 2) Publish request, then wait for a matching wrap (bunker approvals can take time).
      if (debug) {
        try {
          console.debug("[dvm] master key not found; publishing wrapped master request");
        } catch {}
      }
      await publishWrappedMasterRequest(dvm.relays, dvm.pubkey, userPubkey);
      const timeoutMs = 30000;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        await new Promise((res) => setTimeout(res, 1200));
        const more = await fetchEventsOnce(dvm.relays, filterTagged);
        found = await tryEvents(more);
        if (found) return found;
      }
      // Final fallback scan without #t.
      const moreFallback = await fetchEventsOnce(dvm.relays, filterFallback);
      found = await tryEvents(moreFallback);
      if (found) return found;
      if (decryptBlocked) {
        throw new Error(
          "Remote signer did not complete nip44_decrypt while scanning mailbox keys. " +
            "This usually means nip44_decrypt isn't supported/approved, or your signer has a bug with certain ciphertexts. " +
            "Please approve decrypt in your signer, reconnect with nip44_decrypt permission, or try a different signer/version."
        );
      }
      return null;
    };

    const found = await findValidMaster();
    if (!found) throw new Error("Master key not available");
    const { rumor, seal } = found;
    if (seal.pubkey !== dvm.pubkey) {
      throw new Error("Master seal not from DVM");
    }
    if (rumor.kind !== MASTER_KIND) throw new Error("Invalid master rumor kind");
    const parsed = JSON.parse(rumor.content || "{}");
    const version = Number(parsed?.v);
    {
      const t = String(parsed?.t || "");
      if (t !== "pidgeon-job-master" || version !== PROTO_VERSION || !parsed?.kr || !parsed?.mb) {
        throw new Error("Invalid master payload");
      }
    }
    const rootKey = b64uToBytesSafe(parsed.kr);
    const mb = String(parsed.mb || "").trim();
    try {
      localStorage.setItem(cacheKey, bytesToB64uString(rootKey));
      localStorage.setItem(mbKey, mb);
    } catch {}
    return {
      rootKey,
      mailboxKey: hkdfKey(rootKey, "pidgeon:v3:key:mailbox", 32),
      submitKey: hkdfKey(rootKey, "pidgeon:v3:key:submit", 32),
      dmKey: hkdfKey(rootKey, "pidgeon:v3:key:dm", 32),
      blobKey: hkdfKey(rootKey, "pidgeon:v3:key:blob", 32),
      mb
    };
  })();
  secretsState.set(stateKey, { promise: run });
  try {
    const result = await run;
    secretsState.delete(stateKey);
    return result;
  } catch (err) {
    secretsState.delete(stateKey);
    throw err;
  }
}

export function clearMasterKeyCache(userPubkey) {
  if (!userPubkey) return;
  try {
    const dvm = getDvmConfig();
    const dvmPk = dvm.pubkey || "default";
    localStorage.removeItem(masterStorageKey(userPubkey, dvmPk));
    localStorage.removeItem(mbStorageKey(userPubkey, dvmPk));
  } catch {}
  const dvm = getDvmConfig();
  secretsState.delete(`${userPubkey}:${dvm.pubkey || "default"}`);
}

export async function encryptWithMasterKey(pubkey, payload) {
  const { mailboxKey } = await ensureMailboxSecrets(pubkey);
  return nip44EncryptWithKey(mailboxKey, JSON.stringify(payload));
}

export async function decryptWithMasterKey(pubkey, content) {
  if (typeof content !== "string") throw new Error("Invalid content");
  const { mailboxKey } = await ensureMailboxSecrets(pubkey);
  const plain = await nip44DecryptWithKey(mailboxKey, content);
  return JSON.parse(plain);
}

export async function buildScheduleRequest({ signedNote, relayHints = [], dvmPubkey, cap = null }) {
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");
  if (!signedNote?.id) throw new Error("Missing signed note for schedule request");
  const signer = getSignerApi();
  if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);

  const relays = relayHints ? normalizeRelays(relayHints) : [];
  const inputTags = [["i", JSON.stringify(signedNote), "text"]];
  if (relays.length) inputTags.push(["relays", ...relays]);

  const { submitKey } = await ensureMailboxSecrets(signedNote.pubkey);
  const payload = { tags: inputTags };
  if (cap && typeof cap === "object") payload.cap = cap;
  const content = nip44EncryptWithKey(submitKey, JSON.stringify(payload));

  const rumor = {
    kind: 5905,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", targetPubkey],
      ["k", String(PROTO_VERSION)],
      ...(relays.length ? [["relays", ...relays]] : [])
    ],
    content,
    pubkey: signedNote.pubkey
  };
  rumor.id = getEventHash(rumor);

  // Seal: signed by user, nip44 encrypted to DVM, tags must be empty
  const sealPayload = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  const sealDraft = {
    kind: SEAL_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: sealPayload
  };
  const seal = await signer.signEvent(sealDraft);

  // Gift wrap: random keypair, nip44 encrypted to DVM
  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, targetPubkey);
  const wrapContent = nip44EncryptWithKey(wrapKey, JSON.stringify(seal));
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", targetPubkey]],
      content: wrapContent,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
  wrap.requestId = rumor.id;
  return wrap;
}

export async function buildDm17ScheduleRequest({
  fromPubkey,
  toPubkeys,
  content,
  scheduledAt,
  dvmPubkey,
  cap = null
}) {
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");

  const senderPubkey = normalizePubkey(fromPubkey);
  if (!senderPubkey) throw new Error("Missing sender pubkey");

  const recipientList = (Array.isArray(toPubkeys) ? toPubkeys : [toPubkeys])
    .map(normalizePubkey)
    .filter(Boolean);
  if (!recipientList.length) throw new Error("Missing recipient pubkey");

  const scheduledAtSec = Number(scheduledAt) || 0;
  if (!scheduledAtSec) throw new Error("Missing scheduledAt");
  const nowSec = Math.floor(Date.now() / 1000);

  const signer = getSignerApi();
  if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);

  const { dmKey } = await ensureMailboxSecrets(senderPubkey);
  const { pkvBytes, pkvId, capsule } = await ensurePreviewKey(senderPubkey);

  const dmPlain = JSON.stringify({ v: 1, content: String(content || "") });
  const dmEnc = nip44EncryptWithKey(pkvBytes, dmPlain);
  const dmMeta = { bytes: dmPlain.length };

  const makeUnsignedKind14 = (recipientPubkey) => ({
    kind: 14,
    created_at: scheduledAtSec,
    pubkey: senderPubkey,
    tags: [["p", recipientPubkey]],
    content: String(content || "")
  });

  const makeSealForTarget = async (targetPk, unsignedKind14) => {
    const inner = await signer.nip44Encrypt(targetPk, JSON.stringify(unsignedKind14));
    // Some signers reject signing events dated far in the future; the seal timestamp doesn't need to match scheduledAt.
    const sealDraft = { kind: SEAL_KIND, created_at: nowSec, tags: [], content: inner };
    return signer.signEvent(sealDraft);
  };

  const recipients = [];
  for (const pk of recipientList) {
    // eslint-disable-next-line no-await-in-loop
    const seal = await makeSealForTarget(pk, makeUnsignedKind14(pk));
    recipients.push({ pubkey: pk, seal });
  }
  const senderCopySeal = await makeSealForTarget(senderPubkey, makeUnsignedKind14(senderPubkey));

  const payload = {
    v: 1,
    scheduledAt: scheduledAtSec,
    pkv_id: pkvId,
    dmEnc,
    dmMeta,
    recipients,
    senderCopy: { seal: senderCopySeal },
    previewKeyCapsules: capsule ? { [pkvId]: capsule } : null
  };
  if (cap && typeof cap === "object") payload.cap = cap;
  const encrypted = nip44EncryptWithKey(dmKey, JSON.stringify(payload));

  const rumor = {
    kind: DM_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", targetPubkey],
      ["k", String(PROTO_VERSION)]
    ],
    content: encrypted,
    pubkey: senderPubkey
  };
  rumor.id = getEventHash(rumor);

  // Seal: signed by user, nip44 encrypted to DVM, tags must be empty
  const sealPayload = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  const sealDraft = {
    kind: SEAL_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: sealPayload
  };
  const seal = await signer.signEvent(sealDraft);

  // Gift wrap: random keypair, nip44 encrypted to DVM
  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, targetPubkey);
  const wrapContent = nip44EncryptWithKey(wrapKey, JSON.stringify(seal));
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", targetPubkey]],
      content: wrapContent,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
  wrap.requestId = rumor.id;
  return wrap;
}

export async function buildDm17RetryRequest({ fromPubkey, jobId, dvmPubkey }) {
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");

  const senderPubkey = normalizePubkey(fromPubkey);
  if (!senderPubkey) throw new Error("Missing sender pubkey");

  if (!jobId || typeof jobId !== "string") throw new Error("Missing jobId");

  const signer = getSignerApi();
  if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);

  const { dmKey } = await ensureMailboxSecrets(senderPubkey);
  const encrypted = nip44EncryptWithKey(dmKey, JSON.stringify({ v: 1, jobId }));

  const rumor = {
    kind: DM_RETRY_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", targetPubkey],
      ["k", String(PROTO_VERSION)]
    ],
    content: encrypted,
    pubkey: senderPubkey
  };
  rumor.id = getEventHash(rumor);

  const sealPayload = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  const sealDraft = {
    kind: SEAL_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: sealPayload
  };
  const seal = await signer.signEvent(sealDraft);

  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, targetPubkey);
  const wrapContent = nip44EncryptWithKey(wrapKey, JSON.stringify(seal));
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", targetPubkey]],
      content: wrapContent,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
  wrap.requestId = rumor.id;
  return wrap;
}

export async function buildMailboxRepairRequest({ fromPubkey, scope = "queue", dvmPubkey }) {
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");

  const senderPubkey = normalizePubkey(fromPubkey);
  if (!senderPubkey) throw new Error("Missing sender pubkey");

  const signer = getSignerApi();
  if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);

  const normalizedScope = String(scope || "").trim() || "queue";
  if (normalizedScope !== "queue" && normalizedScope !== "full") {
    throw new Error("Invalid repair scope (expected queue|full)");
  }

  const { submitKey } = await ensureMailboxSecrets(senderPubkey);
  const encrypted = nip44EncryptWithKey(
    submitKey,
    JSON.stringify({ v: 1, t: "pidgeon-mailbox-repair", scope: normalizedScope })
  );

  const rumor = {
    kind: MAILBOX_REPAIR_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", targetPubkey],
      ["k", String(PROTO_VERSION)]
    ],
    content: encrypted,
    pubkey: senderPubkey
  };
  rumor.id = getEventHash(rumor);

  const sealPayload = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  const sealDraft = {
    kind: SEAL_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: sealPayload
  };
  const seal = await signer.signEvent(sealDraft);

  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, targetPubkey);
  const wrapContent = nip44EncryptWithKey(wrapKey, JSON.stringify(seal));
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", targetPubkey]],
      content: wrapContent,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
  wrap.requestId = rumor.id;
  return wrap;
}

export async function buildSupportActionRequest({
  fromPubkey,
  action,
  promptId = "",
  source = "",
  invoiceId = "",
  sats = 0,
  dvmPubkey
}) {
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");

  const senderPubkey = normalizePubkey(fromPubkey);
  if (!senderPubkey) throw new Error("Missing sender pubkey");

  const signer = getSignerApi();
  if (!signer) throw new Error(`Signer must support required NIP-46 permissions (${REQUIRED_NIP46_PERMS.join(",")})`);

  const actionKey = String(action || "").trim().toLowerCase();
  if (!["use_free", "maybe_later", "support", "check_invoice"].includes(actionKey)) {
    throw new Error("Invalid support action");
  }

  const { submitKey } = await ensureMailboxSecrets(senderPubkey);
  const encrypted = nip44EncryptWithKey(
    submitKey,
    JSON.stringify({
      v: 1,
      t: "pidgeon-support-action",
      action: actionKey,
      promptId: String(promptId || "").trim(),
      source: String(source || "").trim(),
      invoiceId: String(invoiceId || "").trim(),
      sats: Math.max(0, Math.floor(Number(sats) || 0))
    })
  );

  const rumor = {
    kind: SUPPORT_ACTION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["p", targetPubkey],
      ["k", String(PROTO_VERSION)]
    ],
    content: encrypted,
    pubkey: senderPubkey
  };
  rumor.id = getEventHash(rumor);

  const sealPayload = await signer.nip44Encrypt(targetPubkey, JSON.stringify(rumor));
  const sealDraft = {
    kind: SEAL_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: sealPayload
  };
  const seal = await signer.signEvent(sealDraft);

  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, targetPubkey);
  const wrapContent = nip44EncryptWithKey(wrapKey, JSON.stringify(seal));
  const wrap = finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", targetPubkey]],
      content: wrapContent,
      pubkey: getPublicKey(ephemeralSk)
    },
    ephemeralSk
  );
  wrap.requestId = rumor.id;
  return wrap;
}

export async function publishScheduleRequest({ requestEvent, dvmRelays }) {
  const relays = normalizeRelays(
    Array.isArray(dvmRelays) ? dvmRelays : typeof dvmRelays === "string" ? dvmRelays.split(/[, \n]/) : []
  );
  if (!relays.length) throw new Error("No DVM relays configured (set VITE_DVM_RELAYS)");
  try {
    console.debug("[dvm] publishScheduleRequest", { id: requestEvent?.id, relays });
  } catch {}
  await publishEvents(relays, requestEvent);
  return requestEvent.id;
}

export async function cancelScheduleRequest({ requestId, dvmRelays, dvmPubkey }) {
  if (!requestId) throw new Error("Missing requestId to cancel");
  const relays = normalizeRelays(dvmRelays);
  if (!relays.length) throw new Error("No DVM relays configured");
  const targetPubkey = normalizePubkey(dvmPubkey);
  if (!targetPubkey) throw new Error("Missing DVM pubkey");
  const signer = getSignerApi();
  if (!signer?.signEvent) throw new Error("Signer required to cancel");

  const ev = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", requestId],
      ["p", targetPubkey],
    ],
    content: "",
  };
  const signed = await signer.signEvent(ev);
  await publishEvents(relays, signed);
  return signed.id;
}
