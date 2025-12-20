import "dotenv/config";
import { call, identity, last, ms, now, spec } from "@welshman/lib";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, nip44, validateEvent, verifyEvent } from "nostr-tools";
import { getSharedSecret } from "@noble/secp256k1";
import {
  DVM_REQUEST_PUBLISH_SCHEDULE,
  HANDLER_INFORMATION,
  PROFILE,
  RELAYS,
  displayRelayUrl,
  getTagValue,
  makeEvent,
  normalizeRelayUrl
} from "@welshman/util";
import { Nip01Signer } from "@welshman/signer";
import { PublishStatus, publish, request, requestOne } from "@welshman/net";
import { notifyJobUpdate } from "./api.js";
import { flushAllMailboxes, initMailboxPublisher, queueMailboxPublish, repairMailbox } from "./mailbox.js";
import { LruTtlCache } from "./cache.js";
import { createScheduler } from "./scheduler.js";
import {
  deleteJob,
  getEarliestPendingTimestamp,
  getJobById,
  listPendingJobs,
  markJobStatus,
  updateJob,
  upsertJob
} from "./jobsDb.js";
import {
  getSettings,
  getSupportActiveInvoice,
  getSupportInvoiceById,
  getSupportState,
  insertSupportInvoice,
  listPendingSupportInvoices,
  mutateSupportState,
  updateSupportInvoice,
  recordJobHistory,
  saveSettings,
  upsertNoteMeta,
  upsertPreviewKeyCapsules
} from "./appDataDb.js";
import { getSupportPolicy } from "./supportPolicy.js";
import { createInvoiceViaLnurlVerify, verifyInvoiceViaLnurlVerify } from "./supportPayments.js";
import crypto from "crypto";
import net from "net";

const VERBOSE = process.env.VERBOSE_LOGS !== "0";
const MASTER_KIND = 5900;
const MASTER_REQUEST_KIND = 5901;
const DM_REQUEST_KIND = 5906;
const DM_RETRY_KIND = 5907;
const MAILBOX_REPAIR_KIND = 5908;
const SUPPORT_ACTION_KIND = 5910;
const GIFT_WRAP_KIND = 1059;
const MASTER_VERSION = 3;
const DM_JOB_TYPE = "dm17";
const REPOST_KIND = 6;
const AMBER_NIP46_COMPAT_PREFIX = "\n";

const fromCsv = (s = "") => s.split(",").map((v) => v.trim()).filter(identity);
const uniq = (list = []) => Array.from(new Set(list));

const bytesToB64u = (u8) => Buffer.from(u8).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const MAX_PUBLISH_RELAYS = Math.max(1, Math.min(Number(process.env.DVM_MAX_PUBLISH_RELAYS || 20) || 20, 64));
const MAX_RELAY_URL_LEN = Math.max(32, Math.min(Number(process.env.DVM_MAX_RELAY_URL_LEN || 200) || 200, 1024));

const masterPublishThrottle = new Map(); // pubkey -> unix seconds
const inFlightPublishes = new Map(); // jobId -> Promise
let shuttingDown = false;
let INDEXER_RELAYS = [];
let DVM_RELAYS = [];
let DVM_PUBLISH_RELAYS = [];
let DVM_NAME = "";
let DVM_ABOUT = "";
let DVM_PICTURE = "";
let LOADTEST_MODE = false;
let jobScheduler = null;
let supportVerifyTimer = null;

const mailboxSecretsCache = new LruTtlCache({
  max: Math.max(100, Number(process.env.DVM_SECRETS_CACHE_MAX || 5000) || 5000),
  ttlMs: Math.max(0, Number(process.env.DVM_SECRETS_CACHE_TTL_MS || 0) || 0)
});
const nip44ConversationKeyCache = new LruTtlCache({
  max: Math.max(100, Number(process.env.DVM_NIP44_KEY_CACHE_MAX || 5000) || 5000),
  ttlMs: Math.max(0, Number(process.env.DVM_NIP44_KEY_CACHE_TTL_MS || 30 * 60 * 1000) || 0)
});
const dmRelayListCache = new LruTtlCache({
  max: Math.max(100, Number(process.env.DVM_DM_RELAYS_CACHE_MAX || 5000) || 5000),
  ttlMs: Math.max(0, Number(process.env.DVM_DM_RELAYS_CACHE_TTL_MS || 10 * 60 * 1000) || 0)
});
const DM_RELAYS_EMPTY_TTL_MS = Math.max(0, Number(process.env.DVM_DM_RELAYS_CACHE_EMPTY_TTL_MS || 60 * 1000) || 0);

function normalizeSupportFeature(feature = "") {
  return String(feature || "").trim().toLowerCase();
}

function noteToSupportFeature(note) {
  const kind = Number(note?.kind) || 0;
  if (kind === REPOST_KIND) return "repost";
  if (kind === 1) {
    const tags = Array.isArray(note?.tags) ? note.tags : [];
    if (tags.some((t) => Array.isArray(t) && t[0] === "q" && typeof t[1] === "string")) return "quote";
    return "note";
  }
  return "note";
}

function policyHasFeature(policy, feature) {
  const want = normalizeSupportFeature(feature);
  if (!want) return false;
  const list = Array.isArray(policy?.gatedFeatures) ? policy.gatedFeatures : [];
  return list.some((f) => normalizeSupportFeature(f) === want);
}

function supportIsSupporter(state, tsSec) {
  return (Number(state?.supporterUntil) || 0) > (Number(tsSec) || 0);
}

function supportIsUnlocked(state) {
  const count = Number(state?.scheduleCount) || 0;
  const until = Number(state?.freeUntilCount) || 0;
  return count < until;
}

function supportEnsureInitialized(pubkey, policy) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  const state0 = getSupportState(pk);
  const windowSchedules = Number(policy?.windowSchedules) || 0;
  if (state0 && state0.nextPromptAtCount) return state0;
  if (!(windowSchedules > 0)) return state0;
  return mutateSupportState(pk, (s) => {
    if (s.nextPromptAtCount) return s;
    return { ...s, nextPromptAtCount: Math.max(1, Math.floor(windowSchedules)) };
  });
}

function supportApplyUseFree(state, policy) {
  const windowSchedules = Math.max(1, Number(policy?.windowSchedules) || 0);
  const base = Number(state?.scheduleCount) || 0;
  const until = base + windowSchedules;
  return {
    ...state,
    freeUntilCount: Math.max(Number(state?.freeUntilCount) || 0, until),
    nextPromptAtCount: Math.max(Number(state?.nextPromptAtCount) || 0, until),
    gatePrompt: null
  };
}

function supportApplyMaybeLater(state, policy) {
  const windowSchedules = Math.max(1, Number(policy?.windowSchedules) || 0);
  const base = Number(state?.scheduleCount) || 0;
  const nextPrompt = base + windowSchedules;
  return {
    ...state,
    nextPromptAtCount: Math.max(Number(state?.nextPromptAtCount) || 0, nextPrompt),
    gatePrompt: null
  };
}

function supportApplySupportClick(state, policy) {
  // For now: treat a support intent as a free unlock too; payment verification (supporterUntil) is handled separately (future).
  return supportApplyUseFree(state, policy);
}

function getSupportPaymentConfig(policy) {
  const payment = policy?.payment && typeof policy.payment === "object" ? policy.payment : {};
  const mode = String(payment?.mode || "").trim().toLowerCase() === "lnurl_verify" ? "lnurl_verify" : "none";
  const invoiceSats = Math.max(0, Math.floor(Number(payment?.invoiceSats) || 0));
  const minSatsRaw = Math.max(0, Math.floor(Number(payment?.minSats) || 0));
  const minSats = minSatsRaw || invoiceSats || 0;
  const supporterDays = Math.max(0, Math.floor(Number(payment?.supporterDays) || 0));
  const invoiceTtlSec = Math.max(0, Math.floor(Number(payment?.invoiceTtlSec) || 0));
  const verifyPollSec = Math.max(0, Math.floor(Number(payment?.verifyPollSec) || 0));
  const verifyTimeoutMs = Math.max(1000, Math.floor(Number(payment?.verifyTimeoutMs) || 5000));
  return { mode, invoiceSats, minSats, supporterDays, invoiceTtlSec, verifyPollSec, verifyTimeoutMs };
}

function supporterUntilFromPayment({ nowSec, supporterDays }) {
  const days = Math.max(0, Number(supporterDays) || 0);
  if (!(days > 0)) return 0;
  const base = Math.max(0, Number(nowSec) || 0);
  return base + days * 86400;
}

async function ensureSupportInvoice({ pubkey, policy, sats = 0 } = {}) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;

  const pol = policy || getSupportPolicy();
  const payCfg = getSupportPaymentConfig(pol);
  if (payCfg.mode !== "lnurl_verify") return null;

  const lud16 = String(pol?.cta?.lud16 || "").trim();
  if (!lud16) return null;

  const HARD_MAX_SATS = 10_000_000; // 0.1 BTC safety cap (can be made configurable if needed)
  const requested = Math.max(0, Math.floor(Number(sats) || 0));
  const base = requested > 0 ? requested : payCfg.invoiceSats || payCfg.minSats;
  const min = Math.max(0, Number(payCfg.minSats) || 0);
  const satsWanted = Math.max(min, Math.min(HARD_MAX_SATS, Math.floor(Number(base) || 0)));
  if (!(satsWanted > 0)) return null;

  const existing = getSupportActiveInvoice(pk);
  const ts = now();
  if (existing?.pr && existing?.id) {
    const expiresAt = Number(existing.expiresAt) || 0;
    if (expiresAt && expiresAt <= ts) {
      updateSupportInvoice(pk, existing.id, { status: "expired" });
    } else {
      const currentSats = Math.max(0, Math.floor(Number(existing.sats) || 0));
      if (!requested || currentSats === satsWanted) return existing;
      // Requested a different amount; keep existing invoice pending (it may still be paid), and issue a new one.
    }
  }

  const createdAt = ts;
  const expiresAt = payCfg.invoiceTtlSec > 0 ? createdAt + payCfg.invoiceTtlSec : 0;
  const comment = String(process.env.DVM_SUPPORT_INVOICE_COMMENT || process.env.DVM_SUPPORT_MESSAGE || "Support").trim();

  const invoice = await createInvoiceViaLnurlVerify({
    lud16,
    sats: satsWanted,
    comment,
    timeoutMs: payCfg.verifyTimeoutMs,
    allowHttp: Boolean(LOADTEST_MODE)
  });

  const id = crypto.randomBytes(16).toString("hex");
  const inserted = insertSupportInvoice({
    id,
    pubkey: pk,
    pr: invoice.pr,
    verifyUrl: invoice.verifyUrl,
    sats: invoice.sats,
    status: "pending",
    createdAt,
    expiresAt
  });
  queueMailboxPublish(pk);
  return inserted;
}

