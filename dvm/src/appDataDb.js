// DVM app data persistence (mailbox meta/pages, analytics cache, etc).
import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";

const DB_DIR = process.env.DATA_DIR || "data";
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "app.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000)}`);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  pubkey TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (pubkey, key)
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  url TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  imeta TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_pubkey ON uploads(pubkey);

CREATE TABLE IF NOT EXISTS analytics_cache (
  noteId TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0,
  zaps INTEGER NOT NULL DEFAULT 0,
  zapMsat INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  fetchedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_meta (
  noteId TEXT PRIMARY KEY,
  requesterPubkey TEXT NOT NULL,
  kind INTEGER NOT NULL,
  contentHash TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

	CREATE TABLE IF NOT EXISTS job_history (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  jobId TEXT NOT NULL,
	  status TEXT NOT NULL,
	  info TEXT NOT NULL DEFAULT '',
	  createdAt INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_job_history_job ON job_history(jobId);

	CREATE TABLE IF NOT EXISTS mailbox_meta (
	  pubkey TEXT PRIMARY KEY,
	  rev INTEGER NOT NULL DEFAULT 0,
	  lastCreatedAtByDTagJson TEXT NOT NULL DEFAULT '{}',
  previewKeyCapsulesJson TEXT NOT NULL DEFAULT '{}',
  publishedRev INTEGER NOT NULL DEFAULT 0,
  publishedRelaysKey TEXT NOT NULL DEFAULT '',
  publishedHash TEXT NOT NULL DEFAULT '',
	  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_pages (
  pubkey TEXT NOT NULL,
  bucket TEXT NOT NULL,
  page INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (pubkey, bucket, page)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_pages_pubkey_bucket ON mailbox_pages(pubkey, bucket);

CREATE TABLE IF NOT EXISTS mailbox_blobs (
  pubkey TEXT NOT NULL,
  noteId TEXT NOT NULL,
  parts INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (pubkey, noteId)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_blobs_pubkey ON mailbox_blobs(pubkey);

CREATE TABLE IF NOT EXISTS support_state (
  pubkey TEXT PRIMARY KEY,
  scheduleCount INTEGER NOT NULL DEFAULT 0,
  freeUntilCount INTEGER NOT NULL DEFAULT 0,
  nextPromptAtCount INTEGER NOT NULL DEFAULT 0,
  supporterUntil INTEGER NOT NULL DEFAULT 0,
  gatePromptJson TEXT NOT NULL DEFAULT '',
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS support_invoices (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  pr TEXT NOT NULL,
  verifyUrl TEXT NOT NULL,
  sats INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL DEFAULT 0,
  settledAt INTEGER NOT NULL DEFAULT 0,
  preimage TEXT NOT NULL DEFAULT '',
  lastCheckAt INTEGER NOT NULL DEFAULT 0,
  lastError TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_support_invoices_pubkey_createdAt ON support_invoices(pubkey, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_support_invoices_status ON support_invoices(status);
`);

try {
  // Migration for existing installs.
  db.prepare(`ALTER TABLE mailbox_meta ADD COLUMN previewKeyCapsulesJson TEXT NOT NULL DEFAULT '{}'`).run();
} catch {
  // ignore (already migrated)
}

try {
  // Migration for existing installs.
  db.prepare(`ALTER TABLE mailbox_meta ADD COLUMN publishedRev INTEGER NOT NULL DEFAULT 0`).run();
} catch {
  // ignore (already migrated)
}

try {
  // Migration for existing installs.
  db.prepare(`ALTER TABLE mailbox_meta ADD COLUMN publishedRelaysKey TEXT NOT NULL DEFAULT ''`).run();
} catch {
  // ignore (already migrated)
}

try {
  // Migration for existing installs.
  db.prepare(`ALTER TABLE mailbox_meta ADD COLUMN publishedHash TEXT NOT NULL DEFAULT ''`).run();
} catch {
  // ignore (already migrated)
}

try {
  // Migration for existing installs.
  db.prepare(`ALTER TABLE mailbox_pages ADD COLUMN hash TEXT NOT NULL DEFAULT ''`).run();
} catch {
  // ignore (already migrated)
}

const nowTs = () => Math.floor(Date.now() / 1000);
const clamp0 = (n) => Math.max(0, Math.floor(Number(n) || 0));

// Settings
export function getSettings(pubkey) {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE pubkey=?`).all(pubkey);
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  return obj;
}
export function saveSettings(pubkey, data = {}) {
  const ts = nowTs();
  const entries = Object.entries(data || {});
  const stmt = db.prepare(
    `INSERT INTO settings (pubkey, key, value, updatedAt)
     VALUES (@pubkey, @key, @value, @ts)
     ON CONFLICT(pubkey, key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt`
  );
  const tx = db.transaction((rows) => rows.forEach((r) => stmt.run(r)));
  tx(entries.map(([key, value]) => ({ pubkey, key, value: String(value), ts })));
  return getSettings(pubkey);
}

// Uploads
export function recordUpload({ id, pubkey, url, tags = [], imeta = [] }) {
  const ts = nowTs();
  db.prepare(
    `INSERT INTO uploads (id, pubkey, url, tags, imeta, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET url=excluded.url, tags=excluded.tags, imeta=excluded.imeta`
  ).run(id, pubkey, url, JSON.stringify(tags), JSON.stringify(imeta), ts);
  return { id, pubkey, url, tags, imeta, createdAt: ts };
}
export function listUploads(pubkey) {
  const rows = db.prepare(`SELECT * FROM uploads WHERE pubkey=? ORDER BY createdAt DESC`).all(pubkey);
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || "[]"), imeta: JSON.parse(r.imeta || "[]") }));
}

// Analytics cache
export function getAnalytics(noteId) {
  return db.prepare(`SELECT * FROM analytics_cache WHERE noteId=?`).get(noteId) || null;
}
export function upsertAnalytics({ noteId, likes = 0, zaps = 0, zapMsat = 0, replies = 0 }) {
  const ts = nowTs();
  db.prepare(
    `INSERT INTO analytics_cache (noteId, likes, zaps, zapMsat, replies, fetchedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(noteId) DO UPDATE SET likes=excluded.likes, zaps=excluded.zaps, zapMsat=excluded.zapMsat, replies=excluded.replies, fetchedAt=excluded.fetchedAt`
  ).run(noteId, likes, zaps, zapMsat, replies, ts);
  return getAnalytics(noteId);
}

// Note metadata
export function upsertNoteMeta({ noteId, requesterPubkey, kind, contentHash = "", media = [] }) {
  const ts = nowTs();
  db.prepare(
    `INSERT INTO note_meta (noteId, requesterPubkey, kind, contentHash, media, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(noteId) DO UPDATE SET contentHash=excluded.contentHash, media=excluded.media, updatedAt=excluded.updatedAt`
  ).run(noteId, requesterPubkey, kind, contentHash, JSON.stringify(media), ts, ts);
  return getNoteMeta(noteId);
}
export function getNoteMeta(noteId) {
  const row = db.prepare(`SELECT * FROM note_meta WHERE noteId=?`).get(noteId);
  if (!row) return null;
  return { ...row, media: JSON.parse(row.media || "[]") };
}

// Job history
export function recordJobHistory(jobId, status, info = "") {
  const ts = nowTs();
  db.prepare(`INSERT INTO job_history (jobId, status, info, createdAt) VALUES (?, ?, ?, ?)`).run(jobId, status, info, ts);
}
export function listJobHistory(jobId) {
  return db.prepare(`SELECT status, info, createdAt FROM job_history WHERE jobId=? ORDER BY createdAt`).all(jobId);
}

// Mailbox meta
export function getMailboxMeta(pubkey) {
  const row = db
    .prepare(
      `SELECT rev, lastCreatedAtByDTagJson, previewKeyCapsulesJson, publishedRev, publishedRelaysKey, publishedHash FROM mailbox_meta WHERE pubkey=?`
    )
    .get(pubkey);
  if (!row) {
    return {
      rev: 0,
      publishedRev: 0,
      publishedRelaysKey: "",
      publishedHash: "",
      lastCreatedAtByDTagJson: "{}",
      previewKeyCapsulesJson: "{}"
    };
  }
  return {
    rev: Number(row.rev) || 0,
    publishedRev: Number(row.publishedRev) || 0,
    publishedRelaysKey: String(row.publishedRelaysKey || ""),
    publishedHash: String(row.publishedHash || ""),
    lastCreatedAtByDTagJson: row.lastCreatedAtByDTagJson || "{}",
    previewKeyCapsulesJson: row.previewKeyCapsulesJson || "{}"
  };
}

export function upsertMailboxMeta(pubkey, { rev, publishedRev, publishedRelaysKey, publishedHash, lastCreatedAtByDTagJson, previewKeyCapsulesJson }) {
  const ts = nowTs();
  const existing = db
    .prepare(`SELECT previewKeyCapsulesJson, publishedRev, publishedRelaysKey, publishedHash FROM mailbox_meta WHERE pubkey=?`)
    .get(pubkey);
  const capsules = previewKeyCapsulesJson ?? existing?.previewKeyCapsulesJson ?? "{}";
  const nextPublishedRev = publishedRev ?? existing?.publishedRev ?? 0;
  const nextPublishedRelaysKey = publishedRelaysKey ?? existing?.publishedRelaysKey ?? "";
  const nextPublishedHash = publishedHash ?? existing?.publishedHash ?? "";
  db.prepare(
    `INSERT INTO mailbox_meta (pubkey, rev, lastCreatedAtByDTagJson, previewKeyCapsulesJson, publishedRev, publishedRelaysKey, publishedHash, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       rev=excluded.rev,
       lastCreatedAtByDTagJson=excluded.lastCreatedAtByDTagJson,
       previewKeyCapsulesJson=excluded.previewKeyCapsulesJson,
       publishedRev=excluded.publishedRev,
       publishedRelaysKey=excluded.publishedRelaysKey,
       publishedHash=excluded.publishedHash,
       updatedAt=excluded.updatedAt`
  ).run(
    pubkey,
    rev || 0,
    lastCreatedAtByDTagJson || "{}",
    capsules || "{}",
    nextPublishedRev || 0,
    String(nextPublishedRelaysKey || ""),
    String(nextPublishedHash || ""),
    ts
  );
  return getMailboxMeta(pubkey);
}

export function upsertPreviewKeyCapsules(pubkey, capsules = {}) {
  const meta = getMailboxMeta(pubkey);
  let existing = {};
  try {
    existing = JSON.parse(meta.previewKeyCapsulesJson || "{}") || {};
  } catch {
    existing = {};
  }
  const next = { ...existing, ...(capsules || {}) };
  upsertMailboxMeta(pubkey, {
    rev: meta.rev,
    lastCreatedAtByDTagJson: meta.lastCreatedAtByDTagJson,
    previewKeyCapsulesJson: JSON.stringify(next)
  });
  return next;
}

// Mailbox pages
export function listMailboxPages(pubkey) {
  return db
    .prepare(`SELECT bucket, page, count, hash, updatedAt FROM mailbox_pages WHERE pubkey=? ORDER BY bucket DESC, page ASC`)
    .all(pubkey);
}

export function getActiveMailboxPage(pubkey, bucket) {
  const row = db
    .prepare(`SELECT page, count FROM mailbox_pages WHERE pubkey=? AND bucket=? ORDER BY page DESC LIMIT 1`)
    .get(pubkey, bucket);
  if (!row) return { page: 0, count: 0 };
  return { page: Number(row.page) || 0, count: Number(row.count) || 0 };
}

export function upsertMailboxPage(pubkey, bucket, page, count, hash = "") {
  const ts = nowTs();
  db.prepare(
    `INSERT INTO mailbox_pages (pubkey, bucket, page, count, hash, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey, bucket, page) DO UPDATE SET count=excluded.count, hash=excluded.hash, updatedAt=excluded.updatedAt`
  ).run(pubkey, bucket, page, count || 0, String(hash || ""), ts);
  return { pubkey, bucket, page, count, hash: String(hash || ""), updatedAt: ts };
}

// Mailbox blobs
export function getMailboxBlob(pubkey, noteId) {
  const row = db.prepare(`SELECT pubkey, noteId, parts, bytes, hash, updatedAt FROM mailbox_blobs WHERE pubkey=? AND noteId=?`).get(pubkey, noteId);
  if (!row) return null;
  return {
    pubkey: row.pubkey,
    noteId: row.noteId,
    parts: Number(row.parts) || 0,
    bytes: Number(row.bytes) || 0,
    hash: String(row.hash || ""),
    updatedAt: Number(row.updatedAt) || 0
  };
}

export function upsertMailboxBlob(pubkey, noteId, { parts = 0, bytes = 0, hash = "" } = {}) {
  const ts = nowTs();
  db.prepare(
    `INSERT INTO mailbox_blobs (pubkey, noteId, parts, bytes, hash, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(pubkey, noteId) DO UPDATE SET parts=excluded.parts, bytes=excluded.bytes, hash=excluded.hash, updatedAt=excluded.updatedAt`
  ).run(pubkey, noteId, Number(parts) || 0, Number(bytes) || 0, String(hash || ""), ts);
  return getMailboxBlob(pubkey, noteId);
}

// Support state (gates + nudges)
export function getSupportState(pubkey) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  const row = db
    .prepare(
      `SELECT pubkey, scheduleCount, freeUntilCount, nextPromptAtCount, supporterUntil, gatePromptJson, updatedAt
       FROM support_state WHERE pubkey=?`
    )
    .get(pk);
  if (!row) {
    return {
      pubkey: pk,
      scheduleCount: 0,
      freeUntilCount: 0,
      nextPromptAtCount: 0,
      supporterUntil: 0,
      gatePrompt: null,
      updatedAt: 0
    };
  }
  let gatePrompt = null;
  try {
    const raw = String(row.gatePromptJson || "");
    if (raw) gatePrompt = JSON.parse(raw);
  } catch {
    gatePrompt = null;
  }
  return {
    pubkey: String(row.pubkey || pk),
    scheduleCount: clamp0(row.scheduleCount),
    freeUntilCount: clamp0(row.freeUntilCount),
    nextPromptAtCount: clamp0(row.nextPromptAtCount),
    supporterUntil: clamp0(row.supporterUntil),
    gatePrompt,
    updatedAt: clamp0(row.updatedAt)
  };
}

export function upsertSupportState(
  pubkey,
  { scheduleCount = 0, freeUntilCount = 0, nextPromptAtCount = 0, supporterUntil = 0, gatePrompt = null } = {}
) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  const ts = nowTs();
  const data = {
    pubkey: pk,
    scheduleCount: clamp0(scheduleCount),
    freeUntilCount: clamp0(freeUntilCount),
    nextPromptAtCount: clamp0(nextPromptAtCount),
    supporterUntil: clamp0(supporterUntil),
    gatePromptJson: gatePrompt ? JSON.stringify(gatePrompt) : "",
    updatedAt: ts
  };
  db.prepare(
    `INSERT INTO support_state (pubkey, scheduleCount, freeUntilCount, nextPromptAtCount, supporterUntil, gatePromptJson, updatedAt)
     VALUES (@pubkey, @scheduleCount, @freeUntilCount, @nextPromptAtCount, @supporterUntil, @gatePromptJson, @updatedAt)
     ON CONFLICT(pubkey) DO UPDATE SET
       scheduleCount=excluded.scheduleCount,
       freeUntilCount=excluded.freeUntilCount,
       nextPromptAtCount=excluded.nextPromptAtCount,
       supporterUntil=excluded.supporterUntil,
       gatePromptJson=excluded.gatePromptJson,
       updatedAt=excluded.updatedAt`
  ).run(data);
  return getSupportState(pk);
}

export function mutateSupportState(pubkey, mutator) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  try {
    // Prevent lost updates under concurrent requests.
    db.exec("BEGIN IMMEDIATE");
    const current = getSupportState(pk) || {
      pubkey: pk,
      scheduleCount: 0,
      freeUntilCount: 0,
      nextPromptAtCount: 0,
      supporterUntil: 0,
      gatePrompt: null,
      updatedAt: 0
    };
    const next = mutator ? mutator({ ...current }) : current;
    const out = next && typeof next === "object" ? next : current;
    const result = upsertSupportState(pk, out);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
}

// Support invoices (LNURL-verify)
function normalizeInvoiceStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (["pending", "settled", "expired", "canceled", "cancelled", "error"].includes(s)) {
    return s === "cancelled" ? "canceled" : s;
  }
  return "pending";
}

