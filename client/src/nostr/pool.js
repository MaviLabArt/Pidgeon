import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { resolveRelays } from "./config.js";

const RELAY_TIMEOUT_MS = 10000;
const CONNECT_TIMEOUT_MS = 5000;
const MAX_PARALLEL_PER_RELAY = 1; // keep REQs per relay low to avoid throttling
const DEBUG_WS = typeof import.meta !== "undefined" && import.meta.env?.VITE_DEBUG_NOSTR === "1";
const FETCH_THROTTLE_MS = 2000; // throttle identical fetches
const PUBLISH_TIMEOUT_MS = 15000;
const AUTH_TIMEOUT_MS = 30000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// WebSocket logger to trace REQ/EVENT frames (opt-in).
function LoggingWebSocket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  const origSend = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      const parsed = JSON.parse(data);
      console.debug("[nostr WS SEND]", url, parsed);
    } catch {
      console.debug("[nostr WS SEND RAW]", url, data);
    }
    return origSend(data);
  };
  ws.addEventListener("message", (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      console.debug("[nostr WS RECV]", url, parsed);
    } catch {
      console.debug("[nostr WS RECV RAW]", url, ev.data);
    }
  });
  return ws;
}

if (DEBUG_WS) {
  useWebSocketImplementation(LoggingWebSocket);
}

function dedupeRelays(relays = []) {
  return Array.from(new Set(resolveRelays(relays)));
}

// Shared SimplePool, track relays to reuse connections.
const pool = new SimplePool({ enableReconnect: false });
pool.trackRelays = true;

// Per-relay queue to avoid flooding with concurrent REQs or publishes.
const relayQueues = new Map(); // url -> {active:number, queue:Array<{fn,resolve,reject}>}

// In-flight fetch dedupe: key -> {promise, ts}
const inflightFetches = new Map();

// Relay health (in-memory, session-scoped) ------------------------------------
// Used to pick a small "fast set" for reads, with a correctness fallback.
const relayHealth = new Map(); // url -> { ok, fail, rttMs, lastOkAt, lastFailAt }
const RELAY_FAIL_RECENT_MS = 60_000;
const RELAY_EWMA_ALPHA = 0.25;
const DEFAULT_RTT_MS = 2500;
const READ_PRIMARY_RELAYS = 3;

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function getRelayHealth(url) {
  const prev = relayHealth.get(url);
  if (prev) return prev;
  const init = { ok: 0, fail: 0, rttMs: DEFAULT_RTT_MS, lastOkAt: 0, lastFailAt: 0 };
  relayHealth.set(url, init);
  return init;
}

function recordRelayResult(url, { ok, rttMs }) {
  if (!url) return;
  const entry = getRelayHealth(url);
  const now = Date.now();
  const sampleRtt = Number.isFinite(rttMs) ? clamp(Number(rttMs), 50, 30_000) : DEFAULT_RTT_MS;
  entry.rttMs = entry.rttMs ? entry.rttMs * (1 - RELAY_EWMA_ALPHA) + sampleRtt * RELAY_EWMA_ALPHA : sampleRtt;
  if (ok) {
    entry.ok += 1;
    entry.lastOkAt = now;
  } else {
    entry.fail += 1;
    entry.lastFailAt = now;
  }
}

function hasNarrowFilters(filters) {
  return (Array.isArray(filters) ? filters : [filters]).some((f) => {
    if (!f || typeof f !== "object") return false;
    if (Array.isArray(f.ids) && f.ids.length) return true;
    return Object.keys(f).some((k) => k.startsWith("#") && Array.isArray(f[k]) && f[k].length);
  });
}

function rankRelaysForRead(relays = []) {
  const list = Array.isArray(relays) ? relays : [];
  const now = Date.now();
  return list
    .map((url, idx) => {
      const h = relayHealth.get(url);
      const hasStats = Boolean(h && (h.ok || h.fail));
      const ok = h?.ok || 0;
      const fail = h?.fail || 0;
      const successRate = (ok + 1) / (ok + fail + 2); // Laplace smoothing
      const rtt = Number.isFinite(h?.rttMs) ? h.rttMs : DEFAULT_RTT_MS;
      const recentFailPenalty =
        h?.lastFailAt && now - h.lastFailAt < RELAY_FAIL_RECENT_MS ? 0.5 : 1;
      // Prefer high success rate and low rtt; keep stable order as a tiebreaker.
      const score = recentFailPenalty * successRate * (1 / Math.log2(rtt + 8));
      return { url, idx, hasStats, score };
    })
    .sort((a, b) => {
      if (!a.hasStats && !b.hasStats) return a.idx - b.idx;
      if (a.hasStats !== b.hasStats) return a.hasStats ? -1 : 1;
      return b.score - a.score || a.idx - b.idx;
    })
    .map((x) => x.url);
}