async function checkSupportInvoice({ pubkey, invoiceId = "", policy, force = false } = {}) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;

  const pol = policy || getSupportPolicy();
  const payCfg = getSupportPaymentConfig(pol);
  if (payCfg.mode !== "lnurl_verify") return null;

  const id = String(invoiceId || "").trim();
  const inv = id ? getSupportInvoiceById(pk, id) : getSupportActiveInvoice(pk);
  if (!inv?.id || !inv?.verifyUrl) return null;
  if (String(inv.status || "").trim().toLowerCase() !== "pending") return inv;

  const ts = now();
  const expiresAt = Number(inv.expiresAt) || 0;
  if (expiresAt && expiresAt <= ts) {
    updateSupportInvoice(pk, inv.id, { status: "expired", lastCheckAt: ts, lastError: "" });
    queueMailboxPublish(pk);
    return getSupportInvoiceById(pk, inv.id) || inv;
  }

  if (!force && payCfg.verifyPollSec > 0) {
    const lastCheckAt = Number(inv.lastCheckAt) || 0;
    if (lastCheckAt > 0 && ts - lastCheckAt < payCfg.verifyPollSec) return inv;
  }

  try {
    const result = await verifyInvoiceViaLnurlVerify({
      verifyUrl: inv.verifyUrl,
      timeoutMs: payCfg.verifyTimeoutMs,
      allowHttp: Boolean(LOADTEST_MODE)
    });

    if (result.settled) {
      const updated = updateSupportInvoice(pk, inv.id, {
        status: "settled",
        settledAt: ts,
        preimage: result.preimage || "",
        lastCheckAt: ts,
        lastError: ""
      });

      if ((Number(inv.sats) || 0) >= payCfg.minSats) {
        mutateSupportState(pk, (s) => ({
          ...s,
          supporterUntil: Math.max(Number(s?.supporterUntil) || 0, supporterUntilFromPayment({ nowSec: ts, supporterDays: payCfg.supporterDays })),
          gatePrompt: null
        }));
      }
      queueMailboxPublish(pk);
      return updated || inv;
    }

    // Unsettled: only update lastCheckAt for polling purposes; avoid mailbox spam.
    updateSupportInvoice(pk, inv.id, { lastCheckAt: ts, lastError: "" });
    return inv;
  } catch (err) {
    const msg = String(err?.message || err || "verify failed");
    const nextStatus = msg.toLowerCase().includes("not found") ? "expired" : "pending";
    updateSupportInvoice(pk, inv.id, { status: nextStatus, lastCheckAt: ts, lastError: msg });
    if (nextStatus !== "pending") queueMailboxPublish(pk);
    return inv;
  }
}

async function pollSupportInvoicesOnce({ policy } = {}) {
  const pol = policy || getSupportPolicy();
  const payCfg = getSupportPaymentConfig(pol);
  if (payCfg.mode !== "lnurl_verify") return;
  if (!(payCfg.verifyPollSec > 0)) return;

  const ts = now();
  const olderThan = ts - payCfg.verifyPollSec;
  const pending = listPendingSupportInvoices({ limit: 50, olderThanSec: olderThan });
  if (!pending.length) return;

  for (const inv of pending) {
    const invoiceId = String(inv?.id || "").trim();
    const pubkey = String(inv?.pubkey || "").trim();
    if (!invoiceId || !pubkey) continue;
    supportVerifyWorkQueue.push(
      () => checkSupportInvoice({ pubkey, invoiceId, policy: pol, force: true }),
      `verify:${invoiceId}`
    );
  }
}

function makeGatePrompt({ reason, feature, scheduledAt, policy }) {
  const raw = `${String(reason || "")}|${normalizeSupportFeature(feature)}|${Number(scheduledAt) || 0}|${Number(policy?.horizonDays) || 0}`;
  const id = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return {
    v: 1,
    id: `gate:${id}`,
    type: "gate",
    reason: String(reason || ""),
    feature: normalizeSupportFeature(feature),
    scheduledAt: Number(scheduledAt) || 0,
    horizonDays: Number(policy?.horizonDays) || 0,
    createdAt: now()
  };
}

function enforceSupportGates({ pubkey, scheduledAt, feature, cap, policy }) {
  const pk = String(pubkey || "").trim();
  if (!pk) return;

  const pol = policy || getSupportPolicy();
  const state0 = supportEnsureInitialized(pk, pol);

  const capObj = cap && typeof cap === "object" ? cap : null;
  const allowFree = Boolean(capObj?.allowFree);

  // Accept a client "use free" bypass; DVM remains authoritative and updates state.
  const state = allowFree ? mutateSupportState(pk, (s) => supportApplyUseFree(s, pol)) : state0;

  if (supportIsSupporter(state, now()) || supportIsUnlocked(state)) return;

  const horizonDays = Number(pol?.horizonDays) || 0;
  const horizonSec = horizonDays > 0 ? horizonDays * 86400 : 0;
  const tooFar = horizonSec > 0 && (Number(scheduledAt) || 0) > now() + horizonSec;
  const gatedFeature = policyHasFeature(pol, feature);

  if (!tooFar && !gatedFeature) return;

  const reason = tooFar ? "horizon" : "feature";
  mutateSupportState(pk, (s) => ({ ...s, gatePrompt: makeGatePrompt({ reason, feature, scheduledAt, policy: pol }) }));
  queueMailboxPublish(pk);
  throw new Error("Support gate: action requires supporter (or use for free)");
}

function bumpSupportScheduleCount(pubkey, policy) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  const pol = policy || getSupportPolicy();
  return mutateSupportState(pk, (s) => {
    const windowSchedules = Number(pol?.windowSchedules) || 0;
    const nextCount = (Number(s?.scheduleCount) || 0) + 1;
    const next = { ...s, scheduleCount: nextCount };
    if (!next.nextPromptAtCount && windowSchedules > 0) {
      next.nextPromptAtCount = Math.max(1, Math.floor(windowSchedules));
    }
    return next;
  });
}

function createWorkQueue({ name = "queue", concurrency = 4, maxSize = 2000 } = {}) {
  const max = Math.max(1, Number(concurrency) || 1);
  const cap = Math.max(1, Number(maxSize) || 1);
  const queue = [];
  const keys = new Set(); // queued + active
  let active = 0;

  const pump = () => {
    while (active < max && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.fn)
        .catch((err) => {
          console.warn(`[${name}] task failed`, err?.message || err);
        })
        .finally(() => {
          active -= 1;
          if (item.key) keys.delete(item.key);
          pump();
        });
    }
  };

  const push = (fn, key = "") => {
    const k = String(key || "");
    if (k && keys.has(k)) return true; // already queued/in-flight, treat as accepted
    if (queue.length >= cap) return false;
    if (k) keys.add(k);
    queue.push({ fn, key: k });
    pump();
    return true;
  };

  const stats = () => ({ active, queued: queue.length, cap, concurrency: max });

  return { push, stats };
}

const requestWorkQueue = createWorkQueue({
  name: "requests",
  concurrency: Number(process.env.DVM_REQUEST_CONCURRENCY || 4),
  maxSize: Number(process.env.DVM_REQUEST_QUEUE_MAX || 3000)
});

const supportVerifyWorkQueue = createWorkQueue({
  name: "support-verify",
  concurrency: Number(process.env.DVM_SUPPORT_VERIFY_CONCURRENCY || 2),
  maxSize: Number(process.env.DVM_SUPPORT_VERIFY_QUEUE_MAX || 2000)
});

function usage(msg = "") {
  if (msg) console.error(msg);
  console.error(`
Pidgeon DVM

Configuration is read from env (server/.env) with optional CLI overrides.

CLI overrides:
  --secret <hex|nsec>                 Overrides DVM_SECRET
  --name <string>                     Overrides DVM_NAME
  --about <string>                    Overrides DVM_ABOUT
  --picture <url>                     Overrides DVM_PICTURE
  --relay <ws://...>                  Overrides DVM_RELAYS (repeatable or comma-separated)
  --indexer-relay <ws://...>          Overrides INDEXER_RELAYS (repeatable or comma-separated)
  --publish-relay <ws://...>          Overrides DVM_PUBLISH_RELAYS (repeatable or comma-separated)

Local load testing safety:
  --loadtest                           Refuses non-localhost relay URLs for all relay flags above

Notes:
  - If you pass --relay, relays from env are ignored.
  - If you pass no --indexer-relay, indexer relays default to DVM relays.
  - If you pass no --publish-relay, publish relays default to env DVM_PUBLISH_RELAYS (or DVM relays).
`.trim());
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    const val = next && !next.startsWith("--") ? argv[++i] : "true";
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, val] : [prev, val];
    } else {
      out[key] = val;
    }
  }
  return out;
}

function truthy(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function flattenArgList(v) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list
    .flatMap((x) => String(x || "").split(/[,\s]+/))
    .map((x) => String(x || "").trim())
    .filter(Boolean);
}

