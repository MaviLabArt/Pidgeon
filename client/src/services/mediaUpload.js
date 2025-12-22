import { absoluteApiUrl } from "./api.js";
import { resolveServiceUrl, signNip98Auth } from "./nip98.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const UPLOAD_ABORTED_ERROR_MSG = "Upload aborted";
const imetaByUrl = new Map();

function base64EncodeUtf8(text) {
  const str = String(text ?? "");
  if (typeof btoa === "function") {
    return btoa(unescape(encodeURIComponent(str)));
  }
  // Node/test fallback (shouldn't run in-browser builds)
  // eslint-disable-next-line no-undef
  return Buffer.from(str, "utf8").toString("base64");
}

function base64EncodeJson(obj) {
  return base64EncodeUtf8(JSON.stringify(obj));
}

function normalizeBlossomServer(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.origin;
  } catch {
    return "";
  }
}

function parseBlossomServers(input) {
  if (Array.isArray(input)) return input.map(normalizeBlossomServer).filter(Boolean);
  return String(input || "")
    .split(/[\n,]/)
    .map((s) => normalizeBlossomServer(s))
    .filter(Boolean);
}

function normalizeNip96Service(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.username || url.password) return "";
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function parseNip96Services(input) {
  if (Array.isArray(input)) return input.map(normalizeNip96Service).filter(Boolean);
  return String(input || "")
    .split(/[\n,]/)
    .map((s) => normalizeNip96Service(s))
    .filter(Boolean);
}

function extractTagValue(tags, key) {
  return (
    tags.find((t) => Array.isArray(t) && t[0] === key && typeof t[1] === "string")?.[1] || ""
  );
}

function buildImetaTag({ url, sha256Hex, mime, size }) {
  const parts = [];
  const u = String(url || "").trim();
  const x = String(sha256Hex || "").trim();
  const m = String(mime || "").trim();
  const s = size !== undefined && size !== null && String(size).trim() ? String(size).trim() : "";
  if (u) parts.push(`url ${u}`);
  if (m) parts.push(`m ${m}`);
  if (x) parts.push(`x ${x}`);
  if (s) parts.push(`size ${s}`);
  return parts.length ? ["imeta", ...parts] : null;
}

function parseUploadResponse(data, { fallbackSha256, fallbackMime, fallbackSize } = {}) {
  const tags = Array.isArray(data?.nip94_event?.tags)
    ? data.nip94_event.tags
    : Array.isArray(data?.nip94)
      ? data.nip94
      : [];

  const url = extractTagValue(tags, "url") || data?.url;
  if (!url) throw new Error("No url found");

  const sha256Hex =
    (typeof data?.sha256 === "string" && data.sha256) ||
    extractTagValue(tags, "x") ||
    String(fallbackSha256 || "");
  const mime =
    (typeof data?.type === "string" && data.type) || extractTagValue(tags, "m") || String(fallbackMime || "");
  const size =
    data?.size !== undefined && data?.size !== null ? String(data.size) : extractTagValue(tags, "size") || String(fallbackSize ?? "");

  // Ensure minimal NIP-94-like tags exist even if server only returned a Blossom descriptor.
  if (!extractTagValue(tags, "url")) tags.push(["url", url]);
  if (mime && !extractTagValue(tags, "m")) tags.push(["m", mime]);
  if (sha256Hex && !extractTagValue(tags, "x")) tags.push(["x", sha256Hex]);
  if (size && !extractTagValue(tags, "size")) tags.push(["size", size]);

  let imeta = tags.find((t) => Array.isArray(t) && t[0] === "imeta");
  if (!imeta) {
    const built = buildImetaTag({ url, sha256Hex, mime, size });
    if (built) {
      imeta = built;
      tags.push(imeta);
    }
  }
  if (imeta) imetaByUrl.set(url, imeta);
  return { url, tags };
}

function parseXhrResponseJson(xhr) {
  if (xhr.response && typeof xhr.response === "object") return xhr.response;
  const text = xhr.responseText;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return null;
}

function requestWithXhr(method, targetUrl, { body, auth, signal, onProgress, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, targetUrl);
    xhr.responseType = "json";
    if (auth) xhr.setRequestHeader("Authorization", auth);
    Object.entries(headers).forEach(([key, value]) => {
      if (value) xhr.setRequestHeader(key, value);
    });

    const handleAbort = () => {
      try {
        xhr.abort();
      } catch {
        // ignore abort errors
      }
      reject(new Error(UPLOAD_ABORTED_ERROR_MSG));
    };
    if (signal) {
      if (signal.aborted) return handleAbort();
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress?.(percent);
      }
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.onload = () => {
      const data = parseXhrResponseJson(xhr);
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);

      const reason = String(xhr.getResponseHeader("x-reason") || "").trim();
      const messageFromJson = typeof data?.error === "string" ? data.error : "";
      const message =
        reason ||
        messageFromJson ||
        (xhr.status ? `${xhr.status} ${xhr.statusText}` : "Upload failed");
      reject(new Error(message));
    };
    xhr.send(body);
  });
}