function enqueueRelayTask(url, fn) {
  const entry = relayQueues.get(url) || { active: 0, queue: [] };
  relayQueues.set(url, entry);
  return new Promise((resolve, reject) => {
    entry.queue.push({ fn, resolve, reject });
    pumpRelayQueue(url);
  });
}

function pumpRelayQueue(url) {
  const entry = relayQueues.get(url);
  if (!entry) return;
  if (entry.active >= MAX_PARALLEL_PER_RELAY) return;
  const next = entry.queue.shift();
  if (!next) return;
  entry.active += 1;
  Promise.resolve()
    .then(next.fn)
    .then(next.resolve, next.reject)
    .finally(() => {
      entry.active -= 1;
      pumpRelayQueue(url);
    });
}

async function ensureRelay(url) {
  try {
    const relay = await pool.ensureRelay(url, { connectionTimeout: CONNECT_TIMEOUT_MS });
    return relay;
  } catch (err) {
    console.warn("[nostr] relay connect failed", url, err?.message || err);
    return null;
  }
}

function trackSeen(id, relayInstance) {
  if (!pool?.seenOn) return;
  let set = pool.seenOn.get(id);
  if (!set) {
    set = new Set();
    pool.seenOn.set(id, set);
  }
  set.add(relayInstance);
}

async function fetchFromRelay(url, filters, { timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const relay = await ensureRelay(url);
  if (!relay) {
    recordRelayResult(url, { ok: false, rttMs: Date.now() - startedAt });
    return { events: [], ok: false };
  }

  const eventsById = new Map();
  return new Promise((resolve) => {
    let finished = false;
    const sub = relay.subscribe(filters, {
      receivedEvent: (relayInstance, id) => trackSeen(id, relayInstance),
      onevent: (ev) => {
        eventsById.set(ev.id, ev);
      },
      oneose: () => cleanup("eose"),
      onclose: () => cleanup("close"),
      eoseTimeout: timeoutMs
    });

    const timer = setTimeout(() => cleanup("timeout"), timeoutMs);

    function cleanup(reason) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        sub.close();
      } catch {}
      const events = Array.from(eventsById.values());
      const rttMs = Date.now() - startedAt;
      const ok = reason !== "timeout" || events.length > 0;
      recordRelayResult(url, { ok, rttMs });
      resolve({ events, ok });
    }
  });
}

export async function fetchEventsOnce(relays, filters) {
  const relayList = dedupeRelays(relays);
  const filterArray = Array.isArray(filters) ? filters : [filters];

   // Dedupe/throttle identical fetches
  const key = JSON.stringify({ relays: relayList.slice().sort(), filters: filterArray });
  const now = Date.now();
  const cached = inflightFetches.get(key);
  if (cached && now - cached.ts < FETCH_THROTTLE_MS) {
    return cached.promise;
  }

  const promise = (async () => {
    const ranked = rankRelaysForRead(relayList);
    const narrow = hasNarrowFilters(filterArray);
    const primary = narrow ? ranked.slice(0, Math.min(READ_PRIMARY_RELAYS, ranked.length)) : ranked;
    const secondary = narrow ? ranked.slice(primary.length) : [];

    const primaryResults = await Promise.all(
      primary.map((url) => enqueueRelayTask(url, () => fetchFromRelay(url, filterArray)))
    );
    const merged = new Map();
    primaryResults.flatMap((r) => r?.events || []).forEach((ev) => merged.set(ev.id, ev));

    const anyOk = primaryResults.some((r) => r?.ok);
    const shouldFallback = secondary.length && merged.size === 0 && (!anyOk || narrow);
    if (shouldFallback) {
      const secondaryResults = await Promise.all(
        secondary.map((url) => enqueueRelayTask(url, () => fetchFromRelay(url, filterArray)))
      );
      secondaryResults.flatMap((r) => r?.events || []).forEach((ev) => merged.set(ev.id, ev));
    }

    return Array.from(merged.values());
  })();

  inflightFetches.set(key, { promise, ts: now });
  promise.finally(() => {
    setTimeout(() => inflightFetches.delete(key), FETCH_THROTTLE_MS * 2);
  });
  return promise;
}

export async function fetchEventOnceWithRelay(relays, filters, { timeoutMs = 2500 } = {}) {
  const relayList = rankRelaysForRead(dedupeRelays(relays));
  const filterArray = Array.isArray(filters) ? filters : [filters];
  for (const url of relayList) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await enqueueRelayTask(url, () => fetchFromRelay(url, filterArray, { timeoutMs }));
      const events = res?.events || [];
      if (events?.length) return { event: events[0], relay: url };
    } catch {
      // ignore relay errors here; caller uses "not found" semantics.
    }
  }
  return { event: null, relay: "" };
}