function normalizeRelayList(list) {
  return uniq(list.map(normalizeRelayUrl).filter(identity));
}

function isLocalhostRelay(relay) {
  const r = normalizeRelayUrl(relay);
  if (!r) return false;
  try {
    const u = new URL(r);
    if (!["ws:", "wss:"].includes(u.protocol)) return false;
    const host = String(u.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return false;
  }
}

function requireLocalhostRelays(relays, label) {
  const bad = (relays || []).filter((r) => r && !isLocalhostRelay(r));
  if (bad.length) {
    throw new Error(`${label} must be localhost relay URL(s); refusing: ${bad.join(", ")}`);
  }
}

function resolveConfig(argv = []) {
  const args = parseArgs(argv);
  if (truthy(args.help) || truthy(args.h)) {
    usage();
    process.exit(0);
  }

  const loadtest = truthy(args.loadtest);

  const secret = String(args.secret || args["dvm-secret"] || process.env.DVM_SECRET || "").trim();
  const name = String(args.name || args["dvm-name"] || process.env.DVM_NAME || "Pidgeon DVM").trim();
  const about = String(args.about || args["dvm-about"] || process.env.DVM_ABOUT || "Schedules signed notes on your relays").trim();
  const picture = String(args.picture || args["dvm-picture"] || process.env.DVM_PICTURE || "").trim();

  const cliRelays = flattenArgList(args.relay ?? args.relays ?? args["dvm-relay"] ?? args["dvm-relays"]);
  const cliIndexerRelays = flattenArgList(args["indexer-relay"] ?? args["indexer-relays"]);
  const cliPublishRelays = flattenArgList(args["publish-relay"] ?? args["publish-relays"]);

  const envRelays = fromCsv(process.env.DVM_RELAYS || "");
  const envIndexerRelays = fromCsv(process.env.INDEXER_RELAYS || "");
  const envPublishRelays = fromCsv(process.env.DVM_PUBLISH_RELAYS || "");

  const dvmRelays = normalizeRelayList((cliRelays.length ? cliRelays : envRelays) || []);

  // If you override DVM relays via CLI, default indexer/publish to those same relays unless explicitly overridden.
  const indexerRelays = normalizeRelayList(
    (cliIndexerRelays.length ? cliIndexerRelays : cliRelays.length ? dvmRelays : envIndexerRelays.length ? envIndexerRelays : dvmRelays) || []
  );
  const publishRelays = normalizeRelayList(
    (cliPublishRelays.length ? cliPublishRelays : cliRelays.length ? dvmRelays : envPublishRelays.length ? envPublishRelays : dvmRelays) || []
  );

  if (!secret) throw new Error("Missing DVM secret (set DVM_SECRET or pass --secret)");
  if (!dvmRelays.length) throw new Error("Missing DVM relays (set DVM_RELAYS or pass --relay)");
  if (!indexerRelays.length) throw new Error("Missing indexer relays (set INDEXER_RELAYS or pass --indexer-relay, or pass --relay)");

  if (loadtest) {
    requireLocalhostRelays(dvmRelays, "--relay/DVM_RELAYS");
    requireLocalhostRelays(indexerRelays, "--indexer-relay/INDEXER_RELAYS");
    requireLocalhostRelays(publishRelays, "--publish-relay/DVM_PUBLISH_RELAYS");
  }

  return { loadtest, secret, name, about, picture, dvmRelays, indexerRelays, publishRelays };
}

function isPrivateIp(ip) {
  const s = String(ip || "").trim().toLowerCase();
  if (!s) return true;
  if (s.startsWith("::ffff:")) return isPrivateIp(s.slice("::ffff:".length));

  const v = net.isIP(s);
  if (v === 4) {
    const parts = s.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmark/testing
    return false;
  }
  if (v === 6) {
    if (s === "::1") return true;
    if (s.startsWith("fe80:")) return true;
    if (s.startsWith("fc") || s.startsWith("fd")) return true;
    if (s.startsWith("::")) return true;
    return false;
  }
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

function normalizeAndValidateUserRelayUrl(input) {
  const candidate = String(input || "").trim();
  if (!candidate || candidate.length > MAX_RELAY_URL_LEN) return "";
  const normalized = normalizeRelayUrl(candidate);
  if (!normalized || normalized.length > MAX_RELAY_URL_LEN) return "";
  try {
    const url = new URL(normalized);
    if (!["ws:", "wss:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    if (isBlockedHostname(url.hostname)) {
      // By default we refuse private/localhost relay hints to avoid SSRF. In loadtest mode we allow localhost-only.
      if (!LOADTEST_MODE || !isLocalhostRelay(normalized)) return "";
    }
    return normalized;
  } catch {
    return "";
  }
}

const vLog = (...args) => {
  if (VERBOSE) console.log(...args);
};

async function withAbortTimeout(msTimeout, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), msTimeout);
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
  concurrency = Number(process.env.DVM_RELAY_QUERY_CONCURRENCY || 3)
}) {
  const relayList = uniq(relays).map(normalizeRelayUrl).filter(identity);
  if (!relayList.length) return { relay: null, event: null };

  const max = Math.max(1, Math.min(Number(concurrency) || 1, relayList.length));
  let cursor = 0;
  let found = null;
  let foundRelay = null;

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
  return { relay: foundRelay, event: found };
}

async function relayHasEvent({ relay, id }) {
  if (!relay || !id) return false;
  try {
    const { event } = await requestOneFirst({
      relays: [relay],
      filters: [{ ids: [id], limit: 1 }],
      timeoutMs: 2000,
      concurrency: 1
    });
    return Boolean(event);
  } catch {
    return false;
  }
}

function isHexId(id = "") {
  return /^[a-f0-9]{64}$/i.test(String(id || "").trim());
}

function extractRepostTarget(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const eTag = tags.find((t) => Array.isArray(t) && t[0] === "e" && typeof t[1] === "string");
  const targetId = String(eTag?.[1] || "").trim();
  const relayHint = normalizeRelayUrl(String(eTag?.[2] || "").trim());
  return { targetId, relayHint };
}

function validateRepostEvent(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const { targetId, relayHint } = extractRepostTarget(ev);
  if (!targetId) throw new Error("Repost missing e tag");
  if (!isHexId(targetId)) throw new Error("Repost e tag must reference a 64-char hex id");
  if (!relayHint) throw new Error("Repost e tag must include a relay hint");
  if (!relayHint.startsWith("ws")) throw new Error("Repost relay hint must be ws(s)://");

  // `p` tags are recommended; if present, they must be valid hex pubkeys.
  const pTags = tags.filter((t) => Array.isArray(t) && t[0] === "p");
  for (const t of pTags) {
    const pk = normalizePubkeyHex(t?.[1]);
    if (!pk) throw new Error("Invalid repost p tag pubkey");
  }

  return { targetId, relayHint };
}

async function resolveRepostTarget({ targetId, relays }) {
  if (!isHexId(targetId)) return { kind: null, event: null };
  const relayList = uniq(relays).map(normalizeRelayUrl).filter(identity);
  if (!relayList.length) return { kind: null, event: null };

  // 1) Strict: must be a kind-1 target for a NIP-18 kind-6 repost.
  const strict = await requestOneFirst({
    relays: relayList,
    filters: [{ ids: [targetId], kinds: [1], limit: 1 }],
    timeoutMs: 2500
  });
  if (strict?.event) return { kind: 1, event: strict.event };

  // 2) Differentiate "not found" vs "wrong kind" for better UX.
  const anyKind = await requestOneFirst({
    relays: relayList,
    filters: [{ ids: [targetId], limit: 1 }],
    timeoutMs: 2500
  });
  if (anyKind?.event) return { kind: Number(anyKind.event?.kind) || 0, event: anyKind.event };

  return { kind: null, event: null };
}

async function maybeMarkSentIfAlreadyPublished({ payload }) {
  const relays = uniq(payload?.relays || []).map(normalizeRelayUrl).filter(identity);
  const relay = relays[0];
  const noteId = payload?.event?.id;
  if (!relay || !noteId) return false;
  const ok = await relayHasEvent({ relay, id: noteId });
  if (!ok) return false;

  const updatedJob = markJobStatus(payload.id, "sent");
  recordJobHistory(payload.id, "sent", `recovered: already on ${displayRelayUrl(relay)}`);
  if (updatedJob) {
    const note = updatedJob.payload?.event || {};
    notifyJobUpdate(updatedJob.requesterPubkey, {
      id: updatedJob.id,
      status: updatedJob.status,
      noteId: updatedJob.noteId,
      scheduledAt: updatedJob.scheduledAt,
      createdAt: updatedJob.createdAt,
      updatedAt: updatedJob.updatedAt,
      relays: updatedJob.relays,
      content: note.content || "",
      tags: note.tags || [],
      lastError: updatedJob.lastError || ""
    });
    queueMailboxPublish(updatedJob.requesterPubkey);
  }
  return true;
}

function resolveSecret(raw) {
  const secret = String(raw || "").trim();
  if (!secret) throw new Error("DVM_SECRET is required");
  if (secret.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(secret);
      if (decoded.type !== "nsec" || !decoded.data) throw new Error("Invalid nsec");
      return bytesToHex(decoded.data);
    } catch (err) {
      throw new Error(`Failed to decode DVM_SECRET nsec: ${err?.message || err}`);
    }
  }
  return secret;
}

let DVM_PUBKEY = "";
let DVM_SK_HEX = "";
let DVM_SK_BYTES = null;

