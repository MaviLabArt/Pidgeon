// Small LRU with optional TTL (used by the DVM).
export class LruTtlCache {
  constructor({ max = 1000, ttlMs = 0 } = {}) {
    this.max = Math.max(1, Number(max) || 1);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.map = new Map(); // key -> { value, expiresAt }
  }

  _isExpired(entry) {
    if (!entry) return true;
    const exp = Number(entry.expiresAt) || 0;
    return exp > 0 && Date.now() > exp;
  }

  _touch(key, entry) {
    this.map.delete(key);
    this.map.set(key, entry);
  }

  get(key) {
    const k = String(key ?? "");
    if (!k) return undefined;
    const entry = this.map.get(k);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      this.map.delete(k);
      return undefined;
    }
    this._touch(k, entry);
    return entry.value;
  }

  set(key, value, ttlOverrideMs = undefined) {
    const k = String(key ?? "");
    if (!k) return value;
    const ttl = ttlOverrideMs === undefined ? this.ttlMs : Math.max(0, Number(ttlOverrideMs) || 0);
    const expiresAt = ttl ? Date.now() + ttl : 0;
    this.map.delete(k);
    this.map.set(k, { value, expiresAt });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return value;
  }

  delete(key) {
    const k = String(key ?? "");
    if (!k) return false;
    return this.map.delete(k);
  }

  clear() {
    this.map.clear();
  }

  size() {
    return this.map.size;
  }
}