export async function countEventsOnce(relayUrl, filter, { timeoutMs = 5000 } = {}) {
  const [url] = dedupeRelays([relayUrl]);
  if (!url) throw new Error("Relay URL required");
  if (!filter || typeof filter !== "object") throw new Error("Filter required");
  if (typeof WebSocket === "undefined") throw new Error("WebSocket not available");

  const subId = `cnt_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
  return await withTimeout(
    new Promise((resolve, reject) => {
      let done = false;
      const ws = new WebSocket(url);

      const cleanup = () => {
        if (done) return;
        done = true;
        try {
          ws.close();
        } catch {}
      };

      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify(["COUNT", subId, filter]));
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      ws.addEventListener("message", (ev) => {
        if (done) return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg.length < 2) return;
        if (msg[0] === "COUNT" && msg[1] === subId) {
          const payload = msg[2] && typeof msg[2] === "object" ? msg[2] : {};
          cleanup();
          resolve({
            count: Number(payload.count) || 0,
            approximate: Boolean(payload.approximate),
            relay: url
          });
        } else if (msg[0] === "NOTICE") {
          // Ignore unrelated notices; only fail if we haven't gotten a COUNT by timeout.
        }
      });

      ws.addEventListener("error", () => {
        if (done) return;
        cleanup();
        reject(new Error("COUNT websocket error"));
      });

      ws.addEventListener("close", () => {
        if (done) return;
        cleanup();
        reject(new Error("COUNT websocket closed"));
      });
    }),
    timeoutMs,
    `COUNT ${url}`
  );
}

export function subscribeEvents(relays, filters, { onEvent, onEose } = {}) {
  const relayList = dedupeRelays(relays);
  const filterArray = Array.isArray(filters) ? filters : [filters];
  const closers = [];
  let closed = false;

  relayList.forEach((url) => {
    enqueueRelayTask(url, async () => {
      if (closed) return;
      const relay = await ensureRelay(url);
      if (!relay) return;
      const sub = relay.subscribe(filterArray, {
        receivedEvent: (relayInstance, id) => trackSeen(id, relayInstance),
        onevent: (ev) => onEvent?.(ev, url),
        oneose: () => onEose?.(url),
        onclose: () => onEose?.(url),
        eoseTimeout: RELAY_TIMEOUT_MS
      });
      closers.push(() => {
        try {
          sub.close();
        } catch {}
      });
    });
  });

  return {
    close: () => {
      closed = true;
      closers.forEach((fn) => fn());
    }
  };
}

export async function publishEvents(relays, event, { successRatio = 0.34, signer } = {}) {
  const relayList = dedupeRelays(relays);
  if (!relayList.length) throw new Error("No relays provided for publish");

  const uniqueRelayUrls = Array.from(new Set(relayList));
  const successTarget = Math.max(1, Math.ceil(uniqueRelayUrls.length * successRatio));
  let successCount = 0;
  let finishedCount = 0;
  const errors = [];

  return new Promise((resolve, reject) => {
    uniqueRelayUrls.forEach((url) => {
      enqueueRelayTask(url, async () => {
        const relay = await ensureRelay(url);
        if (!relay) {
          errors.push(new Error(`${url}: connect failed`));
          checkCompletion();
          return;
        }
        try {
          await withTimeout(relay.publish(event), PUBLISH_TIMEOUT_MS, `${url}: publish`);
          trackSeen(event.id, relay);
          successCount++;
        } catch (err) {
          const msg = err?.message || String(err || "publish failed");
          // Auth-required retry (Jumble style)
          if (msg.startsWith("auth-required") && signer) {
            try {
              await withTimeout(
                relay.auth(async (authEvt) => {
                  if (typeof signer === "function") return signer(authEvt);
                  if (signer?.signEvent) return signer.signEvent(authEvt);
                  throw new Error("signer missing signEvent");
                }),
                AUTH_TIMEOUT_MS,
                `${url}: auth`
              );
              await withTimeout(relay.publish(event), PUBLISH_TIMEOUT_MS, `${url}: publish (after auth)`);
              trackSeen(event.id, relay);
              successCount++;
            } catch (authErr) {
              errors.push(new Error(`${url}: ${authErr?.message || authErr}`));
            }
          } else {
            errors.push(new Error(`${url}: ${msg}`));
          }
        } finally {
          checkCompletion();
        }
      });
    });

    function checkCompletion() {
      finishedCount++;
      if (successCount >= successTarget) {
        resolve(event.id);
        return;
      }
      if (finishedCount >= uniqueRelayUrls.length) {
        reject(new AggregateError(errors, "publish failed"));
      }
    }
  });
}

// Expose seen-on info similar to Jumble helpers
export function getSeenRelays(eventId) {
  return Array.from(pool.seenOn?.get(eventId)?.values?.() || []).map((r) => r.url || r);
}

export function getRelayHint(eventId) {
  return getSeenRelays(eventId).find((url) => url) || "";
}

export function getRelayHints(eventId) {
  return getSeenRelays(eventId);
}

export { resolveRelays };