function nostrPubkeyToSecpCompressed(pubkey) {
  let hex = String(pubkey || "").trim();
  if (!hex) throw new Error("Missing pubkey");
  if (hex.startsWith("npub1")) {
    const decoded = nip19.decode(hex);
    if (decoded.type !== "npub" || !decoded.data) throw new Error("Invalid npub");
    hex = typeof decoded.data === "string" ? decoded.data : bytesToHex(decoded.data);
  }
  const raw = hexToBytes(hex);
  if (raw.length !== 32) throw new Error("Invalid pubkey length");
  const compressed = new Uint8Array(33);
  compressed[0] = 0x02; // even Y by convention for x-only pubkeys
  compressed.set(raw, 1);
  return compressed;
}

function deriveMasterKey(pubkey) {
  if (!DVM_SK_HEX || !DVM_PUBKEY) throw new Error("DVM key material not initialized");
  const shared = getSharedSecret(DVM_SK_BYTES, nostrPubkeyToSecpCompressed(pubkey), true).slice(1);
  const salt = Buffer.from("pidgeon:v3", "utf8");
  const info = Buffer.from(`pidgeon:v3:root:${DVM_PUBKEY}`, "utf8");
  const rootKey = crypto.hkdfSync("sha256", shared, salt, info, 32);
  return { rootKey: new Uint8Array(rootKey) };
}

function deriveMailboxSecrets(pubkey) {
  const cacheKey = String(pubkey || "").trim();
  if (cacheKey) {
    const cached = mailboxSecretsCache.get(cacheKey);
    if (cached) return cached;
  }

  const { rootKey } = deriveMasterKey(pubkey);

  const sub = (label) =>
    new Uint8Array(
      crypto.hkdfSync("sha256", Buffer.from(rootKey), Buffer.alloc(0), Buffer.from(label, "utf8"), 32)
    );

  const mbBytes = crypto.hkdfSync(
    "sha256",
    Buffer.from(rootKey),
    Buffer.alloc(0),
    Buffer.from("pidgeon:v3:mailbox-id", "utf8"),
    16
  );
  const mb = bytesToB64u(new Uint8Array(mbBytes));

  const derived = {
    rootKey,
    mb,
    version: MASTER_VERSION,
    mailboxKey: sub("pidgeon:v3:key:mailbox"),
    submitKey: sub("pidgeon:v3:key:submit"),
    dmKey: sub("pidgeon:v3:key:dm"),
    blobKey: sub("pidgeon:v3:key:blob")
  };

  if (cacheKey) mailboxSecretsCache.set(cacheKey, derived);
  return derived;
}

function computeBackfillSince() {
  const ts = getEarliestPendingTimestamp();
  if (Number.isFinite(ts)) {
    // Clamp so we never subscribe from a time in the future (which would miss new events).
    const clamped = Math.min(ts - 600, now() - 300);
    return Math.max(0, clamped);
  }
  // Fresh boot with no scheduled jobs: only backfill a small window to avoid replaying ancient requests.
  return now() - 300;
}

async function filterMailboxRelaysByDIndexing({ signer, relays }) {
  const dvmPubkey = await signer.getPubkey();
  const settingsKey = "pidgeon.dvm.dIndexProbeCache.v1";
  const ttlSec = Math.max(0, Number(process.env.DVM_D_INDEX_PROBE_TTL_SEC || 7 * 24 * 3600) || 0);
  const nowSec = now();
  const probePrefix = `pidgeon:v3:probe:${dvmPubkey.slice(0, 8)}:`;
  const supported = [];
  let cache = {};
  let cacheDirty = false;

  if (ttlSec) {
    try {
      const existing = getSettings(dvmPubkey);
      const raw = existing?.[settingsKey];
      cache = raw ? JSON.parse(String(raw)) : {};
      if (!cache || typeof cache !== "object") cache = {};
    } catch {
      cache = {};
    }
  }

  for (const relay of relays || []) {
    try {
      const normalizedRelay = normalizeRelayUrl(relay);
      if (!normalizedRelay) continue;

      const cached = ttlSec ? cache?.[normalizedRelay] : null;
      if (cached && typeof cached.ok === "boolean" && Number.isFinite(Number(cached.ts))) {
        const age = nowSec - Number(cached.ts);
        if (age >= 0 && age < ttlSec) {
          if (cached.ok) supported.push(normalizedRelay);
          continue;
        }
      }

      const probeD = `${probePrefix}${crypto.randomBytes(6).toString("hex")}`;
      const draft = makeEvent(30078, {
        created_at: now(),
        content: "probe",
        tags: [
          ["d", probeD],
          ["k", "3"]
        ]
      });
      const ev = await signer.sign(draft);
      await publish({ relays: [normalizedRelay], event: ev });

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const events = await requestOne({
        relay: normalizedRelay,
        filters: [
          {
            kinds: [30078],
            authors: [dvmPubkey],
            "#d": [probeD],
            since: ev.created_at - 1,
            limit: 1
          }
        ],
        autoClose: true,
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const ok = Boolean(events?.length);
      if (ok) {
        supported.push(normalizedRelay);
      } else {
        console.warn(`[dvm] Relay does not index #d (mailbox will skip): ${normalizedRelay}`);
      }
      if (ttlSec) {
        cache[normalizedRelay] = { ok, ts: nowSec };
        cacheDirty = true;
      }
    } catch (err) {
      console.warn(`[dvm] Relay probe failed, skipping for mailbox: ${relay}`, err?.message || err);
      if (ttlSec) {
        const normalizedRelay = normalizeRelayUrl(relay);
        if (normalizedRelay) {
          cache[normalizedRelay] = { ok: false, ts: nowSec };
          cacheDirty = true;
        }
      }
    }
  }

  if (ttlSec && cacheDirty) {
    try {
      saveSettings(dvmPubkey, { [settingsKey]: JSON.stringify(cache) });
    } catch {
      // ignore cache persistence failures
    }
  }

  return supported.length ? supported : relays;
}

function normalizePubkeyHex(pubkey) {
  let hex = String(pubkey || "").trim();
  if (!hex) return "";
  if (hex.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(hex);
      if (decoded.type === "npub" && decoded.data) {
        return typeof decoded.data === "string" ? decoded.data : bytesToHex(decoded.data);
      }
    } catch {
      return "";
    }
  }
  if (hex.length !== 64) return "";
  return hex;
}

function parseRelayListFrom10050(ev) {
  const tags = Array.isArray(ev?.tags) ? ev.tags : [];
  const urls = tags
    .filter((t) => Array.isArray(t) && (t[0] === "relay" || t[0] === "r"))
    .map((t) => t[1])
    .map(normalizeRelayUrl)
    .filter(identity);
  return uniq(urls);
}

async function fetchPreferredDmRelays(pubkey) {
  const author = normalizePubkeyHex(pubkey);
  if (!author) return [];

  const cached = dmRelayListCache.get(author);
  if (cached) return Array.isArray(cached) ? [...cached] : [];

  const queryRelays = uniq([...INDEXER_RELAYS, ...DVM_RELAYS]).map(normalizeRelayUrl).filter(identity);
  if (!queryRelays.length) return [];

  const filters = [{ kinds: [10050], authors: [author], limit: 5 }];
  const results = await Promise.allSettled(
    queryRelays.map((relay) =>
      withAbortTimeout(2500, (signal) =>
        requestOne({
          relay,
          filters,
          autoClose: true,
          signal
        })
      )
    )
  );

  const events = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      (r.value || []).forEach((ev) => events.push(ev));
    }
  }
  if (!events.length) {
    dmRelayListCache.set(author, [], DM_RELAYS_EMPTY_TTL_MS);
    return [];
  }
  const latest = events.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0))[0];
  const relays = parseRelayListFrom10050(latest);
  dmRelayListCache.set(author, relays, relays.length ? undefined : DM_RELAYS_EMPTY_TTL_MS);
  return relays;
}

function summarizePublishResults(results = {}) {
  try {
    return Object.values(results)
      .map(({ relay, status, detail }) => {
        const s = last(String(status || "").split(":")) || String(status || "");
        const d = detail ? `:${detail}` : "";
        return `${displayRelayUrl(relay)}:${s}${d}`;
      })
      .join(" ");
  } catch {
    return "";
  }
}

function buildDmGiftWrap({ targetPubkey, seal }) {
  const target = normalizePubkeyHex(targetPubkey);
  if (!target) throw new Error("Invalid DM target pubkey");
  if (!seal || seal.kind !== 13) throw new Error("Invalid DM seal");
  const tags = Array.isArray(seal.tags) ? seal.tags : [];
  if (tags.length) throw new Error("DM seal must have empty tags");

  const ephemeralSk = generateSecretKey();
  const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, target);
  const wrapContent = nip44.v2.encrypt(`${AMBER_NIP46_COMPAT_PREFIX}${JSON.stringify(seal)}`, wrapKey);
  const created_at = now();
  return finalizeEvent(
    {
      kind: GIFT_WRAP_KIND,
      created_at,
      tags: [["p", target]],
      content: wrapContent,
    },
    ephemeralSk
  );
}

