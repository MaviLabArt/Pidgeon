import { getDvmConfig, ensureMailboxSecrets } from "@/nostr/dvm.js";
import { resolveRelays } from "@/nostr/config.js";
import { fetchEventsOnce, subscribeEvents } from "@/nostr/pool.js";
import { b64uToBytesSafe, nip44DecryptWithKey } from "@/nostr/crypto.js";
import { isDemoMailboxEnabled, subscribeDemoMailbox } from "@/services/demoMailbox.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

const MAILBOX_KIND = 30078;
const CACHE_PREFIX = "pidgeon.mailbox.";
const PKV_CACHE_PREFIX = "pidgeon.pkv.";
const DM_JOB_TYPE = "dm17";
const PENDING_TIMEOUT_MS = 4000;
const INITIAL_PENDING_PAGES = 1;
const INITIAL_HISTORY_PAGES = 1;
const BROAD_SINCE_SEC = 60 * 60 * 24 * 14; // safety window when relays don't index #d
const BROAD_INDEX_LIMIT = 1200;
const BROAD_PAGE_LIMIT_MIN = 200;
const BROAD_PAGE_LIMIT_MAX = 3000;

const toIso = (ts) => new Date((Number(ts) || 0) * 1000).toISOString();

function boundedCacheSet(map, key, value, maxSize = 500) {
  if (!map || !key) return;
  map.set(key, value);
  if (map.size <= maxSize) return;
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) map.delete(oldestKey);
}

const DM_PREVIEW_CACHE_MAX = 800;
const dmPreviewCache = new Map(); // `${userPubkey}|${dvmPubkey}|${pkv_id}|${dmEnc}` -> preview string

function hashItems(items) {
  try {
    const enc = new TextEncoder();
    return bytesToHex(sha256(enc.encode(JSON.stringify(items))));
  } catch {
    return "";
  }
}

function cacheKey(mb, suffix) {
  return `${CACHE_PREFIX}${mb}.${suffix}`;
}

function readCache(key, fallback = null) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function pkvStorageKey(userPubkey, dvmPubkey) {
  const dvm = dvmPubkey || "default";
  return `${PKV_CACHE_PREFIX}${dvm}:${userPubkey}`;
}

function readPreviewKeyBytes(userPubkey, dvmPubkey) {
  if (!userPubkey) return null;
  try {
    const b64 = localStorage.getItem(pkvStorageKey(userPubkey, dvmPubkey));
    if (!b64) return null;
    return b64uToBytesSafe(b64);
  } catch {
    return null;
  }
}

