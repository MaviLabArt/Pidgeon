import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import { mountClient } from "./serveClient.js";
import { getPublicKey, nip19 } from "nostr-tools";

function parseNostrSecret(secret = "") {
  const raw = String(secret || "").trim();
  if (!raw) return null;
  if (raw.startsWith("nsec1")) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded.type === "nsec") return decoded.data;
    } catch {
      return null;
    }
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Uint8Array.from(Buffer.from(raw, "hex"));
  }
  return null;
}

function getNip05MessengerPubkeyHex() {
  const override = String(process.env.NIP05_PUBKEY || "").trim();
  if (override) return override;
  const secretBytes = parseNostrSecret(process.env.DVM_SECRET || "");
  if (!secretBytes) return "";
  try {
    return getPublicKey(secretBytes);
  } catch {
    return "";
  }
}

function getNip05MessengerRelays() {
  const raw = String(process.env.NIP05_RELAYS || process.env.DVM_RELAYS || "").trim();
  return raw
    .split(/[, \n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((u) => u.startsWith("wss://"));
}

const nip96Cache = new Map();
const calendarEvents = [];

function normalizeNip96Service(service) {
  const trimmed = String(service || "").trim();
  if (!trimmed) return "";
  const base = trimmed.replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  try {
    const url = new URL(withScheme);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

async function resolveNip96UploadUrl(service) {
  const base = normalizeNip96Service(service);
  if (!base) throw new Error("service required");

  const key = `nip96:${base}`;
  if (nip96Cache.has(key)) return nip96Cache.get(key);

  const wellKnown = `${base}/.well-known/nostr/nip96.json`;
  const resp = await fetch(wellKnown).catch((err) => {
    throw new Error(`Failed to fetch nip96.json: ${err?.message || err}`);
  });
  if (!resp || !resp.ok) {
    throw new Error(`Failed to fetch nip96.json (${resp?.status || "no response"})`);
  }
  const data = await resp.json().catch(() => ({}));
  const url = data?.api_url;
  if (!url) throw new Error("nip96.json missing api_url");

  nip96Cache.set(key, url);
  return url;
}

// HTTP job streaming/fetching deprecated; keep export for callers but no-op
export function notifyJobUpdate() {}

export function startApiServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const allowed = process.env.CORS_ORIGIN?.split(/[,\s]+/).filter(Boolean) || ["*"];
  const enableCors = process.env.ENABLE_CORS === "1";
  const defaultNip96Service = process.env.NIP96_SERVICE || "https://nostr.build";
  if (enableCors) {
    app.use(
      cors({
        origin: allowed,
        methods: ["GET", "POST", "DELETE"],
        credentials: true,
        allowedHeaders: ["content-type", "authorization", "x-nip96-target", "x-nip96-service"]
      })
    );
  }

  app.get("/.well-known/nostr.json", (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("cache-control", "public, max-age=300");

    const name = String(req.query?.name || "").trim().toLowerCase();
    const localPart = String(process.env.NIP05_NAME || "messenger").trim().toLowerCase();
    const pubkey = getNip05MessengerPubkeyHex();
    const relays = getNip05MessengerRelays();

    if (!pubkey) return res.status(500).json({ error: "NIP-05 pubkey not configured" });
    if (name && name !== localPart) return res.json({ names: {} });

    const payload = {
      names: {
        [localPart]: pubkey
      },
      ...(relays.length
        ? {
            relays: {
              [pubkey]: relays
            }
          }
        : {})
    };

    return res.json(payload);
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  // Lightweight in-memory calendar endpoints (dev helper for calendar UI)
  app.get("/api/events", (req, res) => {
    const { start, end, q } = req.query || {};
    const startTs = start ? Date.parse(String(start)) : Number.NaN;
    const endTs = end ? Date.parse(String(end)) : Number.NaN;
    const query = String(q || "").toLowerCase();
    const isCanceled = (status = "") => status === "canceled" || status === "cancelled";
    const filtered = calendarEvents.filter((evt) => {
      const evtStart = Date.parse(evt.start);
      const evtEnd = Date.parse(evt.end);
      const inRange =
        (Number.isNaN(startTs) || evtEnd >= startTs) &&
        (Number.isNaN(endTs) || evtStart <= endTs);
      const matchesQuery =
        !query ||
        evt.title?.toLowerCase().includes(query) ||
        evt.caption?.toLowerCase().includes(query);
      return inRange && matchesQuery && !isCanceled(evt.status);
    });
    res.json(filtered);
  });

  app.post("/api/events", (req, res) => {
    const payload = req.body || {};
    if (!payload.start || !payload.end) {
      return res.status(400).json({ error: "start and end are required" });
    }
    const evt = {
      id: typeof randomUUID === "function" ? randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: payload.title || "Untitled",
      caption: payload.caption || "",
      start: payload.start,
      end: payload.end,
      status: payload.status || "scheduled",
      tags: payload.tags || [],
      timezone: payload.timezone || "",
      color: payload.color || "neutral",
      imageUrl: payload.imageUrl || ""
    };
    calendarEvents.unshift(evt);
    res.json(evt);
  });

  app.patch("/api/events/:id", (req, res) => {
    const id = String(req.params.id || "");
    const idx = calendarEvents.findIndex((e) => e.id === id);
    if (idx === -1) return res.status(404).json({ error: "Event not found" });
    calendarEvents[idx] = { ...calendarEvents[idx], ...(req.body || {}) };
    res.json(calendarEvents[idx]);
  });

  app.delete("/api/events/:id", (req, res) => {
    const id = String(req.params.id || "");
    const idx = calendarEvents.findIndex((e) => e.id === id);
    if (idx !== -1) {
      calendarEvents.splice(idx, 1);
    }
    res.status(204).end();
  });

  app.get("/api/nip96/resolve", async (req, res) => {
    const service = String(req.query.service || defaultNip96Service || "").trim();
    if (!service) return res.status(400).json({ error: "service required" });
    try {
      const uploadUrl = await resolveNip96UploadUrl(service);
      res.json({ uploadUrl });
    } catch (err) {
      console.error("[nip96] resolve failed:", err?.message || err);
      res.status(500).json({ error: err?.message || "Failed to resolve nip96 service" });
    }
  });

  app.post("/api/nip96/upload", async (req, res) => {
    const controller = new AbortController();
    req.on("aborted", () => controller.abort());

    const auth = req.get("authorization");
    if (!auth) return res.status(400).json({ error: "Missing Authorization header" });

    const targetHeader = req.get("x-nip96-target") || "";
    const service = String(req.query.service || defaultNip96Service || "").trim();

    try {
      const targetUrl = targetHeader || (service ? await resolveNip96UploadUrl(service) : "");
      if (!targetUrl) return res.status(400).json({ error: "Missing upload target" });

      const url = new URL(targetUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        return res.status(400).json({ error: "Invalid upload target" });
      }

      const upstream = await fetch(url, {
        method: "POST",
        headers: {
          authorization: auth,
          ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}),
          ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {})
        },
        body: req,
        duplex: "half",
        signal: controller.signal
      });

      res.status(upstream.status);
      res.setHeader("cache-control", "no-store");
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("content-type", ct);
      if (!upstream.body) return res.end();

      return Readable.fromWeb(upstream.body).pipe(res);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("[nip96] upload proxy failed:", err?.message || err);
      res.status(502).json({ error: err?.message || "Upload proxy failed" });
    }
  });

  app.get("/api/drafts/:pubkey", (req, res) => {
    res.status(410).json({ error: "Drafts are stored on Nostr relays only." });
  });

  app.post("/api/drafts", (req, res) => {
    res.status(410).json({ error: "Drafts are stored on Nostr relays only." });
  });

  app.delete("/api/drafts/:pubkey/:id", (req, res) => {
    res.status(410).json({ error: "Drafts are stored on Nostr relays only." });
  });

  // Serve built client (SPA) from the same port
  mountClient(app);

  const port = Number(process.env.API_PORT || 3001);
  app.listen(port, () => {
    console.log(`[api] listening on :${port}`);
  });
}
