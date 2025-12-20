// DVM job persistence (sqlite, WAL).
import Database from "better-sqlite3";
import { join } from "path";
import { mkdirSync } from "fs";

const DB_DIR = process.env.DATA_DIR || "data";
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "jobs.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000)}`);

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  requesterPubkey TEXT NOT NULL,
  dvmPubkey TEXT NOT NULL,
  relays TEXT NOT NULL,
  payload TEXT NOT NULL,
  noteId TEXT NOT NULL,
  scheduledAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  lastError TEXT DEFAULT '',
  updatedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_time ON jobs(status, scheduledAt);
CREATE INDEX IF NOT EXISTS idx_jobs_pubkey_updated ON jobs(requesterPubkey, updatedAt);
CREATE INDEX IF NOT EXISTS idx_jobs_pubkey_status_updated ON jobs(requesterPubkey, status, updatedAt);
`);

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

export function upsertJob(job) {
  const ts = nowTs();
  const data = {
    id: job.id,
    requesterPubkey: job.requesterPubkey,
    dvmPubkey: job.dvmPubkey,
    relays: JSON.stringify(job.relays || []),
    payload: JSON.stringify(job.payload || {}),
    noteId: job.noteId || "",
    scheduledAt: job.scheduledAt,
    createdAt: job.createdAt || ts,
    status: job.status || "scheduled",
    lastError: job.lastError || "",
    updatedAt: ts
  };
  db.prepare(
    `INSERT INTO jobs (id, requesterPubkey, dvmPubkey, relays, payload, noteId, scheduledAt, createdAt, status, lastError, updatedAt)
     VALUES (@id, @requesterPubkey, @dvmPubkey, @relays, @payload, @noteId, @scheduledAt, @createdAt, @status, @lastError, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       relays=excluded.relays,
       payload=excluded.payload,
       noteId=excluded.noteId,
       scheduledAt=excluded.scheduledAt,
       status=excluded.status,
       lastError=excluded.lastError,
       updatedAt=excluded.updatedAt`
  ).run(data);
  return data;
}

export function listPendingJobs() {
  const rows = db.prepare(`SELECT * FROM jobs WHERE status='scheduled' ORDER BY scheduledAt ASC`).all();
  return rows.map((r) => ({
    ...r,
    relays: JSON.parse(r.relays || "[]"),
    payload: JSON.parse(r.payload || "{}")
  }));
}

export function listJobsForPubkey(pubkey, limit = 200) {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE requesterPubkey=? ORDER BY updatedAt DESC LIMIT ?`
    )
    .all(pubkey, limit);
  return rows.map((r) => ({
    ...r,
    relays: JSON.parse(r.relays || "[]"),
    payload: JSON.parse(r.payload || "{}")
  }));
}

export function listTerminalJobsForPubkey(pubkey) {
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE requesterPubkey=? AND status IN ('sent','error','canceled','cancelled') ORDER BY updatedAt DESC`
    )
    .all(pubkey);
  return rows.map((r) => ({
    ...r,
    relays: JSON.parse(r.relays || "[]"),
    payload: JSON.parse(r.payload || "{}")
  }));
}

export function markJobStatus(id, status, lastError = "") {
  const ts = nowTs();
  db.prepare(`UPDATE jobs SET status=?, lastError=?, updatedAt=? WHERE id=?`).run(status, lastError, ts, id);

  // Return updated job for SSE notification
  const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
  if (row) {
    return {
      ...row,
      relays: JSON.parse(row.relays || "[]"),
      payload: JSON.parse(row.payload || "{}")
    };
  }
  return null;
}

export function deleteJob(id) {
  db.prepare(`DELETE FROM jobs WHERE id=?`).run(id);
}

export function getEarliestPendingTimestamp() {
  const row = db
    .prepare(`SELECT MIN(COALESCE(scheduledAt, createdAt)) AS ts FROM jobs WHERE status='scheduled'`)
    .get();
  return row?.ts || null;
}

export function getJobById(id) {
  const row = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id);
  if (!row) return null;
  return { ...row, relays: JSON.parse(row.relays || "[]"), payload: JSON.parse(row.payload || "{}") };
}

export function updateJob(id, updates = {}) {
  const existing = getJobById(id);
  if (!existing) return null;
  const ts = nowTs();

  const next = {
    ...existing,
    ...updates,
    relays: Array.isArray(updates.relays) ? updates.relays : existing.relays,
    payload: updates.payload ?? existing.payload
  };

  db.prepare(
    `UPDATE jobs
     SET relays=?, payload=?, noteId=?, scheduledAt=?, status=?, lastError=?, updatedAt=?
     WHERE id=?`
  ).run(
    JSON.stringify(next.relays || []),
    JSON.stringify(next.payload || {}),
    next.noteId || "",
    Number(next.scheduledAt) || existing.scheduledAt,
    next.status || existing.status,
    next.lastError || "",
    ts,
    id
  );

  return getJobById(id);
}