async function publishPayload({ signer, payload }) {
  if (shuttingDown) return;
  if (inFlightPublishes.has(payload.id)) return inFlightPublishes.get(payload.id);

  const run = (async () => {
    try {
      // If we crashed after publishing but before persisting status, avoid re-sending.
      if (await maybeMarkSentIfAlreadyPublished({ payload })) return;

      // Publish-time safety net for kind-6 reposts: ensure target resolves to kind-1.
      if (payload?.event?.kind === REPOST_KIND) {
        const { targetId, relayHint } = (() => {
          try {
            return validateRepostEvent(payload.event);
          } catch (err) {
            return { targetId: "", relayHint: "", error: err };
          }
        })();

        if (!targetId) {
          const msg = "Invalid repost: missing target";
          const updatedJob = markJobStatus(payload.id, "error", msg);
          recordJobHistory(payload.id, "error", msg);
          if (updatedJob) {
            const note = updatedJob.payload?.event || {};
            notifyJobUpdate(updatedJob.requesterPubkey, {
              id: updatedJob.id,
              status: updatedJob.status,
              noteId: updatedJob.noteId,
              scheduledAt: updatedJob.scheduledAt,
              createdAt: updatedJob.createdAt,
              updatedAt: updatedJob.updatedAt,
              relays: updatedJob.relays,
              content: note.content || "",
              tags: note.tags || [],
              lastError: updatedJob.lastError || ""
            });
          }
          queueMailboxPublish(payload.pubkey);
          return;
        }

        const relaysToTry = uniq([
          relayHint,
          ...uniq(payload.relays || []),
          ...uniq(INDEXER_RELAYS || []),
          ...uniq(DVM_RELAYS || [])
        ])
          .map(normalizeRelayUrl)
          .filter(identity);

        const resolved = await resolveRepostTarget({ targetId, relays: relaysToTry });
        if (resolved.kind !== 1) {
          const msg =
            resolved.kind && resolved.kind !== 1
              ? `Repost target is not kind:1 (got kind:${resolved.kind})`
              : "Repost target not found";
          const updatedJob = markJobStatus(payload.id, "error", msg);
          recordJobHistory(payload.id, "error", msg);
          if (updatedJob) {
            const note = updatedJob.payload?.event || {};
            notifyJobUpdate(updatedJob.requesterPubkey, {
              id: updatedJob.id,
              status: updatedJob.status,
              noteId: updatedJob.noteId,
              scheduledAt: updatedJob.scheduledAt,
              createdAt: updatedJob.createdAt,
              updatedAt: updatedJob.updatedAt,
              relays: updatedJob.relays,
              content: note.content || "",
              tags: note.tags || [],
              lastError: updatedJob.lastError || ""
            });
          }
          queueMailboxPublish(payload.pubkey);
          console.log(`[dvm] Skipping repost publish ${payload.id}: ${msg}`);
          return;
        }
      }

      const targetRelays = uniq(payload.relays || []);
      const result = await publish({ relays: targetRelays, event: payload.event });
      vLog(`[dvm] Publish result for ${payload.id}:`, result);
      const summary = summarizePublishResults(result);
      const ok = Object.values(result || {}).some((r) => r?.status === PublishStatus.Success);
      if (!ok) {
        const msg = summary ? `Publish failed (${summary})` : "Publish failed (no relay acknowledged)";
        const updatedJob = markJobStatus(payload.id, "error", msg);
        recordJobHistory(payload.id, "error", msg);
        if (updatedJob) {
          const note = updatedJob.payload?.event || {};
          notifyJobUpdate(updatedJob.requesterPubkey, {
            id: updatedJob.id,
            status: updatedJob.status,
            noteId: updatedJob.noteId,
            scheduledAt: updatedJob.scheduledAt,
            createdAt: updatedJob.createdAt,
            updatedAt: updatedJob.updatedAt,
            relays: updatedJob.relays,
            content: note.content || "",
            tags: note.tags || [],
            lastError: updatedJob.lastError || msg
          });
          queueMailboxPublish(updatedJob.requesterPubkey);
        }
        console.warn(`[dvm] Publish failed for ${payload.id}: ${msg}`);
        return;
      }

      const updatedJob = markJobStatus(payload.id, "sent");
      recordJobHistory(payload.id, "sent", summary);
      if (updatedJob) {
        const note = updatedJob.payload?.event || {};
        notifyJobUpdate(updatedJob.requesterPubkey, {
          id: updatedJob.id,
          status: updatedJob.status,
          noteId: updatedJob.noteId,
          scheduledAt: updatedJob.scheduledAt,
          createdAt: updatedJob.createdAt,
          updatedAt: updatedJob.updatedAt,
          relays: updatedJob.relays,
          content: note.content || "",
          tags: note.tags || [],
          lastError: updatedJob.lastError || ""
        });
      }
      queueMailboxPublish(updatedJob?.requesterPubkey || payload.pubkey);
      console.log(`[dvm] Published ${payload.id}: ${summary}`);
    } catch (err) {
      console.error(`[dvm] Publish failed ${payload.id}:`, err?.message || err);
      const msg = err?.message || "publish failed";
      const updatedJob = markJobStatus(payload.id, "error", msg);
      recordJobHistory(payload.id, "error", msg);
      if (updatedJob) {
        const note = updatedJob.payload?.event || {};
        notifyJobUpdate(updatedJob.requesterPubkey, {
          id: updatedJob.id,
          status: updatedJob.status,
          noteId: updatedJob.noteId,
          scheduledAt: updatedJob.scheduledAt,
          createdAt: updatedJob.createdAt,
          updatedAt: updatedJob.updatedAt,
          relays: updatedJob.relays,
          content: note.content || "",
          tags: note.tags || [],
          lastError: updatedJob.lastError || ""
        });
        queueMailboxPublish(updatedJob.requesterPubkey);
      }
    }
  })();

  inFlightPublishes.set(payload.id, run);
  try {
    return await run;
  } finally {
    inFlightPublishes.delete(payload.id);
  }
}

async function schedulePayload({ signer, payload }) {
  const policy = getSupportPolicy();
  enforceSupportGates({
    pubkey: payload.pubkey,
    scheduledAt: payload?.event?.created_at,
    feature: noteToSupportFeature(payload?.event),
    cap: payload?.cap,
    policy
  });

  const delay = Math.max(0, ms(payload.event.created_at - now()));
  upsertJob({
    id: payload.id,
    requesterPubkey: payload.pubkey,
    dvmPubkey: await signer.getPubkey(),
    relays: payload.relays,
    payload,
    noteId: payload.event.id,
    scheduledAt: payload.event.created_at,
    createdAt: now(),
    status: "scheduled"
  });
  recordJobHistory(payload.id, "scheduled", `delay ${delay}ms`);
  upsertNoteMeta({
    noteId: payload.event.id,
    requesterPubkey: payload.pubkey,
    kind: payload.event.kind,
    contentHash: payload.event.id,
    media: payload.event.tags?.filter((t) => t[0] === "imeta" || t[0] === "url") || []
  });
  vLog(
    `[dvm] Scheduling ${payload.id} for ${payload.event.created_at} (delay ${delay}ms) relays=${payload.relays.length} note=${payload.event.id}`
  );
  if (!jobScheduler) throw new Error("Scheduler not initialized");
  jobScheduler.schedule(payload.id, payload.event.created_at);
  bumpSupportScheduleCount(payload.pubkey, policy);
  queueMailboxPublish(payload.pubkey);
  console.log(`[dvm] Scheduled ${payload.id} for ${payload.event.created_at} (${delay}ms)`);
}

async function parseRequest({ event, dvmRelays, requesterPubkey }) {
  if (event.kind !== DVM_REQUEST_PUBLISH_SCHEDULE) {
    throw new Error(`Invalid request kind ${event.kind}`);
  }
  if (!requesterPubkey) throw new Error("Missing requester pubkey");
  const { submitKey } = deriveMailboxSecrets(requesterPubkey);
  const decrypted = nip44.v2.decrypt(String(event.content || ""), new Uint8Array(submitKey));
  const parsed = JSON.parse(decrypted);
  const tags = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tags) ? parsed.tags : [];
  if (!Array.isArray(tags)) throw new Error("Invalid request payload");
  const cap = parsed && typeof parsed === "object" && parsed?.cap && typeof parsed.cap === "object" ? parsed.cap : null;

  // Require outer recipient tag match on the rumor itself.
  const outerPTags = (Array.isArray(event.tags) ? event.tags : [])
    .filter((t) => Array.isArray(t) && t[0] === "p")
    .map((t) => t[1]);
  if (!outerPTags.includes(DVM_PUBKEY)) throw new Error("Request not addressed to this DVM");

  const input = getTagValue("i", tags);
  if (!input) throw new Error("Missing input tag");
  const note = JSON.parse(input);
  if (!note?.id || !isHexId(note.id)) throw new Error("Invalid signed event id");
  if (note.kind !== 1 && note.kind !== REPOST_KIND) {
    throw new Error(`Unsupported event kind ${note.kind}`);
  }
  if (!note?.pubkey) throw new Error("Signed note pubkey missing");
  if (note.pubkey !== requesterPubkey) throw new Error("Signed note pubkey mismatch");
  if (!validateEvent(note) || !verifyEvent(note)) {
    throw new Error("Invalid signed note event");
  }
  if (note.kind === REPOST_KIND) {
    validateRepostEvent(note);
  }

  const relayTag = tags.find((t) => Array.isArray(t) && t[0] === "relays");
  const paramRelays = tags.find(spec(["param", "relays"]));
  const untrusted = paramRelays ? paramRelays.slice(2) : relayTag ? relayTag.slice(1) : null;
  const picked = uniq(
    (Array.isArray(untrusted) ? untrusted : [])
      .map(normalizeAndValidateUserRelayUrl)
      .filter(identity)
      .slice(0, MAX_PUBLISH_RELAYS)
  );
  const relays = picked.length ? picked : uniq(DVM_PUBLISH_RELAYS.length ? DVM_PUBLISH_RELAYS : dvmRelays);

  vLog(
    `[dvm] Parsed request ${event.id} from ${event.pubkey} note=${note.id} created_at=${note.created_at} relays=${relays.length}`
  );

  return {
    id: event.id,
    pubkey: requesterPubkey,
    event: note,
    relays: relays.length ? relays : dvmRelays,
    cap
  };
}

