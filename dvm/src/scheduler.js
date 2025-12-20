// Heap-based scheduler: one timer for many jobs.
const MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days (Node.js setTimeout limit)

function heapSwap(heap, i, j) {
  const tmp = heap[i];
  heap[i] = heap[j];
  heap[j] = tmp;
}

function heapSiftUp(heap, idx) {
  let i = idx;
  while (i > 0) {
    const parent = Math.floor((i - 1) / 2);
    if (heap[parent].dueAtMs <= heap[i].dueAtMs) break;
    heapSwap(heap, parent, i);
    i = parent;
  }
}

function heapSiftDown(heap, idx) {
  let i = idx;
  for (;;) {
    const left = i * 2 + 1;
    const right = left + 1;
    let smallest = i;
    if (left < heap.length && heap[left].dueAtMs < heap[smallest].dueAtMs) smallest = left;
    if (right < heap.length && heap[right].dueAtMs < heap[smallest].dueAtMs) smallest = right;
    if (smallest === i) break;
    heapSwap(heap, i, smallest);
    i = smallest;
  }
}

function heapPush(heap, node) {
  heap.push(node);
  heapSiftUp(heap, heap.length - 1);
}

function heapPop(heap) {
  if (!heap.length) return null;
  const top = heap[0];
  const last = heap.pop();
  if (heap.length && last) {
    heap[0] = last;
    heapSiftDown(heap, 0);
  }
  return top;
}

function heapPeek(heap) {
  return heap.length ? heap[0] : null;
}

export function createScheduler({ name = "scheduler", onDue } = {}) {
  const label = String(name || "scheduler");
  const heap = []; // [{ id, dueAtMs, seq }]
  const byId = new Map(); // id -> { dueAtMs, seq }
  let timer = null;
  let seq = 0;
  let stopped = false;

  const logTaskError = (err) => {
    console.warn(`[${label}] due task failed`, err?.message || err);
  };

  const isValid = (node) => {
    const entry = byId.get(node.id);
    return Boolean(entry && entry.seq === node.seq && entry.dueAtMs === node.dueAtMs);
  };

  const peekValid = () => {
    while (heap.length) {
      const node = heapPeek(heap);
      if (!node) return null;
      if (!isValid(node)) {
        heapPop(heap);
        continue;
      }
      return node;
    }
    return null;
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const reschedule = () => {
    if (stopped) return;
    clearTimer();
    const next = peekValid();
    if (!next) return;
    const delay = Math.max(0, next.dueAtMs - Date.now());
    timer = setTimeout(drainDue, Math.min(delay, MAX_TIMEOUT_MS));
  };

  const drainDue = () => {
    if (stopped) return;
    clearTimer();
    const nowMs = Date.now();
    const dueIds = [];

    while (true) {
      const node = peekValid();
      if (!node) break;
      if (node.dueAtMs > nowMs) break;
      heapPop(heap);
      if (!isValid(node)) continue;
      byId.delete(node.id);
      dueIds.push(node.id);
    }

    for (const id of dueIds) {
      Promise.resolve()
        .then(() => onDue?.(id))
        .catch(logTaskError);
    }

    reschedule();
  };

  const schedule = (id, dueSec) => {
    if (stopped) return false;
    const jobId = String(id || "").trim();
    if (!jobId) return false;

    const dueAtMs = Math.floor((Number(dueSec) || 0) * 1000);
    const normalized = Number.isFinite(dueAtMs) && dueAtMs > 0 ? dueAtMs : Date.now();
    const node = { id: jobId, dueAtMs: normalized, seq: ++seq };
    byId.set(jobId, { dueAtMs: normalized, seq: node.seq });
    heapPush(heap, node);
    reschedule();
    return true;
  };

  const cancel = (id) => {
    const jobId = String(id || "").trim();
    if (!jobId) return false;
    const existed = byId.delete(jobId);
    if (existed) reschedule();
    return existed;
  };

  const has = (id) => {
    const jobId = String(id || "").trim();
    if (!jobId) return false;
    return byId.has(jobId);
  };

  const stop = () => {
    stopped = true;
    clearTimer();
    heap.length = 0;
    byId.clear();
  };

  const stats = () => {
    const next = peekValid();
    return { name: label, scheduled: byId.size, nextDueAtMs: next?.dueAtMs || null };
  };

  return { schedule, cancel, has, stop, stats };
}
