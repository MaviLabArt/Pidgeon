import net from "net";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { publish, requestOne } from "@welshman/net";
import { normalizeRelayUrl } from "@welshman/util";
import { finalizeEvent, getPublicKey, nip04, nip19 } from "nostr-tools";

const NWC_REQUEST_KIND = 23194;
const NWC_RESPONSE_KIND = 23195;

function isPrivateIp(ip) {
  const addr = String(ip || "").trim();
  if (!addr) return true;
  const type = net.isIP(addr);
  if (!type) return true;

  if (type === 4) {
    const parts = addr.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  if (type === 6) {
    const v = addr.toLowerCase();
    if (v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("fe80")) return true; // link-local
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

function assertSafeHttpUrl(rawUrl, { allowHttp = false } = {}) {
  const url = new URL(rawUrl);
  if (!(url.protocol === "https:" || (allowHttp && url.protocol === "http:"))) {
    throw new Error(`Unsupported protocol for LNURL endpoint: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("LNURL endpoint must not contain credentials");
  if (isBlockedHostname(url.hostname)) throw new Error("LNURL endpoint hostname is blocked");
  return url;
}

function assertSafeRelayUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!(url.protocol === "wss:" || url.protocol === "ws:")) {
    throw new Error(`Unsupported relay protocol: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("Relay URL must not contain credentials");
  // NOTE: This is operator-configured (not user-input), so we allow private hostnames/IPs.
  return url;
}

async function fetchJson(url, { timeoutMs = 5000, allowHttp = false, method = "GET" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 5000));
  try {
    const safe = assertSafeHttpUrl(url, { allowHttp });
    const res = await fetch(safe.toString(), {
      method: String(method || "GET").toUpperCase(),
      headers: { Accept: "application/json" },
      signal: ctrl.signal
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const reason = body?.reason || body?.error || body?.message || res.statusText || "HTTP error";
      throw new Error(String(reason));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function parseLud16(lud16) {
  const raw = String(lud16 || "").trim();
  if (!raw) return null;
  if (!raw.includes("@")) return null;
  const [name, domain] = raw.split("@");
  const n = String(name || "").trim();
  const d = String(domain || "").trim();
  if (!n || !d) return null;
  return { name: n, domain: d };
}

function normalizeNostrPubkeyHex(input) {
  let pk = String(input || "").trim();
  if (!pk) return "";
  if (pk.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(pk);
      if (decoded.type !== "npub" || !decoded.data) return "";
      pk = typeof decoded.data === "string" ? decoded.data : bytesToHex(decoded.data);
    } catch {
      return "";
    }
  }
  pk = pk.toLowerCase();
  return /^[a-f0-9]{64}$/.test(pk) ? pk : "";
}

function parseNostrSecretKey(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Missing NWC secret");
  if (s.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(s);
      if (decoded.type !== "nsec" || !decoded.data) throw new Error("Invalid nsec");
      const hex = bytesToHex(decoded.data);
      return { hex, bytes: decoded.data };
    } catch (err) {
      throw new Error(`Failed to decode NWC secret: ${err?.message || err}`);
    }
  }
  const hex = s.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("Invalid NWC secret (expected 64-char hex or nsec)");
  return { hex, bytes: hexToBytes(hex) };
}

function parseNwcUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Missing NWC URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid NWC URL");
  }
  if (String(url.protocol || "") !== "nostr+walletconnect:") {
    throw new Error("Invalid NWC URL protocol (expected nostr+walletconnect://)");
  }
  if (url.username || url.password) throw new Error("NWC URL must not contain credentials");

  // `nostr+walletconnect://<wallet-pubkey>` -> hostname is the pubkey.
  // Some parsers may put it in pathname, so accept either.
  const walletPubkey =
    normalizeNostrPubkeyHex(url.hostname) ||
    normalizeNostrPubkeyHex(String(url.pathname || "").replace(/^\//, ""));
  if (!walletPubkey) throw new Error("Invalid NWC wallet pubkey");

  const relayRaw = String(url.searchParams.getAll("relay")[0] || url.searchParams.get("relay") || "").trim();
  if (!relayRaw) throw new Error("Missing NWC relay (relay=...)");
  const relayNormalized = normalizeRelayUrl(relayRaw);
  if (!relayNormalized) throw new Error("Invalid NWC relay URL");
  assertSafeRelayUrl(relayNormalized);

  const secretRaw = String(url.searchParams.get("secret") || "").trim();
  const secret = parseNostrSecretKey(secretRaw);
  const clientPubkey = getPublicKey(secret.bytes);

  return {
    relay: relayNormalized,
    walletPubkey,
    clientPubkey,
    secretHex: secret.hex,
    secretBytes: secret.bytes
  };
}

function pickFirstTagValue(tags, key) {
  const list = Array.isArray(tags) ? tags : [];
  const t = list.find((x) => Array.isArray(x) && x[0] === key && typeof x[1] === "string");
  return String(t?.[1] || "").trim();
}

async function nwcCall({ nwcUrl, method, params = {}, timeoutMs = 8000 } = {}) {
  const cfg = parseNwcUrl(nwcUrl);
  const createdAt = Math.floor(Date.now() / 1000);
  const timeout = Math.max(1000, Number(timeoutMs) || 8000);

  const methodName = String(method || "").trim();
  const plaintext = JSON.stringify({
    method: methodName,
    params: params && typeof params === "object" ? params : {}
  });

  const content = await nip04.encrypt(cfg.secretHex, cfg.walletPubkey, plaintext);
  const draft = {
    kind: NWC_REQUEST_KIND,
    created_at: createdAt,
    tags: [["p", cfg.walletPubkey]],
    content
  };
  const req = finalizeEvent(draft, cfg.secretBytes);

  let matched = null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let responsePromise;
  try {
    responsePromise = requestOne({
      relay: cfg.relay,
      filters: [
        {
          kinds: [NWC_RESPONSE_KIND],
          authors: [cfg.walletPubkey],
          "#p": [cfg.clientPubkey],
          // Allow for some clock skew between app and wallet.
          since: Math.max(0, createdAt - 600),
          limit: 50
        }
      ],
      autoClose: false,
      signal: ctrl.signal,
      onEvent: (ev) => {
        if (!ev || typeof ev !== "object") return;
        const e = pickFirstTagValue(ev.tags, "e");
        if (e && e === req.id) {
          matched = ev;
          ctrl.abort();
        }
      }
    });

    await publish({ relays: [cfg.relay], event: req });
    const events = await responsePromise;

    const resEv =
      matched ||
      (Array.isArray(events)
        ? events.find((ev) => pickFirstTagValue(ev?.tags, "e") === req.id)
        : null);
    if (!resEv?.content) throw new Error("NWC response timeout");

    const decrypted = await nip04.decrypt(cfg.secretHex, cfg.walletPubkey, String(resEv.content || ""));
    let body = null;
    try {
      body = JSON.parse(decrypted || "{}");
    } catch {
      body = null;
    }

    const resultType = String(body?.result_type || body?.resultType || "").trim();
    if (resultType && methodName && resultType !== methodName) {
      throw new Error(`NWC response mismatch (expected ${methodName}, got ${resultType})`);
    }

    const err = body?.error;
    if (err) {
      if (typeof err === "object") {
        const msg = String(err.message || err.error || err.reason || "NWC error");
        throw new Error(msg);
      }
      throw new Error(String(err));
    }

    return body?.result;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    try {
      await responsePromise;
    } catch {}
  }
}

export async function createInvoiceViaLnurlVerify({
  lud16,
  sats,
  comment = "",
  timeoutMs = 5000,
  allowHttp = false
} = {}) {
  const parsed = parseLud16(lud16);
  if (!parsed) throw new Error("Invalid lightning address (expected name@domain)");
  const lnurlp = new URL(`/.well-known/lnurlp/${encodeURIComponent(parsed.name)}`, `https://${parsed.domain}`).toString();

  const payReq = await fetchJson(lnurlp, { timeoutMs, allowHttp });
  if (payReq?.status && String(payReq.status).toUpperCase() === "ERROR") {
    throw new Error(String(payReq.reason || "LNURL error"));
  }

  const callback = String(payReq?.callback || "").trim();
  if (!callback) throw new Error("LNURL pay endpoint missing callback");

  const minMsat = Math.max(0, Number(payReq?.minSendable) || 0);
  const maxMsat = Math.max(0, Number(payReq?.maxSendable) || 0);
  const wantMsat = Math.max(0, Math.floor((Number(sats) || 0) * 1000));
  let amountMsat = wantMsat;
  if (minMsat && amountMsat < minMsat) amountMsat = minMsat;
  if (maxMsat && amountMsat > maxMsat) amountMsat = maxMsat;
  if (!amountMsat) throw new Error("Invoice amount is 0");

  const callbackUrl = new URL(callback);
  callbackUrl.searchParams.set("amount", String(amountMsat));

  const commentAllowed = Math.max(0, Number(payReq?.commentAllowed) || 0);
  const c = String(comment || "").trim();
  if (c && commentAllowed > 0) {
    callbackUrl.searchParams.set("comment", c.slice(0, commentAllowed));
  }

  const invoiceRes = await fetchJson(callbackUrl.toString(), { timeoutMs, allowHttp });
  if (invoiceRes?.status && String(invoiceRes.status).toUpperCase() === "ERROR") {
    throw new Error(String(invoiceRes.reason || invoiceRes.message || "LNURL callback error"));
  }

  const pr = String(invoiceRes?.pr || "").trim();
  const verifyUrl = String(invoiceRes?.verify || "").trim();
  if (!pr) throw new Error(String(invoiceRes?.reason || "LNURL callback missing pr"));
  if (!verifyUrl) {
    throw new Error("LNURL callback did not return verify URL (LUD-21 / lnurl-verify unsupported)");
  }

  return {
    pr,
    verifyUrl,
    sats: Math.floor(amountMsat / 1000)
  };
}

export async function verifyInvoiceViaLnurlVerify({ verifyUrl, timeoutMs = 5000, allowHttp = false } = {}) {
  const url = String(verifyUrl || "").trim();
  if (!url) throw new Error("Missing verify URL");
  const body = await fetchJson(url, { timeoutMs, allowHttp });
  if (body?.status && String(body.status).toUpperCase() === "ERROR") {
    throw new Error(String(body.reason || "LNURL verify error"));
  }
  return {
    settled: Boolean(body?.settled),
    preimage: body?.preimage ? String(body.preimage) : "",
    pr: body?.pr ? String(body.pr) : ""
  };
}

export async function createInvoiceViaNwc({
  nwcUrl,
  sats,
  comment = "",
  expirySec = 0,
  timeoutMs = 8000
} = {}) {
  const s = Math.max(0, Math.floor(Number(sats) || 0));
  if (!(s > 0)) throw new Error("Invoice amount is 0");

  const amountMsat = s * 1000;
  const memo = String(comment || "").trim();
  const exp = Math.max(0, Math.floor(Number(expirySec) || 0));

  const result = await nwcCall({
    nwcUrl,
    method: "make_invoice",
    params: {
      amount: amountMsat,
      ...(memo ? { description: memo } : {}),
      ...(exp ? { expiry: exp } : {})
    },
    timeoutMs
  });

  const pr = String(result?.invoice || result?.pr || result?.bolt11 || "").trim();
  if (!pr) throw new Error("NWC make_invoice did not return an invoice");

  const paymentHash = String(result?.payment_hash || result?.paymentHash || "").trim().toLowerCase();
  const verifyRef = /^[a-f0-9]{64}$/.test(paymentHash) ? `nwc:hash:${paymentHash}` : "nwc:invoice";

  return { pr, verifyRef, sats: s };
}

export async function verifyInvoiceViaNwc({ nwcUrl, verifyRef = "", invoice = "", timeoutMs = 8000 } = {}) {
  const ref = String(verifyRef || "").trim();
  const pr = String(invoice || "").trim();
  if (!ref) throw new Error("Missing verify ref");
  if (!pr) throw new Error("Missing invoice");

  const m = ref.match(/^nwc:hash:([a-f0-9]{64})$/i);
  const params = m ? { payment_hash: m[1].toLowerCase() } : { invoice: pr };

  const result = await nwcCall({
    nwcUrl,
    method: "lookup_invoice",
    params,
    timeoutMs
  });

  const settledAt = Math.max(0, Number(result?.settled_at ?? result?.settledAt ?? 0) || 0);
  const settled =
    Boolean(result?.settled) ||
    Boolean(result?.paid) ||
    settledAt > 0 ||
    String(result?.status || "").toLowerCase() === "paid" ||
    String(result?.status || "").toLowerCase() === "settled";

  const preimage = String(result?.preimage || result?.payment_preimage || result?.paymentPreimage || "").trim();
  const invoiceOut = String(result?.invoice || result?.pr || pr).trim();
  return { settled, preimage, pr: invoiceOut };
}
