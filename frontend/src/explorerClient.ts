// Opening Explorer data for the browser. Lichess's Explorer is queried
// directly from here, with the user's own token, so each user's requests
// count against their own rate limit rather than against lirep.org's server
// (whose single IP address every user would otherwise share). The local
// Lirep Explorer (the 2016 sample) is still reached through the backend.
//
// Requests to Lichess are paced: one at a time, at least
// EXPLORER_REQUEST_GAP_MS apart, and after a 429 everything waits
// RATE_LIMIT_PAUSE_MS, as Lichess's API guidelines ask. Responses are cached
// in IndexedDB (see explorer-cache.md).

import { lirepExplorerUrl, type ExplorerData, type ExplorerSettings } from "./explorer";

/** Minimum pause between two requests to Lichess's Opening Explorer. */
export const EXPLORER_REQUEST_GAP_MS = 500;
/** How long to wait after Lichess answers 429 (rate limited). */
export const RATE_LIMIT_PAUSE_MS = 60_000;
/** How long to keep reading the player database's streamed answer. */
const PLAYER_STREAM_MS = 25_000;
/** Cache lifetimes: move statistics change slowly, one player's games daily. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PLAYER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const LICHESS_EXPLORER = "https://explorer.lichess.org";
// The Explorer's rating buckets (backend/app/explorer.py's RATING_BUCKETS):
// a minimum rating selects its bucket and every one above it.
const RATING_BUCKETS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
// What a study saved before minRating was always set falls back to.
const DEFAULT_MIN_RATING = 1400;

/** "interactive" (the panel next to the board) goes ahead of "background"
 * (a calculation walking a whole tree), and fails fast instead of waiting
 * out a rate-limit pause. */
export type ExplorerPriority = "interactive" | "background";

export interface ExplorerFetchOptions {
  priority?: ExplorerPriority;
  /** Called when a background request waits out a rate-limit pause. */
  onRateLimited?: (resumeAt: number) => void;
}

export class ExplorerError extends Error {}

/** A message fit to show: the client's own errors are written for users. */
export function errorMessage(err: unknown): string | undefined {
  return err instanceof ExplorerError ? err.message : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Lichess token --------------------------------------------------------

let tokenPromise: Promise<string> | null = null;

function lichessToken(): Promise<string> {
  tokenPromise ??= fetch("/api/lichess-token", { credentials: "same-origin" }).then(async (res) => {
    if (!res.ok) {
      tokenPromise = null;
      throw new ExplorerError("Sign in with Lichess to see Opening Explorer data.");
    }
    return ((await res.json()) as { token: string }).token;
  });
  return tokenPromise;
}

// --- Pacing ---------------------------------------------------------------

let busy = false;
let lastRequestAt = 0;
let pausedUntil = 0;
const waiting: { priority: ExplorerPriority; start: () => void }[] = [];

// One Lichess request at a time; interactive requests jump the queue.
function acquire(priority: ExplorerPriority): Promise<void> {
  if (!busy) {
    busy = true;
    return Promise.resolve();
  }
  return new Promise((start) => {
    const entry = { priority, start };
    const firstBackground = waiting.findIndex((w) => w.priority === "background");
    if (priority === "interactive" && firstBackground >= 0) waiting.splice(firstBackground, 0, entry);
    else waiting.push(entry);
  });
}

function release(): void {
  lastRequestAt = Date.now();
  const next = waiting.shift();
  if (next) next.start();
  else busy = false;
}

const rateLimitedMessage = "Lichess's Opening Explorer is rate-limiting requests; please wait a minute.";

// A paced GET to Lichess's Explorer. Retries once after a rate-limit pause
// (background requests only).
async function lichessGet(
  path: string,
  params: Record<string, string>,
  options: ExplorerFetchOptions,
  read: (res: Response) => Promise<unknown>,
): Promise<unknown> {
  const priority = options.priority ?? "background";
  const url = `${LICHESS_EXPLORER}/${path}?${new URLSearchParams(params)}`;
  const token = await lichessToken();
  for (let attempt = 0; ; attempt++) {
    if (priority === "interactive" && pausedUntil > Date.now()) throw new ExplorerError(rateLimitedMessage);
    await acquire(priority);
    let res: Response;
    try {
      await sleep(Math.max(0, pausedUntil - Date.now(), lastRequestAt + EXPLORER_REQUEST_GAP_MS - Date.now()));
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        throw new ExplorerError("Could not reach Lichess's Opening Explorer.");
      }
      if (res.status !== 429) return await read(res);
      pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
    } finally {
      release();
    }
    if (priority === "interactive" || attempt > 0) throw new ExplorerError(rateLimitedMessage);
    options.onRateLimited?.(pausedUntil);
  }
}

function checkStatus(res: Response, player?: string): void {
  if (res.status === 404 && player) throw new ExplorerError(`Lichess has no player named ${player}.`);
  if (res.status === 401) {
    tokenPromise = null;
    throw new ExplorerError("Lichess refused the request; please sign out and sign in again.");
  }
  if (!res.ok) throw new ExplorerError(`Lichess's Opening Explorer answered ${res.status}.`);
}

