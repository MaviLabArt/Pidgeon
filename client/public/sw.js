/* Pidgeon service worker
   Simple, dependency free caching for installability and offline friendly navigation. */

const VERSION = "pidgeon-sw-v2";
const CORE_CACHE = `${VERSION}:core`;
const RUNTIME_CACHE = `${VERSION}:runtime`;

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/pidgeon-icon.svg",
  "/pidgeon-wordmark.svg",
  "/pidgeon-icon-192.png",
  "/pidgeon-icon-512.png",
  "/pidgeon-icon-maskable-192.png",
  "/pidgeon-icon-maskable-512.png"
];

function uniq(list = []) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(Boolean)));
}

function extractAssetUrlsFromHtml(html = "") {
  const text = String(html || "");
  const urls = new Set();
  const attrRe = /\b(?:src|href)=["']([^"']+)["']/gi;
  let match;
  while ((match = attrRe.exec(text))) {
    const url = String(match[1] || "").trim();
    if (!url) continue;
    if (!url.startsWith("/assets/")) continue;
    urls.add(url);
  }
  return Array.from(urls);
}

async function safeCacheAddAll(cache, urls) {
  const list = uniq(urls);
  await Promise.all(
    list.map((url) =>
      cache.add(url).catch(() => {
        /* ignore */
      })
    )
  );
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CORE_CACHE);
      await safeCacheAddAll(cache, CORE_ASSETS);
      // Best-effort: also pre-cache the current build's hashed JS/CSS for faster subsequent loads.
      try {
        const resp = await fetch("/index.html", { cache: "no-cache" });
        if (resp && resp.ok) {
          const html = await resp.text();
          const assets = extractAssetUrlsFromHtml(html);
          await safeCacheAddAll(cache, assets);
        }
      } catch {
        /* ignore */
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  const data = event?.data || {};
  if (data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isCacheableRequest(request) {
  if (!request) return false;
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return false;
  return true;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((resp) => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || Response.error();
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put("/index.html", resp.clone());
    return resp;
  } catch {
    const cached = await cache.match("/index.html");
    if (cached) return cached;
    const core = await caches.open(CORE_CACHE);
    return (await core.match("/index.html")) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isCacheableRequest(request)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  const destination = request.destination;
  if (destination === "style" || destination === "font" || destination === "image" || destination === "script") {
    event.respondWith(staleWhileRevalidate(request));
  }
});
