import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

function isDebugEnabled() {
  try {
    return (
      (typeof import.meta !== "undefined" && import.meta.env?.VITE_DEBUG_NIP46 === "1") ||
      (typeof import.meta !== "undefined" && import.meta.env?.VITE_DEBUG_NOSTR === "1")
    );
  } catch {
    return false;
  }
}

function shortHex(hex = "", n = 8) {
  const s = String(hex || "");
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function summarizeParamString(value) {
  const str = typeof value === "string" ? value : value == null ? "" : String(value);
  const bytes = new TextEncoder().encode(str);
  const digest = sha256(bytes);
  return { len: str.length, sha: shortHex(bytesToHex(digest), 12) };
}

function summarizeParams(method, params) {
  const p = Array.isArray(params) ? params : [];

  if (method === "connect") {
    return {
      remote: shortHex(p[0], 12),
      secret: summarizeParamString(p[1] || ""),
      perms: String(p[2] || "")
    };
  }

  if (method === "get_public_key") return {};

  if (method === "sign_event") {
    try {
      const raw = typeof p[0] === "string" ? p[0] : "";
      const ev = raw ? JSON.parse(raw) : null;
      return {
        kind: ev?.kind,
        created_at: ev?.created_at,
        tags: Array.isArray(ev?.tags) ? ev.tags.length : 0,
        content: summarizeParamString(ev?.content || "")
      };
    } catch {
      return { event: summarizeParamString(p[0] || "") };
    }
  }

  if (method === "nip44_encrypt" || method === "nip04_encrypt") {
    return {
      to: shortHex(p[0], 12),
      plaintext: summarizeParamString(p[1] || "")
    };
  }

  if (method === "nip44_decrypt" || method === "nip04_decrypt") {
    return {
      from: shortHex(p[0], 12),
      ciphertext: summarizeParamString(p[1] || "")
    };
  }

  return { params: p.map((x) => summarizeParamString(x)) };
}

export function attachNip46Debug(signer, label = "nip46") {
  if (!isDebugEnabled()) return;
  if (!signer || typeof signer.sendRequest !== "function") return;
  if (signer.__pidgeonNip46DebugAttached) return;
  signer.__pidgeonNip46DebugAttached = true;

  const getLogBuffer = () => {
    try {
      const w = typeof window !== "undefined" ? window : null;
      if (!w) return null;
      if (!Array.isArray(w.__pidgeonNip46Logs)) w.__pidgeonNip46Logs = [];
      return w.__pidgeonNip46Logs;
    } catch {
      return null;
    }
  };

  const original = signer.sendRequest.bind(signer);
  signer.sendRequest = async (method, params) => {
    const started = performance?.now?.() ?? Date.now();
    const buf = getLogBuffer();
    const summary = summarizeParams(method, params);
    try {
      console.debug(`nip46:${label} -> ${method}`, summary);
    } catch {}
    try {
      buf?.push({ ts: Date.now(), label, dir: "->", method, params: summary });
    } catch {}
    try {
      const result = await original(method, params);
      const ended = performance?.now?.() ?? Date.now();
      try {
        console.debug(`nip46:${label} <- ${method} ok`, {
          ms: Math.round(ended - started),
          result: summarizeParamString(result)
        });
      } catch {}
      try {
        buf?.push({
          ts: Date.now(),
          label,
          dir: "<-",
          method,
          ok: true,
          ms: Math.round(ended - started),
          result: summarizeParamString(result)
        });
      } catch {}
      return result;
    } catch (err) {
      const ended = performance?.now?.() ?? Date.now();
      try {
        console.warn(`nip46:${label} <- ${method} error`, {
          ms: Math.round(ended - started),
          error: err?.message || String(err || "error")
        });
      } catch {}
      try {
        buf?.push({
          ts: Date.now(),
          label,
          dir: "<-",
          method,
          ok: false,
          ms: Math.round(ended - started),
          error: err?.message || String(err || "error")
        });
      } catch {}
      throw err;
    }
  };
}
