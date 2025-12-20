// Pure mailbox flush implementation (used by mailbox worker threads).
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import { getSharedSecret } from "@noble/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { makeEvent, normalizeRelayUrl } from "@welshman/util";
import { publish, requestOne } from "@welshman/net";
import { listJobsForPubkey, listTerminalJobsForPubkey } from "./jobsDb.js";
import {
  getMailboxBlob,
  getMailboxMeta,
  getSupportActiveInvoice,
  getSupportState,
  listMailboxPages,
  upsertMailboxBlob,
  upsertMailboxMeta,
  upsertMailboxPage
} from "./appDataDb.js";
import { getSupportPolicy } from "./supportPolicy.js";
import crypto from "crypto";

// Conservative serialized event JSON cap (post-encryption + tags).
const MAX_EVENT_BYTES = 48000;
const PENDING_PLAINTEXT_TARGET = 24000;
const HISTORY_PLAINTEXT_TARGET = 24000;
const BLOB_PLAINTEXT_TARGET = 16000;
const DM_JOB_TYPE = "dm17";
const REPOST_KIND = 6;
const PENDING_PAGES_BUCKET = "__pending__";

const uniq = (list = []) => Array.from(new Set(list));

const bytesToB64u = (u8) =>
  Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function toIsoBucket(ts) {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function bytesLen(obj) {
  return Buffer.byteLength(JSON.stringify(obj), "utf8");
}

function splitStringUtf8(str, targetBytes) {
  const parts = [];
  let current = "";
  for (const ch of String(str || "")) {
    const next = current + ch;
    if (current && Buffer.byteLength(next, "utf8") > targetBytes) {
      parts.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : [""];
}

function isHexId(id = "") {
  return /^[a-f0-9]{64}$/i.test(String(id || "").trim());
}

function shortHex(id = "") {
  const hex = String(id || "").trim();
  if (!isHexId(hex)) return "";
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

function extractTag(tags, name) {
  return (Array.isArray(tags) ? tags : []).find((t) => Array.isArray(t) && t[0] === name);
}

function buildRepostPreviewContent(note) {
  const tags = Array.isArray(note?.tags) ? note.tags : [];
  const eTag = extractTag(tags, "e");
  const targetId = String(eTag?.[1] || "").trim();
  const targetShort = shortHex(targetId);

  const hasAuthor = Boolean(String(extractTag(tags, "p")?.[1] || "").trim());
  let snippet = "";
  const raw = String(note?.content || "").trim();
  if (raw) {
    try {
      const embedded = JSON.parse(raw);
      if (embedded && typeof embedded === "object") {
        snippet = String(embedded.content || "").trim();
      }
    } catch {
      snippet = "";
    }
  }
  if (snippet) {
    const compact = snippet.replace(/\s+/g, " ");
    snippet = compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
  }

  const base = snippet || (targetShort ? `Repost ${targetShort}` : "Repost");
  return hasAuthor ? base : `${base} (unresolved)`;
}

async function publishMany({ relays, events, concurrency = 3 }) {
  const list = (events || []).filter(Boolean);
  if (!list.length) return;
  const max = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  let i = 0;

  async function worker() {
    while (true) {
      const idx = i;
      i += 1;
      if (idx >= list.length) return;
      // eslint-disable-next-line no-await-in-loop
      await publish({ relays, event: list[idx] });
    }
  }

  await Promise.all(Array.from({ length: max }, () => worker()));
}

async function withAbortTimeout(timeoutMs, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function requestOneWithTimeout({ relay, filters, timeoutMs = 2500 }) {
  return withAbortTimeout(timeoutMs, (signal) =>
    requestOne({
      relay,
      filters,
      autoClose: true,
      signal
    })
  );
}

async function requestOneFirst({
  relays,
  filters,
  timeoutMs = 2500,
  concurrency = Number(process.env.MAILBOX_REPAIR_RELAY_QUERY_CONCURRENCY || 3)
}) {
  const relayList = uniq(relays).map(normalizeRelayUrl).filter(Boolean);
  if (!relayList.length) return { relay: null, event: null, okCount: 0 };

  const max = Math.max(1, Math.min(Number(concurrency) || 1, relayList.length));
  let cursor = 0;
  let found = null;
  let foundRelay = null;
  let okCount = 0;

  async function worker() {
    while (true) {
      if (found) return;
      const idx = cursor;
      cursor += 1;
      if (idx >= relayList.length) return;

      const relay = relayList[idx];
      try {
        // eslint-disable-next-line no-await-in-loop
        const events = await requestOneWithTimeout({ relay, filters, timeoutMs });
        okCount += 1;
        if (!found && events?.length) {
          found = events[0];
          foundRelay = relay;
          return;
        }
      } catch {
        // ignore
      }
    }
  }

  await Promise.all(Array.from({ length: max }, () => worker()));
  return { relay: foundRelay, event: found, okCount };
}

function shardByPlaintext(items, targetBytes, makeJson) {
  const pages = [];
  let current = [];
  for (const item of items) {
    const next = [...current, item];
    const json = makeJson(next, pages.length);
    if (current.length && bytesLen(json) > targetBytes) {
      pages.push(current);
      current = [item];
    } else {
      current = next;
    }
  }
  if (current.length) pages.push(current);
  return pages;
}

function buildPendingItems(jobs) {
  const noteItems = jobs
    .filter((j) => j && j.payload?.type !== DM_JOB_TYPE)
    // Pending snapshot should only contain note jobs that could still change without having a public note.
    // Terminal states are moved to history pages.
    .filter((j) => j.status === "scheduled")
    .map((j) => {
      const note = j.payload?.event || {};
      const scheduledAt = Number(j.scheduledAt) || Number(note.created_at) || 0;
      const tags = Array.isArray(note.tags) ? note.tags : [];
      const repostMarker =
        note.kind === REPOST_KIND
          ? (() => {
              const eTag = extractTag(tags, "e");
              const targetId = String(eTag?.[1] || "").trim();
              return ["pidgeon", "repost", isHexId(targetId) ? targetId : ""];
            })()
          : null;
      return {
        jobType: "note",
        jobId: j.id,
        status: j.status,
        scheduledAt,
        updatedAt: Number(j.updatedAt) || scheduledAt,
        noteId: j.noteId || note.id || "",
        notePreview: {
          content: note.kind === REPOST_KIND ? buildRepostPreviewContent(note) : note.content || "",
          tags: repostMarker ? [...tags, repostMarker] : tags
        },
        relays: Array.isArray(j.relays) ? j.relays : []
      };
    });

  const dmItems = jobs
    .filter((j) => j && j.payload?.type === DM_JOB_TYPE)
    .filter((j) => j.status !== "canceled" && j.status !== "cancelled" && j.status !== "sent")
    .map((j) => {
      const dm = j.payload?.dm || {};
      const scheduledAt = Number(j.payload?.scheduledAt) || Number(j.scheduledAt) || 0;
      const recipients = Array.isArray(j.payload?.recipients) ? j.payload.recipients : [];
      const senderCopy = j.payload?.senderCopy || {};
      const status = j.status === "partial" ? "error" : j.status || "scheduled";
      return {
        jobType: DM_JOB_TYPE,
        jobId: j.id,
        status,
        ...(status === "scheduled" ? {} : { statusInfo: j.lastError || "" }),
        scheduledAt,
        updatedAt: Number(j.updatedAt) || scheduledAt,
        dm: {
          pkv_id: dm.pkv_id || "",
          dmEnc: dm.dmEnc || "",
          meta: dm.meta || {}
        },
        recipients: recipients.map((r) => ({
          pubkey: r?.pubkey || "",
          status: r?.status || "pending",
          lastError: r?.lastError || "",
          relaysUsed: Array.isArray(r?.relaysUsed) ? r.relaysUsed : [],
          wrapId: r?.wrapId || r?.wrap?.id || ""
        })),
        senderCopy: {
          status: senderCopy?.status || "pending",
          lastError: senderCopy?.lastError || "",
          relaysUsed: Array.isArray(senderCopy?.relaysUsed) ? senderCopy.relaysUsed : [],
          wrapId: senderCopy?.wrapId || senderCopy?.wrap?.id || ""
        }
      };
    });

  return [...noteItems, ...dmItems].sort((a, b) => a.scheduledAt - b.scheduledAt);
}

function buildHistoryItems(jobs) {
  return jobs
    .filter((j) => j && j.payload?.type !== DM_JOB_TYPE)
    .filter((j) => j && (j.status === "sent" || j.status === "error" || j.status === "canceled" || j.status === "cancelled"))
    .map((j) => {
      // Practical compaction:
      // - posted/sent: keep a reference to the published note (content comes from kind 1),
      //   plus minimal metadata so clients can sort/range-filter without fetching the note first.
      // - error/canceled: keep a small record (no kind 1 to fetch), so the UI can still show status after restart.
      if (j.status === "sent") {
        const note = j.payload?.event || {};
        return {
          noteId: j.noteId || note.id || "",
          kind: Number(note.kind) || 1,
          postedAt: Number(j.updatedAt) || Number(j.scheduledAt) || Number(note.created_at) || nowSec()
        };
      }
      const note = j.payload?.event || {};
      const scheduledAt = Number(j.scheduledAt) || Number(note.created_at) || 0;
      return {
        jobId: j.id,
        status: j.status === "error" ? "error" : "canceled",
        statusInfo: j.lastError || "",
        scheduledAt,
        updatedAt: Number(j.updatedAt) || scheduledAt,
        noteId: j.noteId || note.id || ""
      };
    })
    .filter((it) => it && (it.noteId || it.jobId))
    .sort((a, b) => {
      const ta = Number(a.updatedAt || a.scheduledAt || 0);
      const tb = Number(b.updatedAt || b.scheduledAt || 0);
      return ta - tb;
    }); // asc for log-structured stability
}

function makePendingJson(items, page, rev) {
  return {
    v: 1,
    rev,
    page,
    pending: items
  };
}

function makePendingJsonForSizing(page, items) {
  // Use stable overhead so sharding boundaries don't drift across revs.
  return {
    v: 1,
    rev: 0,
    page,
    pending: items
  };
}

function makeHistoryJson(bucket, page, items, rev) {
  return {
    v: 1,
    rev,
    bucket,
    page,
    items
  };
}

function makeHistoryJsonForSizing(bucket, page, items) {
  // Use stable overhead so sharding boundaries don't drift across revs.
  return {
    v: 1,
    rev: 0,
    bucket,
    page,
    items
  };
}

function hashItems(items) {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(items)).digest("hex");
  } catch {
    return null;
  }
}

const MAILBOX_STATE_HASH_VERSION = 1;

function sha256Hex(input) {
  try {
    return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
  } catch {
    return "";
  }
}

function stableObject(obj) {
  const seen = new WeakSet();

  const walk = (val) => {
    if (!val || typeof val !== "object") return val;
    if (seen.has(val)) return null;
    seen.add(val);

    if (Array.isArray(val)) {
      return val.map(walk);
    }

    const out = {};
    for (const key of Object.keys(val).sort()) {
      out[key] = walk(val[key]);
    }
    return out;
  };

  return walk(obj && typeof obj === "object" ? obj : {});
}

function normalizeRelayList(list = []) {
  const relays = Array.isArray(list) ? list : [];
  return uniq(relays.map((r) => String(r || "").trim()).filter(Boolean)).sort();
}

function normalizeDmRecipient(rec) {
  const r = rec && typeof rec === "object" ? rec : {};
  return {
    pubkey: String(r.pubkey || ""),
    status: String(r.status || ""),
    lastError: String(r.lastError || ""),
    relaysUsed: normalizeRelayList(r.relaysUsed || []),
    wrapId: String(r.wrapId || r?.wrap?.id || "")
  };
}

function normalizeDmSenderCopy(senderCopy) {
  const s = senderCopy && typeof senderCopy === "object" ? senderCopy : {};
  return {
    status: String(s.status || ""),
    lastError: String(s.lastError || ""),
    relaysUsed: normalizeRelayList(s.relaysUsed || []),
    wrapId: String(s.wrapId || s?.wrap?.id || "")
  };
}

function mailboxStateHash({ outRelays, previewKeyCapsules, jobs, terminalJobs, support }) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  const allTerminal = Array.isArray(terminalJobs) ? terminalJobs : [];

  const noteScheduled = allJobs
    .filter((j) => j && j.payload?.type !== DM_JOB_TYPE && String(j.status) === "scheduled")
    .map((j) => ({
      id: String(j.id || ""),
      noteId: String(j.noteId || ""),
      scheduledAt: Number(j.scheduledAt) || 0,
      updatedAt: Number(j.updatedAt) || 0,
      relays: normalizeRelayList(j.relays || [])
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const dmPending = allJobs
    .filter((j) => j && j.payload?.type === DM_JOB_TYPE)
    .filter((j) => !["canceled", "cancelled", "sent"].includes(String(j.status || "")))
    .map((j) => {
      const payload = j.payload || {};
      const dm = payload.dm || {};
      const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
      const senderCopy = payload.senderCopy || null;
      return {
        id: String(j.id || ""),
        status: String(j.status || ""),
        lastError: String(j.lastError || ""),
        scheduledAt: Number(payload.scheduledAt) || Number(j.scheduledAt) || 0,
        updatedAt: Number(j.updatedAt) || 0,
        dm: { pkv_id: String(dm.pkv_id || ""), dmEnc: String(dm.dmEnc || "") },
        recipients: recipients.map(normalizeDmRecipient),
        senderCopy: senderCopy ? normalizeDmSenderCopy(senderCopy) : null
      };
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const noteTerminal = allTerminal
    .filter((j) => j && j.payload?.type !== DM_JOB_TYPE)
    .map((j) => ({
      id: String(j.id || ""),
      status: String(j.status || ""),
      lastError: String(j.lastError || ""),
      noteId: String(j.noteId || ""),
      scheduledAt: Number(j.scheduledAt) || 0,
      updatedAt: Number(j.updatedAt) || 0
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const capsules = stableObject(previewKeyCapsules || {});
  const supportStable = stableObject(support || null);

  return sha256Hex(
    JSON.stringify({
      v: MAILBOX_STATE_HASH_VERSION,
      relays: normalizeRelayList(outRelays || []),
      noteScheduled,
      dmPending,
      noteTerminal,
      previewKeyCapsules: capsules,
      support: supportStable
    })
  );
}

function makeBucketIndexJson(bucket, pages, nextBucket, rev) {
  return {
    v: 1,
    rev,
    bucket,
    bucket_order: "desc",
    next_bucket: nextBucket || null,
    pages
  };
}

function makeGlobalIndexJson(pendingPagesMeta, buckets, relays, rev) {
  return {
    v: 1,
    rev,
    relays,
    previewKeyCapsules: null,
    counts: null,
    support: null,
    pending_pages: pendingPagesMeta,
    bucket_order: "desc",
    buckets
  };
}

function normalizeSupportFeature(feature = "") {
  return String(feature || "").trim().toLowerCase();
}

function makeSupportView({ pubkey, policy, state, invoice }) {
  const scheduleCount = Math.max(0, Number(state?.scheduleCount) || 0);
  const freeUntilCount = Math.max(0, Number(state?.freeUntilCount) || 0);
  const supporterUntil = Math.max(0, Number(state?.supporterUntil) || 0);
  const windowSchedules = Math.max(0, Number(policy?.windowSchedules) || 0);
  const nextPromptAtCount =
    Math.max(0, Number(state?.nextPromptAtCount) || 0) || (windowSchedules > 0 ? windowSchedules : 0);
  const isSupporter = supporterUntil > nowSec();
  const isUnlocked = scheduleCount < freeUntilCount;

  const gatePrompt = state?.gatePrompt && typeof state.gatePrompt === "object" ? state.gatePrompt : null;
  let prompt = gatePrompt;
  if (!prompt && windowSchedules > 0 && !isSupporter && !isUnlocked && scheduleCount >= nextPromptAtCount) {
    prompt = {
      v: 1,
      id: `nudge:${nextPromptAtCount}`,
      type: "nudge",
      scheduleCount,
      nextPromptAtCount,
      windowSchedules
    };
  }

  const inv = invoice && typeof invoice === "object" ? invoice : null;
  const invoiceView =
    inv && inv.id && inv.pr
      ? {
          id: String(inv.id || ""),
          status: String(inv.status || "pending"),
          sats: Math.max(0, Number(inv.sats) || 0),
          pr: String(inv.pr || ""),
          createdAt: Math.max(0, Number(inv.createdAt) || 0),
          expiresAt: Math.max(0, Number(inv.expiresAt) || 0)
        }
      : null;

  const payment = policy?.payment && typeof policy.payment === "object" ? policy.payment : {};

  return {
    v: 1,
    policy: {
      v: Number(policy?.v) || 1,
      horizonDays: Math.max(0, Number(policy?.horizonDays) || 0),
      windowSchedules,
      gatedFeatures: Array.isArray(policy?.gatedFeatures)
        ? policy.gatedFeatures.map(normalizeSupportFeature).filter(Boolean)
        : [],
      cta: {
        lud16: String(policy?.cta?.lud16 || "").trim(),
        message: String(policy?.cta?.message || "").trim()
      },
      payment: {
        mode: String(payment?.mode || "none").trim(),
        invoiceSats: Math.max(0, Number(payment?.invoiceSats) || 0),
        minSats: Math.max(0, Number(payment?.minSats) || 0),
        supporterDays: Math.max(0, Number(payment?.supporterDays) || 0),
        invoiceTtlSec: Math.max(0, Number(payment?.invoiceTtlSec) || 0)
      }
    },
    state: {
      scheduleCount,
      freeUntilCount,
      nextPromptAtCount,
      supporterUntil,
      isSupporter,
      isUnlocked
    },
    prompt,
    invoice: invoiceView
  };
}

function nostrPubkeyToSecpCompressed(pubkey) {
  const hex = String(pubkey || "").trim();
  if (hex.length !== 64) throw new Error("Invalid pubkey length");
  const raw = hexToBytes(hex);
  if (raw.length !== 32) throw new Error("Invalid pubkey length");
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02; // even Y by convention for x-only pubkeys
  compressed.set(raw, 1);
  return compressed;
}

function deriveMailboxSecrets({ dvmSkBytes, dvmPubkey, userPubkey }) {
  const shared = getSharedSecret(dvmSkBytes, nostrPubkeyToSecpCompressed(userPubkey), true).slice(1);
  const salt = Buffer.from("pidgeon:v3", "utf8");
  const info = Buffer.from(`pidgeon:v3:root:${dvmPubkey}`, "utf8");
  const rootKey = crypto.hkdfSync("sha256", shared, salt, info, 32);
  const rootKeyBytes = new Uint8Array(rootKey);

  const sub = (label) =>
    new Uint8Array(
      crypto.hkdfSync("sha256", Buffer.from(rootKeyBytes), Buffer.alloc(0), Buffer.from(label, "utf8"), 32)
    );

  const mbBytes = crypto.hkdfSync(
    "sha256",
    Buffer.from(rootKeyBytes),
    Buffer.alloc(0),
    Buffer.from("pidgeon:v3:mailbox-id", "utf8"),
    16
  );
  const mb = bytesToB64u(new Uint8Array(mbBytes));

  return {
    rootKey: rootKeyBytes,
    mb,
    mailboxKey: sub("pidgeon:v3:key:mailbox"),
    submitKey: sub("pidgeon:v3:key:submit"),
    dmKey: sub("pidgeon:v3:key:dm"),
    blobKey: sub("pidgeon:v3:key:blob")
  };
}

export async function flushMailboxOnce({ pubkey, relays, dvmSkHex }) {
  const mailboxOwner = String(pubkey || "").trim();
  if (!mailboxOwner) throw new Error("Missing pubkey");
  const outRelays = uniq((relays || []).map(normalizeRelayUrl).filter(Boolean));
  if (!outRelays.length) return { skipped: true, reason: "no relays" };
  const relaysKey = normalizeRelayList(outRelays).join(",");

  const skHex = String(dvmSkHex || "").trim();
  if (!skHex) throw new Error("Missing dvmSkHex");
  const dvmSkBytes = hexToBytes(skHex);
  const dvmPubkey = getPublicKey(dvmSkBytes);

  const meta = getMailboxMeta(mailboxOwner);
  let lastCreatedAtByDTag = {};
  let previewKeyCapsules = {};
  try {
    lastCreatedAtByDTag = JSON.parse(meta.lastCreatedAtByDTagJson || "{}") || {};
  } catch {
    lastCreatedAtByDTag = {};
  }
  try {
    previewKeyCapsules = JSON.parse(meta.previewKeyCapsulesJson || "{}") || {};
  } catch {
    previewKeyCapsules = {};
  }
  const relaysChanged = String(meta.publishedRelaysKey || "") !== relaysKey;

  const { mailboxKey, blobKey, mb } = deriveMailboxSecrets({ dvmSkBytes, dvmPubkey, userPubkey: mailboxOwner });

  const pendingJobs = listJobsForPubkey(mailboxOwner, 5000);
  const terminalJobsAll = listTerminalJobsForPubkey(mailboxOwner) || [];
  const supportPolicy = getSupportPolicy();
  const supportState = getSupportState(mailboxOwner);
  const supportInvoice = getSupportActiveInvoice(mailboxOwner);
  const supportView = makeSupportView({ pubkey: mailboxOwner, policy: supportPolicy, state: supportState, invoice: supportInvoice });
  const supportHash = {
    policy: supportView.policy,
    state: {
      scheduleCount: supportView.state.scheduleCount,
      freeUntilCount: supportView.state.freeUntilCount,
      nextPromptAtCount: supportView.state.nextPromptAtCount,
      supporterUntil: supportView.state.supporterUntil,
      gatePrompt: supportState?.gatePrompt || null
    },
    invoice: supportView.invoice || null
  };
  const stateHash = mailboxStateHash({
    outRelays,
    previewKeyCapsules,
    jobs: pendingJobs,
    terminalJobs: terminalJobsAll,
    support: supportHash
  });
  if (stateHash && String(meta.publishedHash || "") === stateHash) {
    return {
      skipped: true,
      reason: "no changes",
      pubkey: mailboxOwner,
      mb,
      rev: Number(meta.publishedRev) || 0
    };
  }

  const rev = (Number(meta.rev) || 0) + 1;

  const nextCreatedAt = (dTag) => {
    const key = String(dTag || "");
    const last = Number(lastCreatedAtByDTag[key] || 0);
    const ts = Math.max(nowSec(), last + 1);
    lastCreatedAtByDTag[key] = ts;
    return ts;
  };

  const signMailboxEvent = async (dTag, json, keyBytes) => {
    const content = nip44.v2.encrypt(JSON.stringify(json), new Uint8Array(keyBytes));
    const created_at = nextCreatedAt(dTag);
    const draft = makeEvent(30078, {
      created_at,
      content,
      tags: [
        ["d", dTag],
        ["k", "3"]
      ]
    });
    return finalizeEvent(draft, dvmSkBytes);
  };

  const estimateMailboxEventBytes = (dTag, json, keyBytes) => {
    const content = nip44.v2.encrypt(JSON.stringify(json), new Uint8Array(keyBytes));
    const draft = makeEvent(30078, {
      created_at: nowSec(),
      content,
      tags: [
        ["d", dTag],
        ["k", "3"]
      ]
    });
    // Approximate signing overhead to avoid affecting created_at monotonicity.
    const approx = {
      ...draft,
      pubkey: dvmPubkey,
      id: "0".repeat(64),
      sig: "0".repeat(128)
    };
    return bytesLen(approx);
  };

  const makeStubPreview = (item, maxChars, dropTags = false) => {
    const full = item.notePreview || {};
    const raw = String(full.content || "");
    const sliced = raw.slice(0, Math.max(0, maxChars));
    const truncated = sliced.length < raw.length ? `${sliced}…` : sliced;
    const tags = dropTags ? [] : Array.isArray(full.tags) ? full.tags : [];
    return {
      ...item,
      notePreview: {
        content: truncated,
        tags
      }
    };
  };

  const buildBlobEventsForNote = async ({ noteId, fullDataJson }) => {
    let target = BLOB_PLAINTEXT_TARGET;
    let parts = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      parts = splitStringUtf8(fullDataJson, target);
      const total = parts.length;
      const oversized = parts.some((data, idx) => {
        const dTag = `pidgeon:v3:mb:${mb}:blob:${noteId}:${idx}`;
        const json = { v: 1, part: idx, total, data };
        return estimateMailboxEventBytes(dTag, json, blobKey) > MAX_EVENT_BYTES;
      });
      if (!oversized) break;
      target = Math.max(2000, Math.floor(target * 0.7));
    }

    const total = parts.length;
    const events = [];
    for (let i = 0; i < total; i++) {
      const dTag = `pidgeon:v3:mb:${mb}:blob:${noteId}:${i}`;
      const json = { v: 1, part: i, total, data: parts[i] };
      // eslint-disable-next-line no-await-in-loop
      const ev = await signMailboxEvent(dTag, json, blobKey);
      if (bytesLen(ev) > MAX_EVENT_BYTES) {
        console.warn("[mailbox] blob part still exceeds cap", dTag);
      }
      events.push(ev);
    }

    return {
      noteBlob: {
        dBase: `pidgeon:v3:mb:${mb}:blob:${noteId}:`,
        parts: total,
        bytes: Buffer.byteLength(fullDataJson, "utf8")
      },
      events
    };
  };

  // Persist rev early to keep it strictly monotonic even on crash.
  upsertMailboxMeta(mailboxOwner, {
    rev,
    lastCreatedAtByDTagJson: JSON.stringify(lastCreatedAtByDTag || {}),
    previewKeyCapsulesJson: JSON.stringify(previewKeyCapsules || {})
  });
  const prevPages = new Map();
  for (const row of listMailboxPages(mailboxOwner) || []) {
    if (!row?.bucket && row?.bucket !== "") continue;
    prevPages.set(`${row.bucket}:${row.page}`, {
      count: Number(row.count) || 0,
      hash: String(row.hash || "")
    });
  }
  let pendingItems = buildPendingItems(pendingJobs);
  const blobEvents = [];
  const blobUpserts = [];

  // If a single pending item would exceed relay caps, move full note data into blob shards
  // and keep a truncated stub in the pending page.
  for (let i = 0; i < pendingItems.length; i++) {
    const item = pendingItems[i];
    const noteId = item.noteId || item.notePreview?.id || item.jobId;
    if (!noteId) continue;
    const fullContent = String(item.notePreview?.content || "");
    const fullTags = Array.isArray(item.notePreview?.tags) ? item.notePreview.tags : [];
    if (!fullContent && !fullTags.length) continue;

    const probeD = `pidgeon:v3:mb:${mb}:pending:probe`;
    const probeJson = makePendingJson([item], 0, rev);
    const estBytes = estimateMailboxEventBytes(probeD, probeJson, mailboxKey);
    if (estBytes <= MAX_EVENT_BYTES) continue;

    const fullDataJson = JSON.stringify({ content: fullContent, tags: fullTags });
    const blobHash = sha256Hex(fullDataJson);
    const cachedBlob = blobHash && isHexId(noteId) ? getMailboxBlob(mailboxOwner, noteId) : null;
    const canReuse =
      !relaysChanged &&
      cachedBlob &&
      cachedBlob.hash &&
      cachedBlob.hash === blobHash &&
      Number(cachedBlob.parts) > 0 &&
      Number(cachedBlob.bytes) > 0;

    let noteBlob = null;
    if (canReuse) {
      noteBlob = {
        dBase: `pidgeon:v3:mb:${mb}:blob:${noteId}:`,
        parts: Number(cachedBlob.parts) || 0,
        bytes: Number(cachedBlob.bytes) || 0
      };
    } else {
      // eslint-disable-next-line no-await-in-loop
      const built = await buildBlobEventsForNote({ noteId, fullDataJson });
      noteBlob = built.noteBlob;
      blobEvents.push(...(built.events || []));
      blobUpserts.push({ noteId, parts: noteBlob.parts, bytes: noteBlob.bytes, hash: blobHash });
    }

    const charSteps = [8000, 4000, 2000, 1000, 500, 200, 50, 0];
    let stub = null;
    for (const maxChars of charSteps) {
      const candidate = makeStubPreview(item, maxChars, false);
      const candidateJson = makePendingJson([candidate], 0, rev);
      if (estimateMailboxEventBytes(probeD, candidateJson, mailboxKey) <= MAX_EVENT_BYTES) {
        stub = candidate;
        break;
      }
    }
    if (!stub) {
      for (const maxChars of charSteps) {
        const candidate = makeStubPreview(item, maxChars, true);
        const candidateJson = makePendingJson([candidate], 0, rev);
        if (estimateMailboxEventBytes(probeD, candidateJson, mailboxKey) <= MAX_EVENT_BYTES) {
          stub = candidate;
          break;
        }
      }
    }
    if (!stub) stub = makeStubPreview(item, 0, true);

    pendingItems[i] = { ...stub, noteBlob };
  }

  let pendingTarget = PENDING_PLAINTEXT_TARGET;
  let pendingResult = null;
  // Adaptively shrink pending page size until all events fit caps.
  for (let attempt = 0; attempt < 6; attempt++) {
    const pendingPages = shardByPlaintext(pendingItems, pendingTarget, (items, page) => makePendingJsonForSizing(page, items));
    const events = [];
    const metaRows = [];
    let oversized = false;
    for (let i = 0; i < pendingPages.length; i++) {
      const dTag = `pidgeon:v3:mb:${mb}:pending:${i}`;
      const json = makePendingJson(pendingPages[i], i, rev);
      const updatedAt = pendingPages[i].reduce((acc, it) => Math.max(acc, it.updatedAt || 0), 0);
      const pageHash = String(hashItems(pendingPages[i]) || "");
      metaRows.push({ d: dTag, count: pendingPages[i].length, updated_at: updatedAt, hash: pageHash });

      const prev = prevPages.get(`${PENDING_PAGES_BUCKET}:${i}`) || { count: -1, hash: "" };
      const shouldPublish = relaysChanged || prev.count !== pendingPages[i].length || prev.hash !== pageHash;
      if (shouldPublish) {
        // eslint-disable-next-line no-await-in-loop
        const ev = await signMailboxEvent(dTag, json, mailboxKey);
        if (bytesLen(ev) > MAX_EVENT_BYTES) {
          oversized = true;
          break;
        }
        events.push(ev);
      }

      upsertMailboxPage(mailboxOwner, PENDING_PAGES_BUCKET, i, pendingPages[i].length, pageHash);
    }
    if (!oversized) {
      pendingResult = { events, meta: metaRows };
      break;
    }
    pendingTarget = Math.max(2000, Math.floor(pendingTarget * 0.7));
  }

  // Fallback: if a single huge pending item still blows caps, publish one-per-page.
  if (!pendingResult) {
    const events = [];
    const metaRows = [];
    for (let i = 0; i < pendingItems.length; i++) {
      const dTag = `pidgeon:v3:mb:${mb}:pending:${i}`;
      const json = makePendingJson([pendingItems[i]], i, rev);
      const pageHash = String(hashItems([pendingItems[i]]) || "");
      metaRows.push({ d: dTag, count: 1, updated_at: pendingItems[i].updatedAt || 0, hash: pageHash });

      const prev = prevPages.get(`${PENDING_PAGES_BUCKET}:${i}`) || { count: -1, hash: "" };
      const shouldPublish = relaysChanged || prev.count !== 1 || prev.hash !== pageHash;
      if (shouldPublish) {
        // eslint-disable-next-line no-await-in-loop
        const ev = await signMailboxEvent(dTag, json, mailboxKey);
        if (bytesLen(ev) > MAX_EVENT_BYTES) {
          console.warn("[mailbox] single pending item exceeds cap, may be rejected", dTag);
        }
        events.push(ev);
      }

      upsertMailboxPage(mailboxOwner, PENDING_PAGES_BUCKET, i, 1, pageHash);
    }
    pendingResult = { events, meta: metaRows };
  }

  const pendingEvents = pendingResult.events;
  const pendingPagesMeta = pendingResult.meta;

  const terminalJobs = terminalJobsAll.filter((j) => j && j.payload?.type !== DM_JOB_TYPE);
  const historyItems = buildHistoryItems(terminalJobs);
  const counts = {
    queued: pendingItems.filter((it) => it?.jobType !== DM_JOB_TYPE).length,
    posted: terminalJobs.filter((j) => j && j.status === "sent").length,
    error: terminalJobs.filter((j) => j && j.status === "error").length,
    canceled: terminalJobs.filter((j) => j && (j.status === "canceled" || j.status === "cancelled")).length
  };

  const bucketsMap = new Map(); // bucket -> items[]
  historyItems.forEach((it) => {
    const bucket = toIsoBucket(it.postedAt || it.scheduledAt || nowSec());
    if (!bucketsMap.has(bucket)) bucketsMap.set(bucket, []);
    bucketsMap.get(bucket).push(it);
  });

  const buckets = Array.from(bucketsMap.keys()).sort().reverse(); // desc

  const historyEvents = [];
  const bucketIndexEvents = [];

  for (let bIdx = 0; bIdx < buckets.length; bIdx++) {
    const bucket = buckets[bIdx];
    const itemsForBucket = bucketsMap.get(bucket).sort((a, b) => a.postedAt - b.postedAt); // asc for stability

    const pagesItems = shardByPlaintext(itemsForBucket, HISTORY_PLAINTEXT_TARGET, (items, page) =>
      makeHistoryJsonForSizing(bucket, page, items)
    );

    const pagesMeta = [];
    for (let p = 0; p < pagesItems.length; p++) {
      const dTag = `pidgeon:v3:mb:${mb}:hist:${bucket}:${p}`;
      const json = makeHistoryJson(bucket, p, pagesItems[p], rev);
      const count = pagesItems[p].length;
      const prev = prevPages.get(`${bucket}:${p}`) || { count: -1, hash: "" };
      const updatedAt = pagesItems[p].reduce((acc, it) => Math.max(acc, it.postedAt || 0), 0);
      const pageHash = String(hashItems(pagesItems[p]) || "");
      pagesMeta.push({ d: dTag, page: p, count, updated_at: updatedAt, hash: pageHash });
      // Old pages remain stable unless content changes.
      if (prev.count !== count || prev.hash !== pageHash) {
        // eslint-disable-next-line no-await-in-loop
        const ev = await signMailboxEvent(dTag, json, mailboxKey);
        if (bytesLen(ev) > MAX_EVENT_BYTES) {
          console.warn("[mailbox] history page too large even after sharding", dTag);
        } else {
          historyEvents.push(ev);
        }
      }
      upsertMailboxPage(mailboxOwner, bucket, p, count, pageHash);
    }

    const nextBucket = buckets[bIdx + 1] || null;
    const bucketIndexD = `pidgeon:v3:mb:${mb}:bucket:${bucket}`;
    const bucketIndexJson = makeBucketIndexJson(bucket, pagesMeta, nextBucket, rev);
    const bucketChanged = pagesMeta.some((m) => {
      const prev = prevPages.get(`${bucket}:${m.page}`) || { count: -1, hash: "" };
      return prev.count !== m.count || prev.hash !== String(m.hash || "");
    });
    if (bucketChanged) {
      // eslint-disable-next-line no-await-in-loop
      const bucketIndexEv = await signMailboxEvent(bucketIndexD, bucketIndexJson, mailboxKey);
      if (bytesLen(bucketIndexEv) <= MAX_EVENT_BYTES) {
        bucketIndexEvents.push(bucketIndexEv);
      }
    }
  }

  const globalIndexD = `pidgeon:v3:mb:${mb}:index`;
  const capsules =
    previewKeyCapsules && Object.keys(previewKeyCapsules || {}).length ? previewKeyCapsules : null;
  const globalIndexJson = {
    ...makeGlobalIndexJson(pendingPagesMeta, buckets, outRelays, rev),
    counts,
    previewKeyCapsules: capsules,
    support: supportView
  };
  const globalIndexEv = await signMailboxEvent(globalIndexD, globalIndexJson, mailboxKey);

  // Publish order: blobs -> pending -> history pages -> bucket indices -> global index last
  const concurrency = Number(process.env.MAILBOX_PUBLISH_CONCURRENCY || 3);
  await publishMany({ relays: outRelays, events: blobEvents, concurrency });
  await publishMany({ relays: outRelays, events: pendingEvents, concurrency });
  await publishMany({ relays: outRelays, events: historyEvents, concurrency });
  await publishMany({ relays: outRelays, events: bucketIndexEvents, concurrency });
  await publish({ relays: outRelays, event: globalIndexEv });

  blobUpserts.forEach((b) => {
    try {
      upsertMailboxBlob(mailboxOwner, b.noteId, { parts: b.parts, bytes: b.bytes, hash: b.hash });
    } catch {
      // ignore
    }
  });

  upsertMailboxMeta(mailboxOwner, {
    rev,
    publishedRev: rev,
    publishedRelaysKey: relaysKey,
    publishedHash: stateHash,
    lastCreatedAtByDTagJson: JSON.stringify(lastCreatedAtByDTag || {}),
    previewKeyCapsulesJson: JSON.stringify(previewKeyCapsules || {})
  });

  return {
    skipped: false,
    pubkey: mailboxOwner,
    rev,
    mb,
    published: {
      blobs: blobEvents.length,
      pending: pendingEvents.length,
      history: historyEvents.length,
      bucket_index: bucketIndexEvents.length,
      global_index: 1
    }
  };
}

export async function repairMailboxOnce({ pubkey, relays, dvmSkHex, scope = "queue" } = {}) {
  const mailboxOwner = String(pubkey || "").trim();
  if (!mailboxOwner) throw new Error("Missing pubkey");

  const outRelays = uniq((relays || []).map(normalizeRelayUrl).filter(Boolean));
  if (!outRelays.length) return { skipped: true, reason: "no relays", pubkey: mailboxOwner };

  const relaysKey = normalizeRelayList(outRelays).join(",");

  const skHex = String(dvmSkHex || "").trim();
  if (!skHex) throw new Error("Missing dvmSkHex");
  const dvmSkBytes = hexToBytes(skHex);
  const dvmPubkey = getPublicKey(dvmSkBytes);

  const normalizedScope = String(scope || "").trim() || "queue";
  const scopeKey = normalizedScope === "full" ? "full" : "queue";

  // Ensure we have the latest published rev/hash first; repair should only re-publish missing shards.
  const meta0 = getMailboxMeta(mailboxOwner);
  let previewKeyCapsules0 = {};
  try {
    previewKeyCapsules0 = JSON.parse(meta0.previewKeyCapsulesJson || "{}") || {};
  } catch {
    previewKeyCapsules0 = {};
  }
  const pendingJobs0 = listJobsForPubkey(mailboxOwner, 5000);
  const terminalJobsAll0 = listTerminalJobsForPubkey(mailboxOwner) || [];
  const supportPolicy0 = getSupportPolicy();
  const supportState0 = getSupportState(mailboxOwner);
  const supportInvoice0 = getSupportActiveInvoice(mailboxOwner);
  const supportView0 = makeSupportView({ pubkey: mailboxOwner, policy: supportPolicy0, state: supportState0, invoice: supportInvoice0 });
  const supportHash0 = {
    policy: supportView0.policy,
    state: {
      scheduleCount: supportView0.state.scheduleCount,
      freeUntilCount: supportView0.state.freeUntilCount,
      nextPromptAtCount: supportView0.state.nextPromptAtCount,
      supporterUntil: supportView0.state.supporterUntil,
      gatePrompt: supportState0?.gatePrompt || null
    },
    invoice: supportView0.invoice || null
  };
  const stateHash0 = mailboxStateHash({
    outRelays,
    previewKeyCapsules: previewKeyCapsules0,
    jobs: pendingJobs0,
    terminalJobs: terminalJobsAll0,
    support: supportHash0
  });
  const needsFlush =
    !meta0.publishedRev ||
    !meta0.publishedHash ||
    String(meta0.publishedRelaysKey || "") !== relaysKey ||
    (stateHash0 && String(meta0.publishedHash || "") !== stateHash0);

  let flushResult = null;
  if (needsFlush) {
    // flushMailboxOnce already skips unchanged pages/hist and is safe to call from repair.
    flushResult = await flushMailboxOnce({ pubkey: mailboxOwner, relays: outRelays, dvmSkHex: skHex });
  }

  const meta = getMailboxMeta(mailboxOwner);
  const publishedRev = Number(meta.publishedRev) || 0;
  if (!publishedRev) {
    return { skipped: true, reason: "not published yet", pubkey: mailboxOwner };
  }

  let expectedCreatedAtByDTag = {};
  let previewKeyCapsules = {};
  try {
    expectedCreatedAtByDTag = JSON.parse(meta.lastCreatedAtByDTagJson || "{}") || {};
  } catch {
    expectedCreatedAtByDTag = {};
  }
  try {
    previewKeyCapsules = JSON.parse(meta.previewKeyCapsulesJson || "{}") || {};
  } catch {
    previewKeyCapsules = {};
  }

  const { mailboxKey, blobKey, mb } = deriveMailboxSecrets({ dvmSkBytes, dvmPubkey, userPubkey: mailboxOwner });

  const globalIndexD = `pidgeon:v3:mb:${mb}:index`;

  const probeTimeoutMs = Math.max(500, Number(process.env.MAILBOX_REPAIR_PROBE_TIMEOUT_MS || 2500) || 2500);
  const tagConcurrency = Math.max(1, Number(process.env.MAILBOX_REPAIR_TAG_CONCURRENCY || 4) || 4);

  const checkDTag = async (dTag) => {
    const expectedAt = Number(expectedCreatedAtByDTag[String(dTag)] || 0) || 0;
    const since = expectedAt > 0 ? Math.max(0, expectedAt - 1) : 0;
    const filters = [
      {
        kinds: [30078],
        authors: [dvmPubkey],
        "#d": [dTag],
        ...(since ? { since } : {}),
        limit: 1
      }
    ];
    const { event, okCount } = await requestOneFirst({ relays: outRelays, filters, timeoutMs: probeTimeoutMs });
    if (event) return { dTag, status: "present", expectedAt, foundAt: Number(event.created_at) || 0 };
    if (okCount) return { dTag, status: "missing", expectedAt, foundAt: 0 };
    return { dTag, status: "unknown", expectedAt, foundAt: 0 };
  };

  // Only mutate created_at monotonicity if we actually publish something.
  const lastCreatedAtByDTag = { ...expectedCreatedAtByDTag };
  const nextCreatedAt = (dTag) => {
    const key = String(dTag || "");
    const last = Number(lastCreatedAtByDTag[key] || 0);
    const ts = Math.max(nowSec(), last + 1);
    lastCreatedAtByDTag[key] = ts;
    return ts;
  };

  const signMailboxEvent = async (dTag, json, keyBytes) => {
    const content = nip44.v2.encrypt(JSON.stringify(json), new Uint8Array(keyBytes));
    const created_at = nextCreatedAt(dTag);
    const draft = makeEvent(30078, {
      created_at,
      content,
      tags: [
        ["d", dTag],
        ["k", "3"]
      ]
    });
    return finalizeEvent(draft, dvmSkBytes);
  };

  const estimateMailboxEventBytes = (dTag, json, keyBytes) => {
    const content = nip44.v2.encrypt(JSON.stringify(json), new Uint8Array(keyBytes));
    const draft = makeEvent(30078, {
      created_at: nowSec(),
      content,
      tags: [
        ["d", dTag],
        ["k", "3"]
      ]
    });
    const approx = {
      ...draft,
      pubkey: dvmPubkey,
      id: "0".repeat(64),
      sig: "0".repeat(128)
    };
    return bytesLen(approx);
  };

  const computeBlobPartsForNote = ({ noteId, fullDataJson }) => {
    let target = BLOB_PLAINTEXT_TARGET;
    let parts = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      parts = splitStringUtf8(fullDataJson, target);
      const total = parts.length;
      const oversized = parts.some((data, idx) => {
        const dTag = `pidgeon:v3:mb:${mb}:blob:${noteId}:${idx}`;
        const json = { v: 1, part: idx, total, data };
        return estimateMailboxEventBytes(dTag, json, blobKey) > MAX_EVENT_BYTES;
      });
      if (!oversized) break;
      target = Math.max(2000, Math.floor(target * 0.7));
    }
    const total = parts.length;
    return {
      noteBlob: {
        dBase: `pidgeon:v3:mb:${mb}:blob:${noteId}:`,
        parts: total,
        bytes: Buffer.byteLength(fullDataJson, "utf8")
      },
      parts
    };
  };

  const makeStubPreview = (item, maxChars, dropTags = false) => {
    const full = item.notePreview || {};
    const raw = String(full.content || "");
    const sliced = raw.slice(0, Math.max(0, maxChars));
    const truncated = sliced.length < raw.length ? `${sliced}…` : sliced;
    const tags = dropTags ? [] : Array.isArray(full.tags) ? full.tags : [];
    return {
      ...item,
      notePreview: {
        content: truncated,
        tags
      }
    };
  };

  let pendingItems = buildPendingItems(pendingJobs0);
  const blobIndex = new Map(); // noteId -> { fullDataJson, noteBlob, parts }

  for (let i = 0; i < pendingItems.length; i++) {
    const item = pendingItems[i];
    const noteId = item.noteId || item.notePreview?.id || item.jobId;
    if (!noteId || !isHexId(noteId)) continue;
    const fullContent = String(item.notePreview?.content || "");
    const fullTags = Array.isArray(item.notePreview?.tags) ? item.notePreview.tags : [];
    if (!fullContent && !fullTags.length) continue;

    const probeD = `pidgeon:v3:mb:${mb}:pending:probe`;
    const probeJson = makePendingJson([item], 0, publishedRev);
    const estBytes = estimateMailboxEventBytes(probeD, probeJson, mailboxKey);
    if (estBytes <= MAX_EVENT_BYTES) continue;

    const fullDataJson = JSON.stringify({ content: fullContent, tags: fullTags });
    const blobHash = sha256Hex(fullDataJson);
    const cachedBlob = blobHash ? getMailboxBlob(mailboxOwner, noteId) : null;
    const canReuse =
      cachedBlob &&
      cachedBlob.hash &&
      cachedBlob.hash === blobHash &&
      Number(cachedBlob.parts) > 0 &&
      Number(cachedBlob.bytes) > 0;

    const blobBuilt = canReuse
      ? {
          noteBlob: {
            dBase: `pidgeon:v3:mb:${mb}:blob:${noteId}:`,
            parts: Number(cachedBlob.parts) || 0,
            bytes: Number(cachedBlob.bytes) || 0
          },
          parts: null
        }
      : computeBlobPartsForNote({ noteId, fullDataJson });

    const noteBlob = blobBuilt.noteBlob;
    blobIndex.set(noteId, { fullDataJson, noteBlob, parts: blobBuilt.parts, hash: blobHash });

    const charSteps = [8000, 4000, 2000, 1000, 500, 200, 50, 0];
    let stub = null;
    for (const maxChars of charSteps) {
      const candidate = makeStubPreview(item, maxChars, false);
      const candidateJson = makePendingJson([candidate], 0, publishedRev);
      if (estimateMailboxEventBytes(probeD, candidateJson, mailboxKey) <= MAX_EVENT_BYTES) {
        stub = candidate;
        break;
      }
    }
    if (!stub) {
      for (const maxChars of charSteps) {
        const candidate = makeStubPreview(item, maxChars, true);
        const candidateJson = makePendingJson([candidate], 0, publishedRev);
        if (estimateMailboxEventBytes(probeD, candidateJson, mailboxKey) <= MAX_EVENT_BYTES) {
          stub = candidate;
          break;
        }
      }
    }
    if (!stub) stub = makeStubPreview(item, 0, true);
    pendingItems[i] = { ...stub, noteBlob };
  }

  const rev = publishedRev;

  let pendingTarget = PENDING_PLAINTEXT_TARGET;
  let pendingResult = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const pendingPagesItems = shardByPlaintext(pendingItems, pendingTarget, (items, page) => makePendingJsonForSizing(page, items));
    const metaRows = [];
    const pageJsonByDTag = new Map();
    let oversized = false;

    for (let i = 0; i < pendingPagesItems.length; i++) {
      const dTag = `pidgeon:v3:mb:${mb}:pending:${i}`;
      const json = makePendingJson(pendingPagesItems[i], i, rev);
      const updatedAt = pendingPagesItems[i].reduce((acc, it) => Math.max(acc, it.updatedAt || 0), 0);
      const pageHash = String(hashItems(pendingPagesItems[i]) || "");
      metaRows.push({ d: dTag, count: pendingPagesItems[i].length, updated_at: updatedAt, hash: pageHash });
      pageJsonByDTag.set(dTag, json);

      // Ensure the event can fit; otherwise try smaller shard size.
      if (estimateMailboxEventBytes(dTag, json, mailboxKey) > MAX_EVENT_BYTES) {
        oversized = true;
        break;
      }
    }

    if (!oversized) {
      pendingResult = { meta: metaRows, jsonByDTag: pageJsonByDTag };
      break;
    }
    pendingTarget = Math.max(2000, Math.floor(pendingTarget * 0.7));
  }

  if (!pendingResult) {
    // One-per-page fallback for pathological content.
    const metaRows = [];
    const pageJsonByDTag = new Map();
    for (let i = 0; i < pendingItems.length; i++) {
      const dTag = `pidgeon:v3:mb:${mb}:pending:${i}`;
      const json = makePendingJson([pendingItems[i]], i, rev);
      const updatedAt = Number(pendingItems[i]?.updatedAt) || 0;
      const pageHash = String(hashItems([pendingItems[i]]) || "");
      metaRows.push({ d: dTag, count: 1, updated_at: updatedAt, hash: pageHash });
      pageJsonByDTag.set(dTag, json);
    }
    pendingResult = { meta: metaRows, jsonByDTag: pageJsonByDTag };
  }

  const pendingPagesMeta = pendingResult.meta;

  const blobDTags = [];
  for (const [, entry] of blobIndex) {
    const noteBlob = entry?.noteBlob;
    if (!noteBlob?.dBase || !noteBlob?.parts) continue;
    const partsCount = Number(noteBlob.parts) || 0;
    if (!partsCount) continue;
    for (let i = 0; i < partsCount; i++) {
      blobDTags.push(`${noteBlob.dBase}${i}`);
    }
  }

  const pendingPageDTags = pendingPagesMeta.map((p) => String(p?.d || "").trim()).filter(Boolean);
  const dTagsToCheck = uniq([globalIndexD, ...pendingPageDTags, ...blobDTags]);

  const checks = [];
  let cursor = 0;
  async function checkerWorker() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= dTagsToCheck.length) return;
      // eslint-disable-next-line no-await-in-loop
      checks.push(await checkDTag(dTagsToCheck[idx]));
    }
  }
  await Promise.all(Array.from({ length: Math.min(tagConcurrency, dTagsToCheck.length) }, () => checkerWorker()));

  const missing = new Set(checks.filter((c) => c.status === "missing").map((c) => c.dTag));
  const unknown = new Set(checks.filter((c) => c.status === "unknown").map((c) => c.dTag));

  if (!missing.size) {
    return {
      skipped: true,
      reason: unknown.size ? "relay status unknown" : "all present",
      pubkey: mailboxOwner,
      mb,
      rev: publishedRev,
      scope: scopeKey,
      flush: flushResult
    };
  }

  // Determine which pending pages need to be re-published (missing/outdated).
  const pendingEventsToPublish = [];
  for (const row of pendingPagesMeta) {
    const dTag = String(row?.d || "").trim();
    if (!dTag) continue;
    const pageJson = pendingResult.jsonByDTag.get(dTag);
    if (!pageJson) continue;
    if (!missing.has(dTag)) continue;
    // eslint-disable-next-line no-await-in-loop
    pendingEventsToPublish.push(await signMailboxEvent(dTag, pageJson, mailboxKey));
    upsertMailboxPage(mailboxOwner, PENDING_PAGES_BUCKET, Number(pageJson.page) || 0, Number(row.count) || 0, String(row.hash || ""));
  }

  // Re-publish only blob parts referenced by current pending items that are missing/outdated.
  const blobEventsToPublish = [];
  if (blobIndex.size) {
    for (const [noteId, entry] of blobIndex) {
      const noteBlob = entry?.noteBlob;
      if (!noteBlob?.dBase || !noteBlob?.parts) continue;
      const partsCount = Number(noteBlob.parts) || 0;
      if (!partsCount) continue;

      let needsAny = false;
      for (let i = 0; i < partsCount; i++) {
        if (missing.has(`${noteBlob.dBase}${i}`)) {
          needsAny = true;
          break;
        }
      }
      if (!needsAny) continue;

      const fullDataJson = String(entry.fullDataJson || "");
      if (!fullDataJson) continue;

      const { parts } = entry.parts ? { parts: entry.parts } : computeBlobPartsForNote({ noteId, fullDataJson });
      const total = parts.length;
      for (let i = 0; i < total; i++) {
        const dTag = `${noteBlob.dBase}${i}`;
        if (!missing.has(dTag)) continue;
        const json = { v: 1, part: i, total, data: parts[i] };
        // eslint-disable-next-line no-await-in-loop
        blobEventsToPublish.push(await signMailboxEvent(dTag, json, blobKey));
      }
      if (total) {
        try {
          upsertMailboxBlob(mailboxOwner, noteId, {
            parts: total,
            bytes: Buffer.byteLength(fullDataJson, "utf8"),
            hash: entry.hash || ""
          });
        } catch {
          // ignore
        }
      }
    }
  }

  let globalIndexEv = null;
  if (missing.has(globalIndexD)) {
    const supportPolicy = getSupportPolicy();
    const supportState = getSupportState(mailboxOwner);
    const supportInvoice = getSupportActiveInvoice(mailboxOwner);
    const supportView = makeSupportView({ pubkey: mailboxOwner, policy: supportPolicy, state: supportState, invoice: supportInvoice });

    const terminalJobs = terminalJobsAll0.filter((j) => j && j.payload?.type !== DM_JOB_TYPE);
    const historyItems = buildHistoryItems(terminalJobs);
    const counts = {
      queued: pendingItems.filter((it) => it?.jobType !== DM_JOB_TYPE).length,
      posted: terminalJobs.filter((j) => j && j.status === "sent").length,
      error: terminalJobs.filter((j) => j && j.status === "error").length,
      canceled: terminalJobs.filter((j) => j && (j.status === "canceled" || j.status === "cancelled")).length
    };

    const bucketsMap = new Map();
    historyItems.forEach((it) => {
      const bucket = toIsoBucket(it.postedAt || it.scheduledAt || nowSec());
      if (!bucketsMap.has(bucket)) bucketsMap.set(bucket, []);
      bucketsMap.get(bucket).push(it);
    });
    const buckets = Array.from(bucketsMap.keys()).sort().reverse();

    const capsules =
      previewKeyCapsules && Object.keys(previewKeyCapsules || {}).length ? previewKeyCapsules : null;
    const globalIndexJson = {
      ...makeGlobalIndexJson(pendingPagesMeta, buckets, outRelays, rev),
      counts,
      previewKeyCapsules: capsules,
      support: supportView
    };
    globalIndexEv = await signMailboxEvent(globalIndexD, globalIndexJson, mailboxKey);
  }

  const concurrency = Number(process.env.MAILBOX_PUBLISH_CONCURRENCY || 3);
  await publishMany({ relays: outRelays, events: blobEventsToPublish, concurrency });
  await publishMany({ relays: outRelays, events: pendingEventsToPublish, concurrency });
  if (globalIndexEv) {
    await publish({ relays: outRelays, event: globalIndexEv });
  }

  // Persist updated created_at monotonic state if we published anything.
  upsertMailboxMeta(mailboxOwner, {
    rev: meta.rev,
    lastCreatedAtByDTagJson: JSON.stringify(lastCreatedAtByDTag || {}),
    previewKeyCapsulesJson: meta.previewKeyCapsulesJson
  });

  return {
    skipped: false,
    pubkey: mailboxOwner,
    mb,
    rev,
    scope: scopeKey,
    republished: {
      blobs: blobEventsToPublish.length,
      pending: pendingEventsToPublish.length,
      global_index: globalIndexEv ? 1 : 0
    },
    missing: Array.from(missing),
    unknown: Array.from(unknown),
    flush: flushResult
  };
}