async function uploadViaNip96(file, { onProgress, signal, serviceUrl } = {}) {
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR_MSG);

  const services = parseNip96Services(serviceUrl || "https://nostr.build");
  if (!services.length) throw new Error("No NIP-96 services configured");

  let lastError = null;
  for (const baseService of services) {
    let proxyError = null;
    try {
      const uploadUrl = await resolveServiceUrl(baseService);
      const formData = new FormData();
      formData.append("file", file);

      const auth = await signNip98Auth(uploadUrl, "POST", signal);
      const proxyUrl = absoluteApiUrl("/api/nip96/upload");
      const proxyHeaders = {
        "x-nip96-target": uploadUrl,
        "x-nip96-service": baseService,
      };

      try {
        const data = await requestWithXhr("POST", proxyUrl, { body: formData, auth, signal, onProgress, headers: proxyHeaders });
        return parseUploadResponse(data, { fallbackMime: file?.type, fallbackSize: file?.size });
      } catch (err) {
        if (err?.message === UPLOAD_ABORTED_ERROR_MSG) throw err;
        proxyError = err;
      }

      try {
        const data = await requestWithXhr("POST", uploadUrl, { body: formData, auth, signal, onProgress });
        return parseUploadResponse(data, { fallbackMime: file?.type, fallbackSize: file?.size });
      } catch (err) {
        if (err?.message === UPLOAD_ABORTED_ERROR_MSG) throw err;
        lastError = proxyError || err;
      }
    } catch (err) {
      if (err?.message === UPLOAD_ABORTED_ERROR_MSG) throw err;
      lastError = err;
    }
  }

  throw lastError || new Error("Upload failed");
}

async function sha256HexOfFile(file, signal) {
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR_MSG);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR_MSG);
  return bytesToHex(sha256(bytes));
}

async function signBlossomAuth({ verb, sha256Hex, description, signal } = {}) {
  if (typeof window === "undefined" || !window.nostr?.signEvent || !window.nostr?.getPublicKey) {
    throw new Error("Nostr signer required for upload");
  }
  const created_at = Math.floor(Date.now() / 1000);
  const expiration = created_at + 60 * 60; // 1 hour
  const pubkey = await window.nostr.getPublicKey();
  const tags = [
    ["t", String(verb || "").trim() || "upload"],
    ["expiration", String(expiration)],
  ];
  const x = String(sha256Hex || "").trim();
  if (x) tags.push(["x", x]);

  const content = String(description || "").trim() || "Upload Blob";
  const ev = { kind: 24242, created_at, tags, content, pubkey };
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR_MSG);
  const signed = await window.nostr.signEvent(ev);
  return `Nostr ${base64EncodeJson(signed)}`;
}

async function uploadViaBlossom(file, { onProgress, signal, blossomServers } = {}) {
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR_MSG);

  const servers = parseBlossomServers(blossomServers);
  if (!servers.length) throw new Error("No Blossom servers configured");

  const hash = await sha256HexOfFile(file, signal);
  const auth = await signBlossomAuth({
    verb: "upload",
    sha256Hex: hash,
    description: file?.name ? `Upload ${file.name}` : "Upload Blob",
    signal
  });

  let lastError = null;
  for (const server of servers) {
    const uploadUrl = new URL("/upload", server).toString();
    try {
      const data = await requestWithXhr("PUT", uploadUrl, {
        body: file,
        auth,
        signal,
        onProgress,
        headers: file?.type ? { "content-type": file.type } : {},
      });

      const respHash = typeof data?.sha256 === "string" ? data.sha256.toLowerCase() : "";
      if (respHash && respHash !== hash) {
        throw new Error("Uploaded blob hash mismatch");
      }

      return parseUploadResponse(data, { fallbackSha256: hash, fallbackMime: file?.type, fallbackSize: file?.size });
    } catch (err) {
      if (err?.message === UPLOAD_ABORTED_ERROR_MSG) throw err;
      lastError = err;
    }
  }

  throw lastError || new Error("Upload failed");
}

async function upload(file, opts = {}) {
  const backend = String(opts.backend || "nip96").toLowerCase();
  if (backend === "blossom") {
    return uploadViaBlossom(file, opts);
  }
  const serviceUrl = opts.serviceUrl || "https://nostr.build";
  return uploadViaNip96(file, { ...opts, serviceUrl });
}

function getImetaTagByUrl(url) {
  return imetaByUrl.get(url);
}

const mediaUpload = { upload, getImetaTagByUrl };
export default mediaUpload;
export { getImetaTagByUrl };
