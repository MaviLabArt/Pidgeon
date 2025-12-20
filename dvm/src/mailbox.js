// Mailbox publishing is CPU-heavy; run flushes in worker threads and cap concurrency.
import { Worker } from "worker_threads";
import { normalizeRelayUrl } from "@welshman/util";

const FLUSH_DEBOUNCE_MS = Number(process.env.MAILBOX_DEBOUNCE_MS || 500);
const WORKER_COUNT = Math.max(1, Number(process.env.MAILBOX_FLUSH_WORKERS || 1) || 1);
const MAX_RETRY_MS = Math.max(1000, Number(process.env.MAILBOX_RETRY_MAX_MS || 10000) || 10000);

let dvmSkHex = "";
let dvmRelays = [];
let pool = null;

const stateByPubkey = new Map(); // pubkey -> { dirty, timer, flushing, retryMs }
const tasksByPubkey = new Map(); // pubkey -> Promise
const uniq = (list = []) => Array.from(new Set(list));

function getState(pubkey) {
  let st = stateByPubkey.get(pubkey);
  if (st) return st;
  st = {
    dirty: false,
    timer: null,
    flushing: false,
    retryMs: 0
  };
  stateByPubkey.set(pubkey, st);
  return st;
}

function enqueueMailboxTask(pubkey, payload) {
  if (!pool || !pubkey) return Promise.resolve(null);
  const key = String(pubkey || "");
  const prev = tasksByPubkey.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => pool.run(payload));
  tasksByPubkey.set(key, next);
  next.finally(() => {
    if (tasksByPubkey.get(key) === next) tasksByPubkey.delete(key);
  });
  return next;
}

function createMailboxWorkerPool({ size }) {
  const workerUrl = new URL("./mailboxWorker.js", import.meta.url);
  const workers = [];
  const queue = [];
  let nextId = 0;
  let draining = false;

  const replaceWorker = (slot) => {
    if (draining) return;
    try {
      slot.worker.terminate().catch(() => {});
    } catch {}
    slot.worker = new Worker(workerUrl, { type: "module" });
    attach(slot);
  };

  const attach = (slot) => {
    slot.worker.on("message", (msg) => {
      const current = slot.current;
      if (!current) return;
      if (msg?.id !== current.id) return;
      slot.current = null;
      slot.busy = false;
      if (msg?.ok) current.resolve(msg.result);
      else current.reject(new Error(msg?.error || "Mailbox worker task failed"));
      dispatch();
    });

    slot.worker.on("error", (err) => {
      const current = slot.current;
      slot.current = null;
      slot.busy = false;
      if (current) current.reject(err);
      replaceWorker(slot);
    });

    slot.worker.on("exit", (code) => {
      const current = slot.current;
      slot.current = null;
      slot.busy = false;
      if (current) current.reject(new Error(`Mailbox worker exited (${code})`));
      if (!draining) replaceWorker(slot);
    });
  };

  for (let i = 0; i < size; i++) {
    const slot = { worker: new Worker(workerUrl, { type: "module" }), busy: false, current: null };
    attach(slot);
    workers.push(slot);
  }

  const dispatch = () => {
    if (draining) return;
    for (const slot of workers) {
      if (!queue.length) return;
      if (slot.busy) continue;
      const task = queue.shift();
      slot.busy = true;
      slot.current = task;
      try {
        slot.worker.postMessage({ id: task.id, ...task.payload });
      } catch (err) {
        slot.busy = false;
        slot.current = null;
        task.reject(err);
        replaceWorker(slot);
      }
    }
  };

  const run = (payload) => {
    if (draining) return Promise.reject(new Error("Mailbox worker pool is shutting down"));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      queue.push({ id, payload, resolve, reject });
      dispatch();
    });
  };

  const destroy = async () => {
    draining = true;
    while (queue.length) {
      const task = queue.shift();
      task.reject(new Error("Mailbox worker pool shut down"));
    }
    await Promise.allSettled(workers.map((slot) => slot.worker.terminate()));
    workers.length = 0;
  };

  return { run, destroy };
}

export function initMailboxPublisher({ dvmSkHex: sk, relays }) {
  dvmSkHex = String(sk || "").trim();
  dvmRelays = uniq((relays || []).map(normalizeRelayUrl).filter(Boolean));

  if (pool) {
    pool.destroy().catch(() => {});
    pool = null;
  }

  if (!dvmSkHex || !dvmRelays.length) return;
  pool = createMailboxWorkerPool({ size: WORKER_COUNT });
}

export function queueMailboxPublish(pubkey) {
  if (!pool || !dvmSkHex || !pubkey) return;
  const st = getState(pubkey);
  st.dirty = true;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => flushMailbox(pubkey).catch(() => {}), FLUSH_DEBOUNCE_MS);
}

export async function flushAllMailboxes() {
  const pubkeys = Array.from(stateByPubkey.keys());
  // Clear any pending debounce timers so shutdown doesn't keep the event loop alive.
  for (const pk of pubkeys) {
    const st = stateByPubkey.get(pk);
    if (st?.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
  }
  await Promise.allSettled(pubkeys.map((pk) => flushMailbox(pk)));
}

export async function flushMailbox(pubkey) {
  if (!pool || !dvmSkHex || !pubkey) return;
  const st = getState(pubkey);

  // If this was invoked by a timer, clear it; we'll reschedule if needed.
  if (st.timer) {
    clearTimeout(st.timer);
    st.timer = null;
  }

  if (!st.dirty) return;
  if (st.flushing) return;
  st.flushing = true;
  st.dirty = false;

  try {
    await enqueueMailboxTask(pubkey, { type: "flush", pubkey, relays: dvmRelays, dvmSkHex });
    st.retryMs = 0;
  } catch (err) {
    // Avoid "losing" updates on transient relay/publish errors.
    st.dirty = true;
    st.retryMs = Math.min(MAX_RETRY_MS, Math.max(500, st.retryMs ? st.retryMs * 2 : 2000));
    if (!st.timer) {
      st.timer = setTimeout(() => flushMailbox(pubkey).catch(() => {}), st.retryMs);
    }
    console.warn(
      "[mailbox] flush failed; will retry",
      pubkey?.slice?.(0, 8) ? `${pubkey.slice(0, 8)}…` : pubkey,
      err?.message || err
    );
    throw err;
  } finally {
    st.flushing = false;
    // If changes came in while we were flushing, schedule another pass.
    if (st.dirty && !st.timer) {
      st.timer = setTimeout(() => flushMailbox(pubkey).catch(() => {}), FLUSH_DEBOUNCE_MS);
    }
  }
}

export async function repairMailbox(pubkey, { scope = "queue" } = {}) {
  if (!pool || !dvmSkHex || !pubkey) return { skipped: true, reason: "not initialized" };
  return enqueueMailboxTask(pubkey, { type: "repair", pubkey, relays: dvmRelays, dvmSkHex, scope });
}