// The player database streams NDJSON while it indexes the player's recent
// games; the last line received is the most complete picture. Stop reading
// after PLAYER_STREAM_MS and use what has arrived.
async function readLastNdjsonLine(res: Response): Promise<unknown> {
  if (!res.body) return res.json();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + PLAYER_STREAM_MS;
  let buffer = "";
  let last: unknown = undefined;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void reader.cancel();
      break;
    }
    const chunk = await Promise.race([reader.read(), sleep(remaining).then(() => null)]);
    if (chunk === null || chunk.done) {
      if (chunk === null) void reader.cancel();
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) last = JSON.parse(line);
  }
  if (buffer.trim()) last = JSON.parse(buffer);
  if (last === undefined) throw new ExplorerError("Lichess's player explorer did not answer in time.");
  return last;
}

// --- Cache ----------------------------------------------------------------

interface CachedResponse {
  data: ExplorerData;
  fetchedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openCache(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open("lirep-explorer", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("responses");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null); // blocked storage: this page visit still works, uncached
    }
  });
  return dbPromise;
}

async function cacheGet(key: string, ttl: number): Promise<ExplorerData | undefined> {
  const db = await openCache();
  if (!db) return undefined;
  const entry = await new Promise<CachedResponse | undefined>((resolve) => {
    const request = db.transaction("responses", "readonly").objectStore("responses").get(key);
    request.onsuccess = () => resolve(request.result as CachedResponse | undefined);
    request.onerror = () => resolve(undefined);
  });
  return entry && Date.now() - entry.fetchedAt <= ttl ? entry.data : undefined;
}

async function cacheSet(key: string, data: ExplorerData): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction("responses", "readwrite");
    transaction.objectStore("responses").put({ data, fetchedAt: Date.parse(data.fetchedAt) } satisfies CachedResponse, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
  });
}

// --- Shaping --------------------------------------------------------------

interface RawExplorerMove {
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number | null;
}

interface RawExplorerResponse {
  white?: number;
  draws?: number;
  black?: number;
  opening?: { name: string } | null;
  moves?: RawExplorerMove[];
}

function shape(raw: RawExplorerResponse, settings: ExplorerSettings, minRating: number | null, side: "white" | "black"): ExplorerData {
  const data: ExplorerData = {
    source: "lichess",
    database: settings.database,
    minRating: settings.database === "lichess" ? minRating : null,
    opening: raw.opening?.name ?? null,
    totals: { white: raw.white ?? 0, draws: raw.draws ?? 0, black: raw.black ?? 0 },
    moves: (raw.moves ?? []).map((m) => ({
      san: m.san,
      white: m.white,
      draws: m.draws,
      black: m.black,
      averageRating: m.averageRating ?? null,
    })),
    fetchedAt: new Date().toISOString(),
  };
  if (settings.database === "player") {
    data.player = settings.player ?? null;
    data.color = side;
  }
  return data;
}

// --- Public API -----------------------------------------------------------

const inflight = new Map<string, Promise<ExplorerData>>();

/** The Opening Explorer's data for `fen`, under a study's Explorer settings,
 * from this browser's cache, Lichess's Explorer (paced), or for the 2016
 * sample, the backend. */
export async function fetchExplorerData(
  fen: string,
  settings: ExplorerSettings,
  side: "white" | "black",
  options: ExplorerFetchOptions = {},
): Promise<ExplorerData> {
  if (settings.source === "lirep" && settings.database !== "player") {
    const res = await fetch(lirepExplorerUrl(fen, settings), { credentials: "same-origin" });
    if (!res.ok) throw new ExplorerError("The 2016-sample Explorer is unavailable right now.");
    return res.json();
  }

  const minRating = settings.minRating ?? DEFAULT_MIN_RATING;
  const speeds = settings.speeds.join(",");
  const ratings = RATING_BUCKETS.filter((b) => b >= minRating).join(",");
  const key =
    settings.database === "masters"
      ? `masters|${fen}`
      : settings.database === "player"
        ? `player|${(settings.player ?? "").toLowerCase()}|${side}|${speeds}|${fen}`
        : `lichess|${ratings}|${speeds}|${fen}`;
  const ttl = settings.database === "player" ? PLAYER_CACHE_TTL_MS : CACHE_TTL_MS;

  const cached = await cacheGet(key, ttl);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    let raw: unknown;
    if (settings.database === "masters") {
      raw = await lichessGet("masters", { fen }, options, async (res) => (checkStatus(res), res.json()));
    } else if (settings.database === "player") {
      if (!settings.player) throw new ExplorerError("Choose whose games to use.");
      const params = { player: settings.player, color: side, fen, speeds, recentGames: "0" };
      raw = await lichessGet("player", params, options, async (res) => (checkStatus(res, settings.player!), readLastNdjsonLine(res)));
    } else {
      raw = await lichessGet("lichess", { fen, speeds, ratings }, options, async (res) => (checkStatus(res), res.json()));
    }
    const data = shape(raw as RawExplorerResponse, settings, minRating, side);
    await cacheSet(key, data);
    return data;
  })();
  inflight.set(key, request);
  try {
    return await request;
  } finally {
    inflight.delete(key);
  }
}
