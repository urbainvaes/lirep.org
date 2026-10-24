// The mobile app's service worker (registered by src/main.ts, for /m/): it
// keeps what the app last loaded, so that it opens and works offline.
//
// - The app's page: from the network, else the copy kept.
// - Its scripts and styles (hashed names), the site's fonts and icons,
//   Stockfish, and the board's images and sounds from Lichess's CDN: kept
//   once fetched, then served from the copy.
// - The API's answers (studies, practice, queues): from the network, else,
//   offline or after a few seconds without an answer, the copy kept.
//   Signing out (a 401) drops them.
// - Sign-in, and anything sent (answers, runs: see src/outbox.ts), go to
//   the network only.

const VERSION = 1;
const SHELL = `lirep-m-shell-${VERSION}`;
const ASSETS = `lirep-m-assets-${VERSION}`;
const DATA = `lirep-m-data-${VERSION}`;
const API_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/m/", "/m/manifest.webmanifest"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Caches of an earlier version of this file go.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lirep-m-") && ![SHELL, ASSETS, DATA].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromCacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === "opaque") {
    const copy = response.clone();
    caches.open(ASSETS).then((cache) => cache.put(request, copy));
  }
  return response;
}

async function fromNetworkFirst(request, cacheName, timeoutMs, fallback) {
  const cache = await caches.open(cacheName);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    else if (response.status === 401) caches.delete(DATA);
    return response;
  });
  network.catch(() => {}); // answered from the copy: a late failure is no matter
  const timeout = timeoutMs
    ? new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    : new Promise(() => {});
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // Too slow: the copy if there is one, else keep waiting.
    return (await cache.match(request)) ?? (await network);
  } catch {
    return (await cache.match(request)) ?? (fallback && (await cache.match(fallback))) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/auth/")) return;
    if (url.pathname.startsWith("/api/")) {
      event.respondWith(fromNetworkFirst(request, DATA, API_TIMEOUT_MS));
      return;
    }
    if (/^\/(m\/assets|fonts|engine)\//.test(url.pathname) || /^\/(icon-|favicon|apple-touch-icon)/.test(url.pathname)) {
      event.respondWith(fromCacheFirst(request));
      return;
    }
    if (request.mode === "navigate" || url.pathname.startsWith("/m/")) {
      event.respondWith(fromNetworkFirst(request, SHELL, 0, "/m/"));
    }
    return;
  }
  // The board's images and sounds.
  if (url.hostname === "lichess1.org") event.respondWith(fromCacheFirst(request));
});
