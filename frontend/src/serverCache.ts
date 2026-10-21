// Server storage for Stockfish and Explorer data (backend/app/cache.py), for
// the users allowed it: behind the browser's own caches (explorerClient.ts,
// evalCache.ts), it is asked for what they lack and given what they gain.
// Requests are batched: what is asked or saved within a moment goes in one.

import type { ExplorerData } from "./explorer";

const BATCH_MS = 20;
const MAX_BATCH = 500; // cache.py's MAX_BATCH

let enabledPromise: Promise<boolean> | null = null;

/** Whether this account keeps its data on the server (asked once per page). */
export function serverCacheEnabled(): Promise<boolean> {
  enabledPromise ??= fetch("/api/me", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : {}))
    .then((me: { serverCache?: boolean }) => Boolean(me.serverCache))
    .catch(() => false);
  return enabledPromise;
}

/** Items added within BATCH_MS of each other, sent together; `send`
 * answers each item in order (undefined: unknown). A failed request
 * answers undefined: the server is a convenience, never in the way. */
function batcher<T, R>(send: (items: T[]) => Promise<(R | undefined)[]>): (item: T) => Promise<R | undefined> {
  let pending: { item: T; resolve: (r: R | undefined) => void }[] = [];
  let timer: number | null = null;
  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      const part = batch.slice(i, i + MAX_BATCH);
      send(part.map((p) => p.item))
        .then((results) => part.forEach((p, j) => p.resolve(results[j])))
        .catch(() => part.forEach((p) => p.resolve(undefined)));
    }
  };
  return (item) =>
    new Promise((resolve) => {
      pending.push({ item, resolve });
      timer ??= window.setTimeout(flush, BATCH_MS);
    });
}

async function post(url: string, method: "POST" | "PUT", body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

export interface ServerExplorerEntry {
  data: ExplorerData;
  fetchedAt: number; // ms since the epoch
}

// What the server lacked, not asked again during this page visit: what is
// fetched or evaluated later is in the browser's cache by then.
const explorerMisses = new Set<string>();
const evalMisses = new Set<string>();

/** The server's Explorer answer under the browser's cache key, if any. */
export async function serverExplorerGet(key: string): Promise<ServerExplorerEntry | undefined> {
  if (explorerMisses.has(key)) return undefined;
  const entry = await explorerGet(key);
  if (!entry) explorerMisses.add(key);
  return entry;
}

const explorerGet = batcher<string, ServerExplorerEntry>(async (keys) => {
  const { entries } = (await post("/api/cache/explorer/lookup", "POST", { keys })) as {
    entries: Record<string, ServerExplorerEntry>;
  };
  return keys.map((key) => entries[key]);
});

const explorerPut = batcher<{ key: string } & ServerExplorerEntry, true>(async (entries) => {
  await post("/api/cache/explorer", "PUT", { entries });
  return entries.map(() => true);
});

export function serverExplorerSet(key: string, data: ExplorerData, fetchedAt: number): void {
  void explorerPut({ key, data, fetchedAt });
}

/** The server's evaluation of `fen` at `depth`, in centipawns from White's
 * point of view, if any. */
export async function serverEvalGet(fen: string, depth: number): Promise<number | undefined> {
  const key = `${fen}|${depth}`;
  if (evalMisses.has(key)) return undefined;
  const cp = await evalGet({ fen, depth });
  if (cp === undefined) evalMisses.add(key);
  return cp;
}

const evalGet = batcher<{ fen: string; depth: number }, number>(async (positions) => {
  const { evals } = (await post("/api/cache/evals/lookup", "POST", { positions })) as {
    evals: { fen: string; depth: number; cp: number }[];
  };
  const found = new Map(evals.map((e) => [`${e.fen}|${e.depth}`, e.cp]));
  return positions.map((p) => found.get(`${p.fen}|${p.depth}`));
});

const evalPut = batcher<{ fen: string; depth: number; cp: number }, true>(async (evals) => {
  await post("/api/cache/evals", "PUT", { evals });
  return evals.map(() => true);
});

export function serverEvalSet(fen: string, depth: number, cp: number): void {
  void evalPut({ fen, depth, cp: Math.round(cp) });
}
