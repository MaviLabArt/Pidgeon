import net from "net";

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