async function parseDmRequest({ event, requesterPubkey }) {
  if (event.kind !== DM_REQUEST_KIND) {
    throw new Error(`Invalid DM request kind ${event.kind}`);
  }
  if (!requesterPubkey) throw new Error("Missing requester pubkey");
  const { dmKey } = deriveMailboxSecrets(requesterPubkey);
  const decrypted = nip44.v2.decrypt(String(event.content || ""), new Uint8Array(dmKey));
  const parsed = JSON.parse(decrypted || "{}");
  const cap = parsed && typeof parsed === "object" && parsed?.cap && typeof parsed.cap === "object" ? parsed.cap : null;

  const outerPTags = (Array.isArray(event.tags) ? event.tags : [])
    .filter((t) => Array.isArray(t) && t[0] === "p")
    .map((t) => t[1]);
  if (!outerPTags.includes(DVM_PUBKEY)) throw new Error("Request not addressed to this DVM");

  const scheduledAt = Number(parsed?.scheduledAt) || 0;
  if (!scheduledAt) throw new Error("Missing scheduledAt");

  const dmEnc = String(parsed?.dmEnc || "");
  if (!dmEnc) throw new Error("Missing dmEnc payload");

  const pkvId = String(parsed?.pkv_id || "").trim();
  const dmMeta = parsed?.dmMeta && typeof parsed.dmMeta === "object" ? parsed.dmMeta : {};

  const recipientsIn = Array.isArray(parsed?.recipients) ? parsed.recipients : [];
  if (!recipientsIn.length) throw new Error("Missing recipients");

  const recipients = recipientsIn
    .map((r) => {
      const pubkey = normalizePubkeyHex(r?.pubkey);
      const seal = r?.seal;
      if (!pubkey) throw new Error("Invalid recipient pubkey");
      if (!seal || seal.kind !== 13) throw new Error("Invalid recipient seal");
      if (seal.pubkey !== requesterPubkey) throw new Error("Recipient seal pubkey mismatch");
      if ((Array.isArray(seal.tags) ? seal.tags : []).length) throw new Error("Recipient seal tags must be empty");
      return { pubkey, seal };
    })
    .filter(Boolean);

  const senderSeal = parsed?.senderCopy?.seal;
  if (!senderSeal || senderSeal.kind !== 13) throw new Error("Missing senderCopy seal");
  if (senderSeal.pubkey !== requesterPubkey) throw new Error("SenderCopy seal pubkey mismatch");
  if ((Array.isArray(senderSeal.tags) ? senderSeal.tags : []).length) throw new Error("SenderCopy seal tags must be empty");

  const previewKeyCapsules =
    parsed?.previewKeyCapsules && typeof parsed.previewKeyCapsules === "object" ? parsed.previewKeyCapsules : null;

  return {
    id: event.id,
    requesterPubkey,
    scheduledAt,
    dmEnc,
    pkvId,
    dmMeta,
    recipients,
    senderCopySeal: senderSeal,
    previewKeyCapsules,
    cap
  };
}

async function parseDmRetryRequest({ event, requesterPubkey }) {
  if (event.kind !== DM_RETRY_KIND) {
    throw new Error(`Invalid DM retry kind ${event.kind}`);
  }
  if (!requesterPubkey) throw new Error("Missing requester pubkey");
  const { dmKey } = deriveMailboxSecrets(requesterPubkey);
  const decrypted = nip44.v2.decrypt(String(event.content || ""), new Uint8Array(dmKey));
  const parsed = JSON.parse(decrypted || "{}");

  const outerPTags = (Array.isArray(event.tags) ? event.tags : [])
    .filter((t) => Array.isArray(t) && t[0] === "p")
    .map((t) => t[1]);
  if (!outerPTags.includes(DVM_PUBKEY)) throw new Error("Request not addressed to this DVM");

  const jobId = String(parsed?.jobId || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(jobId)) throw new Error("Invalid jobId");
  return { jobId };
}

async function parseMailboxRepairRequest({ event, requesterPubkey }) {
  if (event.kind !== MAILBOX_REPAIR_KIND) {
    throw new Error(`Invalid mailbox repair kind ${event.kind}`);
  }
  if (!requesterPubkey) throw new Error("Missing requester pubkey");
  const { submitKey } = deriveMailboxSecrets(requesterPubkey);
  const decrypted = nip44.v2.decrypt(String(event.content || ""), new Uint8Array(submitKey));
  const parsed = JSON.parse(decrypted || "{}");

  const outerPTags = (Array.isArray(event.tags) ? event.tags : [])
    .filter((t) => Array.isArray(t) && t[0] === "p")
    .map((t) => t[1]);
  if (!outerPTags.includes(DVM_PUBKEY)) throw new Error("Request not addressed to this DVM");

  const scope = String(parsed?.scope || "").trim() || "queue";
  if (scope !== "queue" && scope !== "full") throw new Error("Invalid repair scope");
  return { scope };
}

async function parseSupportActionRequest({ event, requesterPubkey }) {
  if (event.kind !== SUPPORT_ACTION_KIND) {
    throw new Error(`Invalid support action kind ${event.kind}`);
  }
  if (!requesterPubkey) throw new Error("Missing requester pubkey");
  const { submitKey } = deriveMailboxSecrets(requesterPubkey);
  const decrypted = nip44.v2.decrypt(String(event.content || ""), new Uint8Array(submitKey));
  const parsed = JSON.parse(decrypted || "{}");

  const outerPTags = (Array.isArray(event.tags) ? event.tags : [])
    .filter((t) => Array.isArray(t) && t[0] === "p")
    .map((t) => t[1]);
  if (!outerPTags.includes(DVM_PUBKEY)) throw new Error("Request not addressed to this DVM");

  const action = String(parsed?.action || "").trim().toLowerCase();
  if (!["use_free", "maybe_later", "support", "check_invoice"].includes(action)) {
    throw new Error("Invalid support action");
  }
  const promptId = String(parsed?.promptId || "").trim();
  const source = String(parsed?.source || "").trim();
  const invoiceId = String(parsed?.invoiceId || parsed?.invoice_id || "").trim();
  const sats = Math.max(0, Math.floor(Number(parsed?.sats) || 0));
  return { action, promptId, source, invoiceId, sats };
}

async function scheduleDmJob({ signer, parsed }) {
  const policy = getSupportPolicy();
  enforceSupportGates({
    pubkey: parsed.requesterPubkey,
    scheduledAt: parsed.scheduledAt,
    feature: DM_JOB_TYPE,
    cap: parsed?.cap,
    policy
  });

  const delay = Math.max(0, ms(parsed.scheduledAt - now()));

  // Persist preview key capsules (opaque to DVM) so mailbox index can carry them.
  if (parsed.previewKeyCapsules) {
    try {
      upsertPreviewKeyCapsules(parsed.requesterPubkey, parsed.previewKeyCapsules);
    } catch {}
  }

  const jobPayload = {
    type: DM_JOB_TYPE,
    v: 1,
    scheduledAt: parsed.scheduledAt,
    dm: {
      pkv_id: parsed.pkvId,
      dmEnc: parsed.dmEnc,
      meta: parsed.dmMeta
    },
    recipients: parsed.recipients.map((r) => ({
      pubkey: r.pubkey,
      seal: r.seal,
      wrap: null,
      status: "pending",
      lastError: "",
      relaysUsed: [],
      attemptedRelays: []
    })),
    senderCopy: {
      pubkey: parsed.requesterPubkey,
      seal: parsed.senderCopySeal,
      wrap: null,
      status: "pending",
      lastError: "",
      relaysUsed: [],
      attemptedRelays: []
    }
  };

  upsertJob({
    id: parsed.id,
    requesterPubkey: parsed.requesterPubkey,
    dvmPubkey: await signer.getPubkey(),
    relays: [],
    payload: jobPayload,
    noteId: "",
    scheduledAt: parsed.scheduledAt,
    createdAt: now(),
    status: "scheduled"
  });

  recordJobHistory(parsed.id, "scheduled", `dm delay ${delay}ms`);
  if (!jobScheduler) throw new Error("Scheduler not initialized");
  jobScheduler.schedule(parsed.id, parsed.scheduledAt);
  bumpSupportScheduleCount(parsed.requesterPubkey, policy);
  queueMailboxPublish(parsed.requesterPubkey);
  console.log(`[dvm] Scheduled DM ${parsed.id} for ${parsed.scheduledAt} (${delay}ms)`);
}

async function publishDmJob({ signer, jobId }) {
  if (shuttingDown) return;
  if (inFlightPublishes.has(jobId)) return inFlightPublishes.get(jobId);

  const run = (async () => {
    const job = getJobById(jobId);
    if (!job) return;
    const payload = job.payload || {};
    if (payload.type !== DM_JOB_TYPE) return;
    if (job.status === "canceled" || job.status === "cancelled") return;

    const recipients = Array.isArray(payload.recipients) ? payload.recipients : [];
    const senderCopy = payload.senderCopy || null;
    if (!recipients.length || !senderCopy?.seal) {
      updateJob(jobId, { status: "error", lastError: "Invalid dm17 payload structure" });
      queueMailboxPublish(job.requesterPubkey);
      return;
    }

    // 1) Generate and persist gift wraps (idempotency key) before publishing.
    let mutated = false;
    for (const r of recipients) {
      if (!r?.wrap && r?.seal) {
        r.wrap = buildDmGiftWrap({ targetPubkey: r.pubkey, seal: r.seal });
        r.wrapId = r.wrap?.id || "";
        mutated = true;
      }
    }
    if (!senderCopy.wrap && senderCopy.seal) {
      senderCopy.wrap = buildDmGiftWrap({ targetPubkey: senderCopy.pubkey, seal: senderCopy.seal });
      senderCopy.wrapId = senderCopy.wrap?.id || "";
      mutated = true;
    }
    if (mutated) {
      updateJob(jobId, { payload });
    }

    // 2) Publish to kind:10050 relays per target.
    const publishTarget = async (targetPubkey, entry) => {
      if (!entry?.wrap) {
        entry.status = "error";
        entry.lastError = "Missing gift wrap event";
        return;
      }
      if (entry.status === "sent") return;

      const relays = await fetchPreferredDmRelays(targetPubkey);
      entry.attemptedRelays = relays;
      entry.relaysUsed = [];

      if (!relays.length) {
        entry.status = "error";
        entry.lastError = "No kind:10050 inbox relays found";
        return;
      }

      const result = await publish({ relays, event: entry.wrap });
      const ok = Object.values(result || {}).filter((r) => r?.status === PublishStatus.Success).map((r) => r.relay);
      entry.relaysUsed = ok;
      entry.resultSummary = summarizePublishResults(result);
      if (ok.length) {
        entry.status = "sent";
        entry.lastError = "";
      } else {
        entry.status = "error";
        entry.lastError = entry.resultSummary || "All inbox relays rejected";
      }
    };

    for (const r of recipients) {
      // eslint-disable-next-line no-await-in-loop
      await publishTarget(r.pubkey, r);
    }
    const allRecipientsSent = recipients.every((r) => r?.status === "sent");
    if (allRecipientsSent) {
      await publishTarget(senderCopy.pubkey, senderCopy);
    }

    // 3) Persist per-target statuses + compute job status.
    if (allRecipientsSent) {
      updateJob(jobId, { payload, status: "sent", lastError: "" });
      recordJobHistory(jobId, "sent", "");
      try {
        deleteJob(jobId);
      } catch {}
      queueMailboxPublish(job.requesterPubkey);
      return;
    }

    const lastError = recipients
      .filter((r) => r?.status !== "sent")
      .map((r) => `${r.pubkey.slice(0, 8)}…:${r.lastError || "error"}`)
      .filter(identity)
      .join(" | ");

    updateJob(jobId, { payload, status: "error", lastError });
    recordJobHistory(jobId, "error", lastError);
    queueMailboxPublish(job.requesterPubkey);
  })();

  inFlightPublishes.set(jobId, run);
  try {
    return await run;
  } finally {
    inFlightPublishes.delete(jobId);
  }
}