function shortPubkey(pk = "") {
  const s = String(pk || "");
  if (!s) return "";
  return s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function shortHexId(id = "") {
  const s = String(id || "").trim();
  if (!s) return "";
  return s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function firstTagValue(tags, name) {
  const list = Array.isArray(tags) ? tags : [];
  const t = list.find((x) => Array.isArray(x) && x[0] === name);
  return t ? String(t[1] || "").trim() : "";
}

function getDTag(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const t = tags.find((x) => Array.isArray(x) && x[0] === "d");
  return t ? String(t[1] || "").trim() : "";
}

function pickLatestEvent(events) {
  const ordered = Array.isArray(events) ? events.slice() : [];
  ordered.sort(
    (a, b) =>
      (Number(b?.created_at) || 0) - (Number(a?.created_at) || 0) ||
      String(a?.id || "").localeCompare(String(b?.id || ""))
  );
  return ordered[0] || null;
}

function parseEmbeddedNostrEventContent(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    // Heuristic: look like a Nostr event.
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

function normalizeNotePreview({ content, tags }) {
  const rawContent = String(content || "");
  const embedded = parseEmbeddedNostrEventContent(rawContent);
  // Repost handling: kind-6 reposts may embed the target kind-1 JSON in `content`.
  // When that happens, render the embedded note content like a normal post (not as raw JSON).
  if (embedded && Number(embedded.kind) === 1) {
    return {
      content: String(embedded.content || ""),
      isRepost: true,
      repostTargetId: firstTagValue(tags, "e") || embedded.id
    };
  }

  // If it *looks* like a repost (has an e-tag and no real text), show a friendly label.
  const targetId = firstTagValue(tags, "e");
  const compact = rawContent.trim().replace(/\s+/g, " ");
  if (targetId && (!compact || compact.startsWith("{"))) {
    return {
      content: `Repost ${shortHexId(targetId)}`.trim(),
      isRepost: true,
      repostTargetId: targetId
    };
  }

  return { content: rawContent, isRepost: false, repostTargetId: "" };
}

function pendingItemToJob(it, mailboxRelays, { userPubkey, dvmPubkey } = {}) {
  if (it?.jobType === DM_JOB_TYPE) {
    const scheduledAtIso = toIso(it.scheduledAt);
    const updatedAtIso = it.updatedAt ? toIso(it.updatedAt) : scheduledAtIso;
    const dm = it.dm || {};
    const recipients = Array.isArray(it.recipients) ? it.recipients : [];
    const toPubkey = recipients[0]?.pubkey || "";

    let content = `DM to ${shortPubkey(toPubkey)}`;
    try {
      const dmEnc = String(dm?.dmEnc || "");
      const cacheKey = dmEnc && dm?.pkv_id ? `${userPubkey || ""}|${dvmPubkey || ""}|${dm.pkv_id}|${dmEnc}` : "";
      const cached = cacheKey ? dmPreviewCache.get(cacheKey) : "";
      if (cached) {
        content = cached;
      } else {
        const pkv = readPreviewKeyBytes(userPubkey, dvmPubkey);
        if (pkv && dmEnc) {
          const plain = nip44DecryptWithKey(pkv, dmEnc);
          const decoded = JSON.parse(plain || "{}");
          const full = String(decoded?.content || "");
          const snippet = full.length > 280 ? `${full.slice(0, 280)}…` : full;
          if (snippet) {
            content = snippet;
            if (cacheKey) boundedCacheSet(dmPreviewCache, cacheKey, snippet, DM_PREVIEW_CACHE_MAX);
          }
        }
      }
    } catch {
      // keep placeholder
    }

    return {
      jobType: DM_JOB_TYPE,
      id: it.jobId,
      requestId: it.jobId,
      noteId: "",
      content,
      tags: [],
      scheduledAt: scheduledAtIso,
      createdAt: scheduledAtIso,
      updatedAt: updatedAtIso,
      status: it.status || "scheduled",
      relays: [],
      statusInfo: it.statusInfo || "",
      lastError: it.status === "error" ? it.statusInfo || "" : "",
      dm: {
        pkv_id: dm?.pkv_id || "",
        dmEnc: dm?.dmEnc || "",
        meta: dm?.meta || {}
      },
      recipients,
      senderCopy: it.senderCopy || null
    };
  }

  const scheduledAtIso = toIso(it.scheduledAt);
  const updatedAtIso = it.updatedAt ? toIso(it.updatedAt) : scheduledAtIso;
  const preview = it.notePreview || {};
  const normalized = normalizeNotePreview({ content: preview.content, tags: preview.tags });
  return {
    jobType: it?.jobType || "note",
    id: it.jobId,
    requestId: it.jobId,
    noteId: it.noteId || preview.id || "",
    content: normalized.content || "",
    tags: Array.isArray(preview.tags) ? preview.tags : [],
    scheduledAt: scheduledAtIso,
    createdAt: scheduledAtIso,
    updatedAt: updatedAtIso,
    status: it.status || "scheduled",
    relays: Array.isArray(it.relays) && it.relays.length ? it.relays : mailboxRelays || [],
    statusInfo: it.statusInfo || "",
    lastError: it.status === "error" ? it.statusInfo || "" : "",
    noteBlob: it.noteBlob || null,
    isRepost: normalized.isRepost,
    repostTargetId: normalized.repostTargetId
  };
}

function historyItemToJob(it) {
  // Supports both v2 compact records and older history records.
  // - posted pointer: {noteId}
  // - posted pointer (v2+): {noteId, postedAt, kind}
  // - terminal record: {jobId,status,scheduledAt,updatedAt,statusInfo,noteId}
  // - legacy record: {jobId,noteId,scheduledAt,postedAt,status,relays}
  const noteId = it.noteId || "";
  const jobId = it.jobId || "";

  const legacyPostedAt = Number(it.postedAt) || 0;
  const postedAtSec = Number(it.postedAt) || 0;
  const kindHint = Number(it.kind) || 0;
  const scheduledAtSec = Number(it.scheduledAt) || 0;
  const updatedAtSec = Number(it.updatedAt) || legacyPostedAt || scheduledAtSec || 0;

  const scheduledAtIso = scheduledAtSec ? toIso(scheduledAtSec) : "";
  const updatedAtIso = updatedAtSec ? toIso(updatedAtSec) : "";

  // Pure posted pointer: let kind-1 hydration fill timestamps/content.
  if (!jobId && noteId) {
    const ts = postedAtSec || 0;
    const iso = ts ? toIso(ts) : "";
    return {
      id: noteId,
      requestId: "",
      noteId,
      content: "",
      tags: [],
      scheduledAt: iso,
      createdAt: iso,
      updatedAt: iso,
      status: "posted",
      relays: [],
      statusInfo: "",
      lastError: "",
      noteKind: kindHint || 0
    };
  }

  const status = it.status === "sent" ? "posted" : it.status || (legacyPostedAt ? "posted" : "error");
  return {
    id: jobId || noteId,
    requestId: jobId || "",
    noteId,
    content: "",
    tags: [],
    scheduledAt: scheduledAtIso,
    createdAt: scheduledAtIso,
    updatedAt: updatedAtIso,
    status,
    relays: Array.isArray(it.relays) ? it.relays : [],
    statusInfo: it.statusInfo || "",
    lastError: status === "error" ? it.statusInfo || "error" : ""
  };
}

export async function subscribeMailbox(pubkey, { onJobs, onSync, onCounts, onSupport } = {}) {
  if (isDemoMailboxEnabled()) {
    return subscribeDemoMailbox(pubkey, { onJobs, onSync, onCounts, onSupport });
  }

  const dvm = getDvmConfig();
  if (!pubkey || !dvm.pubkey || !dvm.relays.length) {
    return { close() {}, retryNow() {} };
  }

  const { mailboxKey, mb } = await ensureMailboxSecrets(pubkey);
  const indexD = `pidgeon:v3:mb:${mb}:index`;

  let mailboxRelays = resolveRelays(dvm.relays);
  let mailboxRelaysKey = mailboxRelays.join(",");
  const dIndexingBrokenByRelaysKey = new Map(); // relaysKey -> boolean
  const dIndexingWarnedByRelaysKey = new Set(); // relaysKey -> warned
  let dIndexingBroken = Boolean(dIndexingBrokenByRelaysKey.get(mailboxRelaysKey));
  let indexPollTimer = null;
  let lastIndexCreatedAt = 0;
  let currentRev = 0;
  let completedRev = 0;
  let completedJobs = [];
  let emptyInitialized = false;

  let allPending = [];
  let requiredPending = [];
  let pendingPages = new Map(); // d -> json
  let pendingExpectedHash = new Map(); // dTag -> sha256 hex
  let historyPages = new Map(); // d -> json
  let historyQueue = [];
  const queuedHistory = new Set();
  const loadedHistory = new Set();
  const fetchedBuckets = new Set();
  let buckets = [];
  let bucketCursor = 0;
  let pendingTimer = null;
  let closed = false;
  let startedRev = 0;

  const subs = [];
  let revSubs = [];
  let indexSub = null;

  function setDIndexingBroken(next, { reason = "" } = {}) {
    const val = Boolean(next);
    dIndexingBroken = val;
    dIndexingBrokenByRelaysKey.set(mailboxRelaysKey, val);
    if (val && !dIndexingWarnedByRelaysKey.has(mailboxRelaysKey)) {
      dIndexingWarnedByRelaysKey.add(mailboxRelaysKey);
      console.warn(
        `[mailbox] Relay set does not index #d; falling back to broad queries${reason ? ` (${reason})` : ""}`,
        mailboxRelays
      );
    }
    if (val) {
      if (!indexPollTimer) {
        indexPollTimer = setInterval(() => {
          if (closed) return;
          fetchIndexOnce().catch(() => {});
        }, 15000);
      }
    } else if (indexPollTimer) {
      clearInterval(indexPollTimer);
      indexPollTimer = null;
    }
  }

  async function fetchLatestByDTag(dTag, { broadLimit = BROAD_INDEX_LIMIT, purpose = "" } = {}) {
    const want = String(dTag || "").trim();
    if (!want) return null;

    const tagged = dIndexingBroken
      ? []
      : await fetchEventsOnce(mailboxRelays, {
          kinds: [MAILBOX_KIND],
          authors: [dvm.pubkey],
          "#d": [want],
          limit: 3
        });
    const taggedLatest = pickLatestEvent(tagged);
    if (taggedLatest) return taggedLatest;

    // Fallback for relays that don't index d: fetch a bounded recent window and client-filter.
    const since = Math.max(0, (lastIndexCreatedAt || Math.floor(Date.now() / 1000)) - BROAD_SINCE_SEC);
    const broad = await fetchEventsOnce(mailboxRelays, {
      kinds: [MAILBOX_KIND],
      authors: [dvm.pubkey],
      since,
      limit: Math.max(50, Number(broadLimit) || 0)
    });
    const matches = (broad || []).filter((ev) => getDTag(ev) === want);
    if (!dIndexingBroken && !tagged?.length && matches.length) {
      setDIndexingBroken(true, { reason: purpose || "missing #d indexing" });
    }
    return pickLatestEvent(matches);
  }

  async function fetchLatestByDTags(dTags, { broadLimit = 0, purpose = "" } = {}) {
    const wanted = Array.from(new Set((Array.isArray(dTags) ? dTags : []).map((d) => String(d || "").trim()).filter(Boolean)));
    const latestByD = new Map();
    if (!wanted.length) return latestByD;

    const limitTagged = Math.min(2000, Math.max(10, wanted.length * 3));
    const tagged = dIndexingBroken
      ? []
      : await fetchEventsOnce(mailboxRelays, {
          kinds: [MAILBOX_KIND],
          authors: [dvm.pubkey],
          "#d": wanted,
          limit: limitTagged
        });

    for (const ev of tagged || []) {
      const d = getDTag(ev);
      if (!d || !wanted.includes(d)) continue;
      const prev = latestByD.get(d);
      if (!prev || (Number(ev.created_at) || 0) > (Number(prev.created_at) || 0)) {
        latestByD.set(d, ev);
      }
    }

    const missing = wanted.filter((d) => !latestByD.has(d));
    if (!missing.length) return latestByD;

    const since = Math.max(0, (lastIndexCreatedAt || Math.floor(Date.now() / 1000)) - BROAD_SINCE_SEC);
    const computedBroadLimit =
      Number(broadLimit) ||
      Math.max(BROAD_PAGE_LIMIT_MIN, Math.min(BROAD_PAGE_LIMIT_MAX, missing.length * 25));
    const broad = await fetchEventsOnce(mailboxRelays, {
      kinds: [MAILBOX_KIND],
      authors: [dvm.pubkey],
      since,
      limit: computedBroadLimit
    });

    let anyBroadMatch = false;
    for (const ev of broad || []) {
      const d = getDTag(ev);
      if (!d || !wanted.includes(d)) continue;
      anyBroadMatch = true;
      const prev = latestByD.get(d);
      if (!prev || (Number(ev.created_at) || 0) > (Number(prev.created_at) || 0)) {
        latestByD.set(d, ev);
      }
    }
    if (!dIndexingBroken && !tagged?.length && anyBroadMatch) {
      setDIndexingBroken(true, { reason: purpose || "missing #d indexing" });
    }

    return latestByD;
  }

  function clearRevSubs() {
    revSubs.forEach((s) => s?.close?.());
    revSubs = [];
  }

  function clearPendingTimer() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  function missingPendingDTags() {
    return requiredPending.filter((d) => !pendingPages.has(d));
  }

  function pendingPageUsable(json, dTag, rev) {
    if (!json || typeof json !== "object") return false;
    if (Number(json?.rev) === rev) return true;
    const expectedHash = String(pendingExpectedHash.get(dTag) || "");
    if (!expectedHash) return false;
    const pageRev = Number(json?.rev) || 0;
    if (pageRev > rev) return false;
    const items = Array.isArray(json?.pending) ? json.pending : [];
    const actualHash = hashItems(items);
    return Boolean(actualHash) && actualHash === expectedHash;
  }

  async function fetchIndexOnce() {
    const ev = await fetchLatestByDTag(indexD, { broadLimit: BROAD_INDEX_LIMIT, purpose: "index" });
    if (ev) {
      handleIndex(ev);
      return true;
    }
    if (!emptyInitialized && !readCache(cacheKey(mb, "index"))?.rev) {
      emptyInitialized = true;
      completedRev = 0;
      completedJobs = [];
      onCounts?.({ queued: 0, posted: 0 });
      onSync?.({ rev: 0, status: "up_to_date", missing: 0 });
      emitJobs({ forceNew: true });
    }
    return false;
  }

  async function fetchPendingPagesOnce(rev, dTags) {
    const list = Array.isArray(dTags) ? dTags.filter(Boolean) : [];
    if (!list.length) return;
    const latestByD = await fetchLatestByDTags(list, { purpose: "pending" });
    for (const dTag of list) {
      const ev = latestByD.get(dTag);
      if (!ev) continue;
      try {
        const json = decryptMailboxEvent(ev);
        if (!pendingPageUsable(json, dTag, rev)) continue;
        pendingPages.set(dTag, json);
        writeCache(cacheKey(mb, dTag), json);
      } catch {
        /* ignore */
      }
    }
    maybeCompletePending(rev);
    emitJobs();
  }

  function schedulePendingTimeout(rev) {
    clearPendingTimer();
    pendingTimer = setTimeout(async () => {
      if (closed) return;
      try {
        onSync?.({ rev, status: "retrying", missing: missingPendingDTags().length });
        await fetchIndexOnce();
        if (rev === currentRev) {
          const missing = missingPendingDTags();
          await fetchPendingPagesOnce(rev, missing);
        }
      } catch {
        // ignore
      }
      if (rev === currentRev && missingPendingDTags().length) {
        onSync?.({ rev, status: "syncing", missing: missingPendingDTags().length });
        // keep rendering last completed rev
      }
    }, PENDING_TIMEOUT_MS);
  }

  function buildJobsFromMaps(pendingMap, historyMap, relaysForFallback) {
    const pendingItems = [];
    pendingMap.forEach((page) => {
      if (Array.isArray(page?.pending)) pendingItems.push(...page.pending);
    });
    const histItems = [];
    historyMap.forEach((page) => {
      if (Array.isArray(page?.items)) histItems.push(...page.items);
    });

    return [
      ...pendingItems.map((it) => pendingItemToJob(it, relaysForFallback, { userPubkey: pubkey, dvmPubkey: dvm.pubkey })),
      ...histItems.map(historyItemToJob)
    ];
  }

  const decryptedEventCache = new Map(); // eventId -> { content, json }
  const DECRYPTED_EVENT_CACHE_MAX = 1200;

  let jobsBuildVersion = 0;
  let lastEmittedVersion = -1;
  let emitHandle = 0;
  let emitHandleType = "";

  function cancelScheduledEmit() {
    if (!emitHandle) return;
    try {
      if (emitHandleType === "idle" && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(emitHandle);
      } else if (typeof clearTimeout === "function") {
        clearTimeout(emitHandle);
      }
    } catch {}
    emitHandle = 0;
    emitHandleType = "";
  }

  function emitJobsNow({ forceNew = false } = {}) {
    const pendingMissing =
      currentRev > completedRev && requiredPending.some((d) => !pendingPages.has(d));
    if (pendingMissing && !forceNew) {
      onJobs?.(completedJobs);
      return;
    }
    if (!forceNew && lastEmittedVersion === jobsBuildVersion) return;
    lastEmittedVersion = jobsBuildVersion;
    const jobs = buildJobsFromMaps(pendingPages, historyPages, mailboxRelays);
    onJobs?.(jobs);
  }

  function scheduleEmitJobs() {
    if (emitHandle) return;
    const run = () => {
      emitHandle = 0;
      emitHandleType = "";
      emitJobsNow();
    };
    if (typeof requestIdleCallback === "function") {
      emitHandleType = "idle";
      emitHandle = requestIdleCallback(run, { timeout: 250 });
    } else {
      emitHandleType = "timeout";
      emitHandle = setTimeout(run, 0);
    }
  }

  function emitJobs({ forceNew = false } = {}) {
    const pendingMissing =
      currentRev > completedRev && requiredPending.some((d) => !pendingPages.has(d));
    if (pendingMissing && !forceNew) {
      onJobs?.(completedJobs);
      return;
    }
    jobsBuildVersion += 1;
    if (forceNew) {
      cancelScheduledEmit();
      emitJobsNow({ forceNew: true });
      return;
    }
    scheduleEmitJobs();
  }

  function maybeCompletePending(rev) {
    if (rev !== currentRev) return;

    const commitCompleted = () => {
      completedRev = rev;
      completedJobs = buildJobsFromMaps(pendingPages, historyPages, mailboxRelays);
      jobsBuildVersion += 1;
      lastEmittedVersion = jobsBuildVersion;
      cancelScheduledEmit();
      onJobs?.(completedJobs);
    };

    if (!requiredPending.length) {
      commitCompleted();
      clearPendingTimer();
      onSync?.({ rev, status: "up_to_date", missing: 0 });
      return;
    }
    const missing = missingPendingDTags();
    if (!missing.length) {
      commitCompleted();
      clearPendingTimer();
      onSync?.({ rev, status: "up_to_date", missing: 0 });
    }
  }

  function decryptMailboxEvent(ev) {
    const id = typeof ev?.id === "string" ? ev.id : "";
    const content = String(ev?.content || "");
    if (id) {
      const cached = decryptedEventCache.get(id);
      if (cached && cached.content === content) return cached.json;
    }
    const plain = nip44DecryptWithKey(mailboxKey, content);
    const json = JSON.parse(plain);
    if (id) boundedCacheSet(decryptedEventCache, id, { content, json }, DECRYPTED_EVENT_CACHE_MAX);
    return json;
  }

  function subscribePendingPages(rev) {
    requiredPending.forEach((dTag) => {
      revSubs.push(
        subscribeEvents(mailboxRelays, [{ kinds: [MAILBOX_KIND], authors: [dvm.pubkey], "#d": [dTag] }], {
          onEvent: (ev) => {
            try {
              const json = decryptMailboxEvent(ev);
              if (!pendingPageUsable(json, dTag, rev)) return;
              pendingPages.set(dTag, json);
              writeCache(cacheKey(mb, dTag), json);
              maybeCompletePending(rev);
              emitJobs();
            } catch {
              /* ignore */
            }
          }
        })
      );
    });
  }

  function enqueueHistoryPages(pagesMeta) {
    const list = Array.isArray(pagesMeta) ? pagesMeta : [];
    // Newest first (highest page number).
    const sorted = [...list].sort((a, b) => (Number(b.page) || 0) - (Number(a.page) || 0));
    for (const p of sorted) {
      const dTag = p?.d;
      if (!dTag) continue;
      if (loadedHistory.has(dTag)) continue;
      if (queuedHistory.has(dTag)) continue;
      queuedHistory.add(dTag);
      historyQueue.push(dTag);
    }
  }

  async function fetchHistoryPageOnce(dTag) {
    const ev = await fetchLatestByDTag(dTag, { purpose: "history-page", broadLimit: BROAD_PAGE_LIMIT_MAX });
    if (!ev) return false;
    try {
      const pageJson = decryptMailboxEvent(ev);
      historyPages.set(dTag, pageJson);
      writeCache(cacheKey(mb, dTag), pageJson);
      loadedHistory.add(dTag);
      emitJobs();
      return true;
    } catch {
      return false;
    }
  }

  async function fetchBucketIndexOnce(bucket) {
    if (!bucket) return null;
    const bucketD = `pidgeon:v3:mb:${mb}:bucket:${bucket}`;
    const ev = await fetchLatestByDTag(bucketD, { purpose: "bucket-index", broadLimit: BROAD_PAGE_LIMIT_MAX });
    if (!ev) return null;
    try {
      return decryptMailboxEvent(ev);
    } catch {
      return null;
    }
  }

  function subscribeNewestBucket(bucket) {
    if (!bucket) return;
    const bucketD = `pidgeon:v3:mb:${mb}:bucket:${bucket}`;
    revSubs.push(
      subscribeEvents(mailboxRelays, [{ kinds: [MAILBOX_KIND], authors: [dvm.pubkey], "#d": [bucketD] }], {
        onEvent: async (ev) => {
          try {
            fetchedBuckets.add(bucket);
            const json = decryptMailboxEvent(ev);
            const pages = Array.isArray(json?.pages) ? json.pages : [];
            enqueueHistoryPages(pages);
            // Ensure the newest history page streams live (append-only active page).
            const newest = [...pages].sort((a, b) => (Number(b.page) || 0) - (Number(a.page) || 0))[0];
            const newestD = newest?.d;
            if (newestD && !loadedHistory.has(newestD)) {
              // Best-effort load one newest page quickly.
              await fetchHistoryPageOnce(newestD);
            }
          } catch {
            /* ignore */
          }
        }
      })
    );
  }

  function hasMorePendingInternal() {
    return requiredPending.length < allPending.length;
  }

  function hasMoreHistoryInternal() {
    if (historyQueue.length) return true;
    if (!buckets.length) return false;
    return fetchedBuckets.size < buckets.length;
  }

  async function loadMoreHistoryInternal({ pages = 1 } = {}) {
    if (closed) return { added: 0, hasMore: false };
    const want = Math.max(1, Number(pages) || 1);

    // If queue is empty, pull the next bucket index and enqueue its pages.
    while (!historyQueue.length && bucketCursor < buckets.length) {
      const bucket = buckets[bucketCursor];
      bucketCursor += 1;
      if (!bucket || fetchedBuckets.has(bucket)) continue;
      fetchedBuckets.add(bucket);
      // eslint-disable-next-line no-await-in-loop
      const bucketJson = await fetchBucketIndexOnce(bucket);
      if (bucketJson?.pages) enqueueHistoryPages(bucketJson.pages);
    }

    const toLoad = [];
    while (historyQueue.length && toLoad.length < want) {
      const dTag = historyQueue.shift();
      if (!dTag) continue;
      if (loadedHistory.has(dTag)) continue;
      toLoad.push(dTag);
    }
    if (!toLoad.length) return { added: 0, hasMore: hasMoreHistoryInternal() };

    let loaded = 0;
    for (const dTag of toLoad) {
      // History isn't rev-gated: accept the latest page for each dTag.
      // eslint-disable-next-line no-await-in-loop
      if (await fetchHistoryPageOnce(dTag)) loaded += 1;
    }
    emitJobs();
    return { added: loaded, hasMore: hasMoreHistoryInternal() };
  }

  function ensureRevSubscriptions(rev, indexJson) {
    if (!rev) return;
    if (startedRev === rev) return;
    startedRev = rev;
    onSync?.({ rev, status: "syncing", missing: requiredPending.length });
    subscribePendingPages(rev);
    // Best-effort: fetch pending pages immediately (faster than waiting for subscriptions).
    fetchPendingPagesOnce(rev, requiredPending).catch(() => {});
    schedulePendingTimeout(rev);

    buckets = Array.isArray(indexJson?.buckets) ? indexJson.buckets : [];
    bucketCursor = 0;
    fetchedBuckets.clear();
    queuedHistory.clear();
    loadedHistory.clear();
    historyQueue = [];
    if (buckets.length) {
      subscribeNewestBucket(buckets[0]);
      // Start with a small slice of newest history for immediate UX.
      // Bucket subscription will enqueue pages; load up to INITIAL_HISTORY_PAGES from the queue.
      setTimeout(() => {
        loadMoreHistoryInternal({ pages: INITIAL_HISTORY_PAGES }).catch(() => {});
      }, 0);
    }
  }

  function handleIndex(ev) {
    let json;
    try {
      json = decryptMailboxEvent(ev);
    } catch {
      return;
    }
    lastIndexCreatedAt = Math.max(lastIndexCreatedAt, Number(ev?.created_at) || 0);
    const rev = Number(json?.rev) || 0;
    if (rev && rev < currentRev) return;
    if (rev > currentRev) {
      // Tear down old rev-specific subscriptions and keep rendering last completed rev until pending completes.
      clearRevSubs();
      currentRev = rev;
      startedRev = 0;
      const pendingMeta = Array.isArray(json?.pending_pages) ? json.pending_pages : [];
      allPending = pendingMeta.map((p) => p?.d).filter(Boolean);
      pendingExpectedHash = new Map(
        pendingMeta
          .map((p) => [String(p?.d || "").trim(), String(p?.hash || "").trim()])
          .filter(([d]) => Boolean(d))
      );
      requiredPending = allPending.slice(0, Math.max(1, INITIAL_PENDING_PAGES));
      pendingPages = new Map();
      historyPages = new Map();

      const nextRelays = resolveRelays(json?.relays || mailboxRelays);
      const nextKey = nextRelays.join(",");
      if (nextKey && nextKey !== mailboxRelaysKey) {
        mailboxRelays = nextRelays;
        mailboxRelaysKey = nextKey;
        dIndexingBroken = Boolean(dIndexingBrokenByRelaysKey.get(mailboxRelaysKey));
        setDIndexingBroken(dIndexingBroken);
        // Re-subscribe index on the new canonical relay set.
        indexSub?.close?.();
        indexSub = subscribeEvents(mailboxRelays, [{ kinds: [MAILBOX_KIND], authors: [dvm.pubkey], "#d": [indexD] }], {
          onEvent: handleIndex
        });
        subs.push(indexSub);
      } else {
        mailboxRelays = nextRelays;
      }
      writeCache(cacheKey(mb, "index"), json);
      if (json?.counts) onCounts?.(json.counts);
      onSupport?.(json?.support || null);
      ensureRevSubscriptions(rev, json);
      emitJobs();
    } else {
      const pendingMeta = Array.isArray(json?.pending_pages) ? json.pending_pages : [];
      pendingExpectedHash = new Map(
        pendingMeta
          .map((p) => [String(p?.d || "").trim(), String(p?.hash || "").trim()])
          .filter(([d]) => Boolean(d))
      );
      writeCache(cacheKey(mb, "index"), json);
      if (json?.counts) onCounts?.(json.counts);
      onSupport?.(json?.support || null);
      // If we booted from cache, rev may be equal; still start subscriptions for this rev.
      ensureRevSubscriptions(rev || currentRev, json);
    }
    maybeCompletePending(rev);
    emitJobs();
  }

  // Seed from cache for instant paint.
  const cachedIndex = readCache(cacheKey(mb, "index"));
  if (cachedIndex?.rev) {
    currentRev = Number(cachedIndex.rev) || 0;
    completedRev = currentRev;
    const pendingMeta = Array.isArray(cachedIndex?.pending_pages) ? cachedIndex.pending_pages : [];
    allPending = pendingMeta.map((p) => p?.d).filter(Boolean);
    pendingExpectedHash = new Map(
      pendingMeta
        .map((p) => [String(p?.d || "").trim(), String(p?.hash || "").trim()])
        .filter(([d]) => Boolean(d))
    );
    requiredPending = allPending.slice(0, Math.max(1, INITIAL_PENDING_PAGES));
    mailboxRelays = resolveRelays(cachedIndex.relays || mailboxRelays);
    mailboxRelaysKey = mailboxRelays.join(",");
    dIndexingBroken = Boolean(dIndexingBrokenByRelaysKey.get(mailboxRelaysKey));
    setDIndexingBroken(dIndexingBroken);
    if (cachedIndex?.counts) onCounts?.(cachedIndex.counts);
    onSupport?.(cachedIndex?.support || null);
    requiredPending.forEach((dTag) => {
      const cachedPage = readCache(cacheKey(mb, dTag));
      if (pendingPageUsable(cachedPage, dTag, currentRev)) pendingPages.set(dTag, cachedPage);
    });
    completedJobs = buildJobsFromMaps(pendingPages, historyPages, mailboxRelays);
    jobsBuildVersion += 1;
    lastEmittedVersion = jobsBuildVersion;
    cancelScheduledEmit();
    onJobs?.(completedJobs);

    // Start rev subscriptions even if the current rev doesn't change after refresh.
    ensureRevSubscriptions(currentRev, cachedIndex);
  }

  indexSub = subscribeEvents(mailboxRelays, [{ kinds: [MAILBOX_KIND], authors: [dvm.pubkey], "#d": [indexD] }], {
    onEvent: handleIndex
  });
  subs.push(indexSub);

  // Kick off an initial fetch; without this, brand new users (no index event yet) can "load forever".
  fetchIndexOnce().catch(() => {});

  return {
    close() {
      closed = true;
      cancelScheduledEmit();
      clearPendingTimer();
      if (indexPollTimer) {
        clearInterval(indexPollTimer);
        indexPollTimer = null;
      }
      clearRevSubs();
      subs.forEach((s) => s?.close?.());
      onSync?.({ rev: currentRev, status: "closed" });
    },
    retryNow() {
      if (closed) return;
      if (currentRev && missingPendingDTags().length) {
        onSync?.({ rev: currentRev, status: "retrying", missing: missingPendingDTags().length });
        fetchIndexOnce()
          .then(() => fetchPendingPagesOnce(currentRev, missingPendingDTags()))
          .catch(() => {});
        return;
      }
      fetchIndexOnce().catch(() => {});
    },
    hasMorePending() {
      return hasMorePendingInternal();
    },
    async loadMorePending({ pages = 1 } = {}) {
      if (closed) return { added: 0, hasMore: false };
      const start = requiredPending.length;
      const next = allPending.slice(start, start + Math.max(1, Number(pages) || 1));
      if (!next.length) return { added: 0, hasMore: false };
      requiredPending = [...requiredPending, ...next];
      onSync?.({ rev: currentRev, status: "syncing", missing: missingPendingDTags().length });
      next.forEach((dTag) => {
        revSubs.push(
          subscribeEvents(mailboxRelays, [{ kinds: [MAILBOX_KIND], authors: [dvm.pubkey], "#d": [dTag] }], {
            onEvent: (ev) => {
              try {
                const json = decryptMailboxEvent(ev);
                if (!pendingPageUsable(json, dTag, currentRev)) return;
                pendingPages.set(dTag, json);
                writeCache(cacheKey(mb, dTag), json);
                maybeCompletePending(currentRev);
                emitJobs();
              } catch {}
            }
          })
        );
      });
      await fetchPendingPagesOnce(currentRev, next);
      schedulePendingTimeout(currentRev);
      maybeCompletePending(currentRev);
      emitJobs();
      return { added: next.length, hasMore: requiredPending.length < allPending.length };
    },
    hasMoreHistory() {
      return hasMoreHistoryInternal();
    },
    async loadMoreHistory({ pages = 1 } = {}) {
      return loadMoreHistoryInternal({ pages });
    }
  };
}

// Fetch and reconstruct a note blob referenced by a pending job.
export async function fetchNoteBlob(pubkey, noteBlob, relaysOverride = null) {
  if (!pubkey || !noteBlob?.dBase || !noteBlob?.parts) {
    throw new Error("Invalid noteBlob reference");
  }
  const dvm = getDvmConfig();
  const mailboxRelays = resolveRelays(relaysOverride || dvm.relays);
  const { blobKey } = await ensureMailboxSecrets(pubkey);

  const dTags = Array.from({ length: Number(noteBlob.parts) }, (_, i) => `${noteBlob.dBase}${i}`);
  const fetchByDTags = async () =>
    fetchEventsOnce(mailboxRelays, {
      kinds: [MAILBOX_KIND],
      authors: [dvm.pubkey],
      "#d": dTags,
      limit: dTags.length
    });

  let events = await fetchByDTags();
  // Fallback for relays that don't index d: fetch by author and client-filter.
  if ((events?.length || 0) < dTags.length) {
    const broad = await fetchEventsOnce(mailboxRelays, {
      kinds: [MAILBOX_KIND],
      authors: [dvm.pubkey],
      limit: dTags.length * 2
    });
    events = [...(events || []), ...(broad || [])];
  }

  const latestByD = new Map();
  for (const ev of events || []) {
    const dTag = ev.tags?.find((t) => Array.isArray(t) && t[0] === "d")?.[1];
    if (!dTag || !dTags.includes(dTag)) continue;
    const prev = latestByD.get(dTag);
    if (!prev || (Number(ev.created_at) || 0) > (Number(prev.created_at) || 0)) {
      latestByD.set(dTag, ev);
    }
  }

  const parts = [];
  for (let i = 0; i < dTags.length; i++) {
    const ev = latestByD.get(dTags[i]);
    if (!ev) throw new Error("Missing blob part");
    const plain = nip44DecryptWithKey(blobKey, String(ev.content || ""));
    const json = JSON.parse(plain || "{}");
    parts[i] = String(json?.data || "");
  }

  const fullStr = parts.join("");
  const full = JSON.parse(fullStr || "{}");
  return {
    content: String(full.content || ""),
    tags: Array.isArray(full.tags) ? full.tags : []
  };
}