export function getSupportActiveInvoice(pubkey) {
  const pk = String(pubkey || "").trim();
  if (!pk) return null;
  const row = db
    .prepare(
      `SELECT id, pubkey, pr, sats, status, createdAt, expiresAt, settledAt, preimage, lastCheckAt, lastError
       FROM support_invoices
       WHERE pubkey=? AND status='pending'
       ORDER BY createdAt DESC
       LIMIT 1`
    )
    .get(pk);
  if (!row) return null;
  return {
    id: String(row.id || ""),
    pubkey: String(row.pubkey || pk),
    pr: String(row.pr || ""),
    sats: clamp0(row.sats),
    status: normalizeInvoiceStatus(row.status),
    createdAt: clamp0(row.createdAt),
    expiresAt: clamp0(row.expiresAt),
    settledAt: clamp0(row.settledAt),
    preimage: String(row.preimage || ""),
    lastCheckAt: clamp0(row.lastCheckAt),
    lastError: String(row.lastError || "")
  };
}

export function getSupportInvoiceById(pubkey, id) {
  const pk = String(pubkey || "").trim();
  const invoiceId = String(id || "").trim();
  if (!pk || !invoiceId) return null;
  const row = db
    .prepare(
      `SELECT id, pubkey, pr, sats, status, createdAt, expiresAt, settledAt, preimage, lastCheckAt, lastError, verifyUrl
       FROM support_invoices
       WHERE pubkey=? AND id=?
       LIMIT 1`
    )
    .get(pk, invoiceId);
  if (!row) return null;
  return {
    id: String(row.id || ""),
    pubkey: String(row.pubkey || pk),
    pr: String(row.pr || ""),
    verifyUrl: String(row.verifyUrl || ""),
    sats: clamp0(row.sats),
    status: normalizeInvoiceStatus(row.status),
    createdAt: clamp0(row.createdAt),
    expiresAt: clamp0(row.expiresAt),
    settledAt: clamp0(row.settledAt),
    preimage: String(row.preimage || ""),
    lastCheckAt: clamp0(row.lastCheckAt),
    lastError: String(row.lastError || "")
  };
}