async function handleMasterRequest({ signer, requesterPubkey, dvmRelays }) {
  const userPubkey = requesterPubkey;
  const ts = now();
  const lastTs = masterPublishThrottle.get(userPubkey) || 0;
  if (ts - lastTs < 30) {
    vLog("[dvm] Skipping master publish (throttled) for", userPubkey.slice(0, 8));
    return;
  }
  await publishMasterEvent({ signer, userPubkey, relays: uniq(dvmRelays) });
  masterPublishThrottle.set(userPubkey, ts);
}

function unwrapGiftWrap(wrap) {
  if (!wrap?.pubkey || !wrap?.content) throw new Error("Invalid gift wrap");

  const decryptFromPeer = (peerPubkey, cipherText, { cache = true } = {}) => {
    const ct = String(cipherText || "");
    const peer = String(peerPubkey || "").trim();
    if (!peer || !ct) throw new Error("Missing nip44 fields");
    try {
      const useCache = Boolean(cache) && /^[a-f0-9]{64}$/i.test(peer);
      const k2 = useCache
        ? nip44ConversationKeyCache.get(peer) || nip44ConversationKeyCache.set(peer, nip44.v2.utils.getConversationKey(DVM_SK_BYTES, peer))
        : nip44.v2.utils.getConversationKey(DVM_SK_BYTES, peer);
      return nip44.v2.decrypt(ct, k2);
    } catch (err) {
      throw err;
    }
  };

  // Decrypt gift wrap -> seal (kind 13)
  const sealJson = decryptFromPeer(wrap.pubkey, wrap.content, { cache: false });
  const seal = JSON.parse(sealJson);
  if (seal.kind !== 13 || (Array.isArray(seal.tags) && seal.tags.length)) {
    throw new Error("Invalid seal");
  }
  if (!seal.pubkey || !seal.content) throw new Error("Seal missing fields");

  // Decrypt seal -> rumor (kind 5901 or 5905)
  const rumorJson = decryptFromPeer(seal.pubkey, seal.content, { cache: true });
  const rumor = JSON.parse(rumorJson);
  if (!rumor?.kind) throw new Error("Invalid rumor");
  return { seal, rumor };
}

async function handleRequest({ signer, event, dvmRelays }) {
  try {
    if (event.kind !== GIFT_WRAP_KIND) return;
    const { seal, rumor } = unwrapGiftWrap(event);
    const requesterPubkey = seal.pubkey;
    vLog(
      `[dvm] Handling wrapped request ${rumor.id} from ${requesterPubkey} kind=${rumor.kind} created_at=${rumor.created_at} (wrap ${event.id})`
    );
    if (rumor.kind === MASTER_REQUEST_KIND) {
      const outerPTags = (Array.isArray(rumor.tags) ? rumor.tags : [])
        .filter((t) => Array.isArray(t) && t[0] === "p")
        .map((t) => t[1]);
      if (!outerPTags.includes(DVM_PUBKEY)) throw new Error("Master request not addressed to this DVM");
      await handleMasterRequest({ signer, requesterPubkey, dvmRelays });
      return;
    }
    if (rumor.kind === DVM_REQUEST_PUBLISH_SCHEDULE) {
      const existing = getJobById(rumor.id);
      if (existing) {
        vLog(`[dvm] Skipping duplicate request ${rumor.id} (status=${existing.status})`);
        return;
      }
      const payload = await parseRequest({ event: rumor, dvmRelays, requesterPubkey });
      await schedulePayload({ signer, payload });
      return;
    }
    if (rumor.kind === DM_REQUEST_KIND) {
      const existing = getJobById(rumor.id);
      if (existing) {
        vLog(`[dvm] Skipping duplicate request ${rumor.id} (status=${existing.status})`);
        return;
      }
      const parsed = await parseDmRequest({ event: rumor, requesterPubkey });
      await scheduleDmJob({ signer, parsed });
      return;
    }
    if (rumor.kind === SUPPORT_ACTION_KIND) {
      const parsed = await parseSupportActionRequest({ event: rumor, requesterPubkey });
      const policy = getSupportPolicy();
      const pk = String(requesterPubkey || "").trim();
      if (pk) {
        if (parsed.action === "use_free") {
          mutateSupportState(pk, (s) => supportApplyUseFree(s, policy));
        } else if (parsed.action === "maybe_later") {
          mutateSupportState(pk, (s) => supportApplyMaybeLater(s, policy));
        } else if (parsed.action === "support") {
          mutateSupportState(pk, (s) => supportApplySupportClick(s, policy));
          try {
            await ensureSupportInvoice({ pubkey: pk, policy, sats: parsed.sats });
          } catch (err) {
            console.warn(`[support] failed to create invoice for ${pk.slice(0, 8)}…`, err?.message || err);
          }
        } else if (parsed.action === "check_invoice") {
          try {
            await checkSupportInvoice({ pubkey: pk, invoiceId: parsed.invoiceId, policy, force: true });
          } catch (err) {
            console.warn(`[support] failed to verify invoice for ${pk.slice(0, 8)}…`, err?.message || err);
          }
        }
        queueMailboxPublish(pk);
      }
      return;
    }
    if (rumor.kind === DM_RETRY_KIND) {
      const parsed = await parseDmRetryRequest({ event: rumor, requesterPubkey });
      const job = getJobById(parsed.jobId);
      if (!job) throw new Error("Job not found");
      if (job.requesterPubkey && requesterPubkey && job.requesterPubkey !== requesterPubkey) {
        throw new Error("Not authorized to retry this job");
      }
      await publishDmJob({ signer, jobId: parsed.jobId });
      return;
    }
    if (rumor.kind === MAILBOX_REPAIR_KIND) {
      const parsed = await parseMailboxRepairRequest({ event: rumor, requesterPubkey });
      repairMailbox(requesterPubkey, { scope: parsed.scope }).catch((err) => {
        console.warn(
          `[dvm] Mailbox repair failed for ${requesterPubkey?.slice?.(0, 8) || requesterPubkey}:`,
          err?.message || err
        );
      });
      vLog(`[dvm] Mailbox repair queued for ${requesterPubkey.slice(0, 8)}… scope=${parsed.scope}`);
      return;
    }
  } catch (err) {
    console.warn(
      `[dvm] Failed to handle request ${event?.id || "unknown"}:`,
      err?.message || err
    );
  }
}

async function handleDelete({ id, signer, dvmRelays }) {
  if (jobScheduler) jobScheduler.cancel(id);
  const updatedJob = markJobStatus(id, "canceled");
  recordJobHistory(id, "canceled");
  if (updatedJob) {
    const note = updatedJob.payload?.event || {};
    notifyJobUpdate(updatedJob.requesterPubkey, {
      id: updatedJob.id,
      status: updatedJob.status,
      noteId: updatedJob.noteId,
      scheduledAt: updatedJob.scheduledAt,
      createdAt: updatedJob.createdAt,
      updatedAt: updatedJob.updatedAt,
      relays: updatedJob.relays,
      content: note.content || "",
      tags: note.tags || [],
      lastError: updatedJob.lastError || ""
    });
    queueMailboxPublish(updatedJob.requesterPubkey);
  }
  console.log(`[dvm] Canceled job ${id} via delete`);
}

async function listenForDeletes({ dvmRelays, signer }) {
  const dvmPubkey = await signer.getPubkey();
  vLog("[dvm] Listening for cancel events (kind 5) for", dvmPubkey);
  await request({
    relays: dvmRelays,
    filters: [{ kinds: [5], "#p": [dvmPubkey], since: computeBackfillSince() }],
    onEvent: async (event) => {
      const targets = event.tags.filter((t) => t[0] === "e").map((t) => t[1]);
      const hits = [];
      for (const id of targets) {
        if (!id) continue;
        // Cancel scheduled jobs fast-path.
        if (jobScheduler?.has(id)) {
          hits.push(id);
          continue;
        }
        // Allow canceling persisted jobs (e.g. DM terminal visibility) but require ownership.
        const job = getJobById(id);
        if (!job) continue;
        if (job.requesterPubkey && event.pubkey && job.requesterPubkey !== event.pubkey) continue;
        hits.push(id);
      }
      if (!hits.length) return;
      vLog("[dvm] Received delete", event.id, "targets", hits);
      for (const id of hits) {
        // eslint-disable-next-line no-await-in-loop
        await handleDelete({ id, signer, dvmRelays });
      }
    }
  });
}

