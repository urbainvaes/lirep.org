// The mobile app's service worker (registered by src/main.ts, for /m/): it
// keeps what the app last loaded, so that it opens and works offline.
//
// - The app's page: from the network, else the copy kept.
// - Its scripts and styles (hashed names), the site's fonts and icons,
//   Stockfish, and the board's images and sounds from Lichess's CDN: kept
//   once fetched, then served from the copy.
// - The API's answers (studies, practice, queues): from the network, else,
//   offline or after a few seconds without an answer, the copy kept.
//   Signing out (a 401 or a signed-out /api/me answer) drops them.
// - Sign-in, and anything sent (answers, runs: see src/outbox.ts), go to
//   the network only.

const VERSION = 3;
const SHELL = `lirep-m-shell-${VERSION}`;
const ASSETS = `lirep-m-assets-${VERSION}`;
const DATA = `lirep-m-data-${VERSION}`;
const API_TIMEOUT_MS = 4000;
let dataGeneration = 0;
let signedOut = false;

function mayStore(response) {
  return !/\bno-store\b/i.test(response.headers.get("Cache-Control") || "");
}

function cachedApi(path) {
  return /^\/api\/(me|studies(?:\/\d+(?:\/practice\/queue)?)?|practice\/summary|community\/openings(?:-by-eval)?)$/.test(path);
}

async function dropData() {
  signedOut = true;
  dataGeneration += 1;
  await caches.delete(DATA);
}

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
  // A copy kept from a no-CORS request (a board's piece images) is opaque,
  // and the browser refuses it for a CORS one (a badge's piece, a CSS
  // mask): then from the network, and that copy, readable by both, is kept.
  if (cached && !(cached.type === "opaque" && request.mode !== "no-cors")) return cached;
  const response = await fetch(request);
  if ((response.ok || response.type === "opaque") && mayStore(response)) {
    const copy = response.clone();
    caches.open(ASSETS).then((cache) => cache.put(request, copy));
  }
  return response;
}

async function fromNetworkFirst(request, cacheName, timeoutMs, fallback, event) {
  const cache = await caches.open(cacheName);
  const generation = dataGeneration;
  const isData = cacheName === DATA;
  const network = fetch(request).then(async (response) => {
    if (isData && response.status === 401) {
      await dropData();
      return response;
    }
    if (isData && new URL(request.url).pathname === "/api/me" && response.ok) {
      const me = await response.clone().json();
      if (me.authenticated === false) {
        await dropData();
        return response;
      }
      if (me.authenticated === true && generation === dataGeneration) signedOut = false;
    }
    try {
      if (!mayStore(response)) await cache.delete(request);
      else if (response.ok && (!isData || (!signedOut && generation === dataGeneration))) {
        await cache.put(request, response.clone());
        // A simultaneous sign-out may have happened while put() was pending.
        if (isData && (signedOut || generation !== dataGeneration)) await cache.delete(request);
      }
    } catch {
      // A full/blocked cache must not hide a successful network answer.
    }
    return response;
  });
  network.catch(() => {}); // answered from the copy: a late failure is no matter
  event?.waitUntil(network.catch(() => {}));
  const cached = async (key) => {
    if (isData && (signedOut || generation !== dataGeneration)) return undefined;
    const response = await cache.match(key);
    return isData && (signedOut || generation !== dataGeneration) ? undefined : response;
  };
  const timeout = timeoutMs
    ? new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    : new Promise(() => {});
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // Too slow: the copy if there is one, else keep waiting.
    return (await cached(request)) ?? (await network);
  } catch {
    return (await cached(request)) ?? (fallback && (await cached(fallback))) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/auth/")) return;
    if (url.pathname.startsWith("/api/")) {
      // Credentials and unknown future endpoints are network-only, even if
      // they happen to return a successful GET.
      if (cachedApi(url.pathname)) event.respondWith(fromNetworkFirst(request, DATA, API_TIMEOUT_MS, undefined, event));
      return;
    }
    if (/^\/(m\/assets|fonts|engine)\//.test(url.pathname) || /^\/(icon-|favicon|apple-touch-icon)/.test(url.pathname)) {
      event.respondWith(fromCacheFirst(request));
      return;
    }
    if (request.mode === "navigate" || url.pathname.startsWith("/m/")) {
      event.respondWith(fromNetworkFirst(request, SHELL, 0, "/m/", event));
    }
    return;
  }
  // The board's images and sounds. An audio element asks for a range of
  // the file, which a whole copy from here doesn't answer (Safari then
  // plays nothing): it goes to the network, the sounds' copies here being
  // for the board's Web Audio (src/board.ts).
  if (url.hostname === "lichess1.org" && !request.headers.has("range")) event.respondWith(fromCacheFirst(request));
});