export function listPendingSupportInvoices({ limit = 50, olderThanSec = 0 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 500));
  const olderThan = clamp0(olderThanSec);
  const where = olderThan > 0 ? `AND (lastCheckAt IS NULL OR lastCheckAt <= ?)` : "";
  const rows = db
    .prepare(
      `SELECT id, pubkey, pr, verifyUrl, sats, createdAt, expiresAt, lastCheckAt, lastError
       FROM support_invoices
       WHERE status='pending' ${where}
       ORDER BY createdAt DESC
       LIMIT ${max}`
    )
    .all(...(olderThan > 0 ? [olderThan] : []));
  return (rows || []).map((row) => ({
    id: String(row.id || ""),
    pubkey: String(row.pubkey || ""),
    pr: String(row.pr || ""),
    verifyUrl: String(row.verifyUrl || ""),
    sats: clamp0(row.sats),
    createdAt: clamp0(row.createdAt),
    expiresAt: clamp0(row.expiresAt),
    lastCheckAt: clamp0(row.lastCheckAt),
    lastError: String(row.lastError || "")
  }));
}

export function cancelPendingSupportInvoices(pubkey) {
  const pk = String(pubkey || "").trim();
  if (!pk) return 0;
  const res = db
    .prepare(
      `UPDATE support_invoices
       SET status='canceled', lastError=''
       WHERE pubkey=? AND status='pending'`
    )
    .run(pk);
  return Number(res.changes) || 0;
}