async function restoreSaved({ signer }) {
  const pending = listPendingJobs();
  if (!pending.length) {
    vLog("[dvm] No pending jobs to restore.");
    return;
  }
  vLog(`[dvm] Restoring ${pending.length} pending jobs from db...`);
  if (!jobScheduler) throw new Error("Scheduler not initialized");
  const pubkeys = new Set();
  for (const job of pending) {
    const delay = Math.max(0, ms(job.scheduledAt - now()));
    jobScheduler.schedule(job.id, job.scheduledAt);
    vLog(`[dvm] Re-queued ${job.id} for ${job.scheduledAt} (delay ${delay}ms)`);
    if (job.requesterPubkey) pubkeys.add(job.requesterPubkey);
  }
  pubkeys.forEach((pk) => queueMailboxPublish(pk));
}

async function publishMetadata({ signer, dvmRelays, indexerRelays }) {
  const settingsKey = "pidgeon.dvm.metadataHash.v1";
  const relays = uniq([...indexerRelays, ...dvmRelays]);

  const meta = {
    name: DVM_NAME,
    about: DVM_ABOUT,
    picture: DVM_PICTURE
  };
  const metaHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        ...meta,
        dvmRelays: uniq(dvmRelays),
        indexerRelays: uniq(indexerRelays),
        kinds: [
          String(DVM_REQUEST_PUBLISH_SCHEDULE),
          String(DM_REQUEST_KIND),
          String(DM_RETRY_KIND),
          String(MAILBOX_REPAIR_KIND),
          String(SUPPORT_ACTION_KIND)
        ]
      })
    )
    .digest("hex");

  try {
    const existing = getSettings(DVM_PUBKEY || "");
    if (existing?.[settingsKey] && String(existing[settingsKey]) === metaHash) {
      vLog("[dvm] Metadata unchanged; skipping publish");
      return;
    }
  } catch {
    // ignore caching failures; fall back to publishing
  }

  await publish({
    relays,
    event: await signer.sign(makeEvent(RELAYS, { tags: dvmRelays.map((r) => ["r", r]) }))
  });

  await publish({
    relays,
    event: await signer.sign(
      makeEvent(PROFILE, {
        content: JSON.stringify(meta)
      })
    )
  });

  await publish({
    relays,
    event: await signer.sign(
      makeEvent(HANDLER_INFORMATION, {
        content: JSON.stringify(meta),
        tags: [
          ["d", "pidgeon-dvm"],
          ["k", String(DVM_REQUEST_PUBLISH_SCHEDULE)],
          ["k", String(DM_REQUEST_KIND)],
          ["k", String(DM_RETRY_KIND)],
          ["k", String(MAILBOX_REPAIR_KIND)],
          ["k", String(SUPPORT_ACTION_KIND)]
        ]
      })
    )
  });

  try {
    saveSettings(DVM_PUBKEY || "", { [settingsKey]: metaHash });
  } catch {
    // ignore
  }
}

async function listenForRequests({ signer, dvmRelays }) {
  const targetRelays = uniq(dvmRelays);
  console.log(`[dvm] Listening on ${targetRelays.map(displayRelayUrl).join(", ")}`);
  await request({
    relays: targetRelays,
    filters: [
      { kinds: [GIFT_WRAP_KIND], "#p": [await signer.getPubkey()], since: computeBackfillSince() }
    ],
    onEvent: (event) => {
      vLog(
        `[dvm] Received request ${event.id} kind=${event.kind} created_at=${event.created_at} from ${event.pubkey}`
      );
      const ok = requestWorkQueue.push(() => handleRequest({ signer, event, dvmRelays }), event?.id || "");
      if (!ok) {
        const st = requestWorkQueue.stats();
        console.warn(
          `[dvm] Dropping request ${event?.id || "unknown"} (queue full active=${st.active} queued=${st.queued} cap=${st.cap})`
        );
      }
    },
    onError: (err) => {
      console.warn("[dvm] listenForRequests error", err?.message || err);
    }
  });
}

async function publishMasterEvent({ signer, userPubkey, relays }) {
  const { rootKey, mb, version } = deriveMailboxSecrets(userPubkey);
  const payload = {
    t: "pidgeon-job-master",
    v: version,
    kr: bytesToB64u(rootKey),
    mb,
    relays
  };
  const created_at = now();
  const rumor = {
    kind: MASTER_KIND,
    created_at,
    content: JSON.stringify(payload),
    tags: [
      ["p", userPubkey],
      ["k", String(version)],
      ["d", `job-master:${DVM_PUBKEY}`]
    ],
    pubkey: DVM_PUBKEY
  };
  rumor.id = getEventHash(rumor);

  const makeWrapped = ({ ts }) => {
    const rumorJson = JSON.stringify(rumor);
    const sealContent = nip44.v2.encrypt(rumorJson, nip44.v2.utils.getConversationKey(DVM_SK_BYTES, userPubkey));
    const seal = finalizeEvent({ kind: 13, created_at: ts, tags: [], content: sealContent }, DVM_SK_BYTES);

    const ephemeralSk = generateSecretKey();
    const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, userPubkey);
    const wrapPayload = `${AMBER_NIP46_COMPAT_PREFIX}${JSON.stringify(seal)}`;
    const wrapContent = nip44.v2.encrypt(wrapPayload, wrapKey);
    return finalizeEvent(
      { kind: GIFT_WRAP_KIND, created_at: ts, tags: [["p", userPubkey], ["t", "pidgeon-master-v3"]], content: wrapContent },
      ephemeralSk
    );
  };

  const wrapped = makeWrapped({ ts: created_at });
  await publish({ relays, event: wrapped });
  vLog(`[dvm] Published master key wrap for ${userPubkey.slice(0, 8)}...`);
}

call(async function main() {
  let cfg;
  try {
    cfg = resolveConfig(process.argv.slice(2));
  } catch (err) {
    usage(err?.message || String(err || "Invalid configuration"));
    process.exit(1);
  }

  DVM_NAME = cfg.name;
  DVM_ABOUT = cfg.about;
  DVM_PICTURE = cfg.picture;
  LOADTEST_MODE = Boolean(cfg.loadtest);

  DVM_SK_HEX = resolveSecret(cfg.secret);
  DVM_SK_BYTES = hexToBytes(DVM_SK_HEX);
  const signer = Nip01Signer.fromSecret(DVM_SK_HEX);
  const dvmRelays = cfg.dvmRelays;
  const publishRelays = cfg.publishRelays;
  const indexerRelays = cfg.indexerRelays;
  DVM_RELAYS = uniq(dvmRelays);
  DVM_PUBLISH_RELAYS = uniq(publishRelays.length ? publishRelays : dvmRelays);
  INDEXER_RELAYS = uniq(indexerRelays);

  DVM_PUBKEY = await signer.getPubkey();
  console.log(`[dvm] Pubkey ${DVM_PUBKEY}`);
  console.log(
    `[dvm] Relays listen=${DVM_RELAYS.map(displayRelayUrl).join(", ")} publish=${DVM_PUBLISH_RELAYS.map(displayRelayUrl).join(", ")} indexer=${INDEXER_RELAYS.map(displayRelayUrl).join(", ")} loadtest=${LOADTEST_MODE ? "1" : "0"}`
  );

  const mailboxRelays = await filterMailboxRelaysByDIndexing({ signer, relays: dvmRelays });
  initMailboxPublisher({ dvmSkHex: DVM_SK_HEX, relays: mailboxRelays });

  jobScheduler = createScheduler({
    name: "jobs",
    onDue: (jobId) => {
      if (shuttingDown) return;
      const job = getJobById(jobId);
      if (!job) return;
      if (job.status !== "scheduled") return;
      const payload = job.payload || {};
      if (payload?.type === DM_JOB_TYPE) {
        publishDmJob({ signer, jobId });
      } else {
        publishPayload({ signer, payload });
      }
    }
  });

  // Optional: poll pending LNURL-verify invoices and upgrade users to supporters when settled.
  try {
    const supportPolicy = getSupportPolicy();
    const payCfg = getSupportPaymentConfig(supportPolicy);
    if (payCfg.mode === "lnurl_verify" && payCfg.verifyPollSec > 0) {
      const intervalMs = payCfg.verifyPollSec * 1000;
      const tick = () =>
        pollSupportInvoicesOnce({ policy: supportPolicy }).catch((err) => {
          console.warn("[support] invoice poll failed:", err?.message || err);
        });
      tick();
      supportVerifyTimer = setInterval(tick, intervalMs);
      supportVerifyTimer.unref?.();
      vLog(`[support] LNURL-verify polling enabled (every ${payCfg.verifyPollSec}s)`);
    }
  } catch (err) {
    console.warn("[support] failed to start invoice poller:", err?.message || err);
  }

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[dvm] Shutdown requested (${signal})`);
    try {
      jobScheduler?.stop();
    } catch {}
    try {
      if (supportVerifyTimer) clearInterval(supportVerifyTimer);
    } catch {}

    // Wait briefly for any in-flight publishes to complete.
    const inflight = Array.from(inFlightPublishes.values());
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise((resolve) => setTimeout(resolve, 8000))
    ]);

    // Flush mailbox debounced updates so clients see the latest job state.
    await Promise.race([
      flushAllMailboxes(),
      new Promise((resolve) => setTimeout(resolve, 8000))
    ]);

    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await publishMetadata({ signer, dvmRelays, indexerRelays });
  listenForRequests({ signer, dvmRelays });
  listenForDeletes({ signer, dvmRelays });
  restoreSaved({ signer });
});