export function insertSupportInvoice({
  id,
  pubkey,
  pr,
  verifyUrl,
  sats = 0,
  status = "pending",
  createdAt,
  expiresAt = 0
} = {}) {
  const invoiceId = String(id || "").trim();
  const pk = String(pubkey || "").trim();
  if (!invoiceId || !pk) return null;
  const row = {
    id: invoiceId,
    pubkey: pk,
    pr: String(pr || ""),
    verifyUrl: String(verifyUrl || ""),
    sats: clamp0(sats),
    status: normalizeInvoiceStatus(status),
    createdAt: clamp0(createdAt ?? nowTs()),
    expiresAt: clamp0(expiresAt),
    settledAt: 0,
    preimage: "",
    lastCheckAt: 0,
    lastError: ""
  };
  db.prepare(
    `INSERT INTO support_invoices (id, pubkey, pr, verifyUrl, sats, status, createdAt, expiresAt, settledAt, preimage, lastCheckAt, lastError)
     VALUES (@id, @pubkey, @pr, @verifyUrl, @sats, @status, @createdAt, @expiresAt, @settledAt, @preimage, @lastCheckAt, @lastError)`
  ).run(row);
  return getSupportInvoiceById(pk, invoiceId);
}

export function updateSupportInvoice(pubkey, id, patch = {}) {
  const pk = String(pubkey || "").trim();
  const invoiceId = String(id || "").trim();
  if (!pk || !invoiceId) return null;
  const current = getSupportInvoiceById(pk, invoiceId);
  if (!current) return null;

  const next = {
    status: Object.prototype.hasOwnProperty.call(patch, "status") ? normalizeInvoiceStatus(patch.status) : current.status,
    settledAt: Object.prototype.hasOwnProperty.call(patch, "settledAt") ? clamp0(patch.settledAt) : current.settledAt,
    preimage: Object.prototype.hasOwnProperty.call(patch, "preimage") ? String(patch.preimage || "") : current.preimage,
    lastCheckAt: Object.prototype.hasOwnProperty.call(patch, "lastCheckAt") ? clamp0(patch.lastCheckAt) : current.lastCheckAt,
    lastError: Object.prototype.hasOwnProperty.call(patch, "lastError") ? String(patch.lastError || "") : current.lastError
  };

  db.prepare(
    `UPDATE support_invoices
     SET status=@status, settledAt=@settledAt, preimage=@preimage, lastCheckAt=@lastCheckAt, lastError=@lastError
     WHERE pubkey=@pubkey AND id=@id`
  ).run({ ...next, pubkey: pk, id: invoiceId });
  return getSupportInvoiceById(pk, invoiceId);
}
