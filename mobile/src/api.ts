// The backend's API, as the website uses it (backend/app): same origin,
// the same session cookie.

import type { BulletStats } from "@web/bulletStats";
import type { ExplorerSettings } from "@web/explorer";
import { addMove, deleteSubtree, type StudyTree } from "@web/tree";

import { send } from "./outbox";
import { applyAnswer, buildQueue, type PracticeState, seenAt, studyKnowledge } from "./practiceQueue";

export interface CalculationSettings {
  source?: "lichess" | "lirep";
  database?: "lichess" | "masters" | "player";
  minRating?: number | null;
  speeds?: string[];
  player?: string | null;
}

export interface StudyStats extends CalculationSettings {
  winProbability?: number;
  evalCp?: number;
  winProbabilityMovesFingerprint?: string;
  winProbabilityCalculatedAt?: string;
  evalMovesFingerprint?: string;
  evalCalculatedAt?: string;
  evalDepth?: number | null;
  evalSettings?: CalculationSettings;
  evalMethod?: number;
  evalMisses?: number;
  leafValue?: "explorer" | "stockfish" | "explorer-stockfish";
  scoreDepth?: number | null;
  nodesEvaluated?: number;
  explorerCalls?: number;
}

export interface Study {
  id: number;
  name: string;
  side: "white" | "black";
  tree: StudyTree;
  startNodeId: number | null;
  movesFingerprint?: string;
  stats?: StudyStats | null;
  archived?: boolean;
  explorerSettings?: ExplorerSettings | null;
  /** Why its stored moves can't be read (see the website's studyCard.ts). */
  broken?: string;
}

export interface PracticeSummary {
  totalItems: number;
  dueCount: number;
  newCount: number;
  aggregateKnowledge: number | null;
  bullet?: BulletStats;
}

export interface Attempt {
  streak?: number;
  knowledge?: number;
  /** It waits in the outbox (offline). */
  later?: boolean;
}

/** Thrown when the session has ended: the app then asks to sign in. */
export class SignedOut extends Error {}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) {
    kept.clear();
    throw new SignedOut();
  }
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

// The lists' answers are kept a minute in memory, so that going back to a
// tab doesn't wait for the network. What the app changes itself (answers,
// runs) drops the copies it makes stale.
const KEEP_MS = 60_000;
const kept = new Map<string, { at: number; data: Promise<unknown> }>();

function keptGet<T>(url: string): Promise<T> {
  const copy = kept.get(url);
  if (copy && Date.now() - copy.at < KEEP_MS) return copy.data as Promise<T>;
  const data = get<T>(url);
  kept.set(url, { at: Date.now(), data });
  data.catch(() => kept.get(url)?.data === data && kept.delete(url));
  return data;
}

/** Fetches the main tabs' data ahead, so the first switch is quick too. */
export function prefetch(): void {
  for (const load of [studies, practiceSummary, () => leaderboard("score")]) void load().catch(() => {});
}

export async function me(): Promise<{ authenticated: boolean; displayName?: string; preferences?: { badgeShine?: string; badgeIcons?: string } }> {
  return get("/api/me");
}

/** The account's studies, in its order, without the archived ones. */
export async function studies(): Promise<Study[]> {
  return (await keptGet<Study[]>("/api/studies")).filter((study) => !study.archived);
}

export const study = (id: number) => keptGet<Study>(`/api/studies/${id}`);

/** Puts `line` (from the initial position) into study `id` in place of
 * the move of yours where it leaves the prep, and of everything after that
 * move, as the website's Replace prep does; the study's tree as saved. The
 * study is read afresh first, so what was edited elsewhere meanwhile stays. */
export async function replacePrep(id: number, line: string[]): Promise<StudyTree> {
  const study = await get<Study>(`/api/studies/${id}`);
  const tree = study.tree;
  let nodeId = tree.rootId;
  let at = 0;
  for (; at < line.length; at++) {
    const next = tree.nodes[nodeId].children.find((child) => tree.nodes[child].san === line[at]);
    if (next === undefined) break;
    nodeId = next;
  }
  const yours = (at % 2 === 0) === (study.side === "white");
  const replaced = tree.nodes[nodeId].children;
  if (at === line.length || !yours || !replaced.length) {
    throw new Error("The study has changed meanwhile: this line no longer leaves its prep there. Nothing was saved.");
  }
  for (const child of [...replaced]) deleteSubtree(tree, child);
  for (const san of line.slice(at)) nodeId = addMove(tree, nodeId, san);
  // A starting point in what was deleted goes back to the default.
  const startNodeId = study.startNodeId !== null && study.startNodeId in tree.nodes ? study.startNodeId : null;
  let res: Response;
  try {
    res = await fetch(`/api/studies/${id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: study.name, tree, explorerSettings: study.explorerSettings ?? undefined, side: study.side, startNodeId }),
    });
  } catch {
    throw new Error("No connection: nothing was saved.");
  }
  if (res.status === 401) throw new Error("Signed out: sign in again to save.");
  if (!res.ok) throw new Error("The study couldn't be saved.");
  kept.delete(`/api/studies/${id}`);
  kept.delete("/api/studies");
  return tree;
}

export const practiceSummary = () => keptGet<Record<string, PracticeSummary>>("/api/practice/summary");

// The practice states the server last sent, by study: its copy may be one
// the service worker kept from before, offline.
const served = new Map<number, { items: number[]; states: Record<string, PracticeState> }>();

// The states after the answers made here that a copy from the server may
// not know of yet (sent or waiting in the outbox), by study, as the server
// will have them: the next rounds are built from them while offline, and
// the dots know the streak. Dropped once a copy from the server has them.
const LOCAL_KEY = "lirep-m-practice";
// Older ones are dropped anyway: the server takes late answers only from
// the last 7 days (backend/app/practice.py's LATE_ANSWER_MAX).
const LOCAL_KEEP_MS = 7 * 24 * 3600_000;
// The server stores an answer's time as the phone said, unless that's
// ahead of its own clock, by at most a minute.
const CLOCK_SKEW_MS = 60_000;

type Local = Record<string, Record<string, PracticeState>>;

function readLocal(): Local {
  try {
    localStorage.removeItem("lirep-m-answered"); // what came before these
    const local = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}");
    return local && typeof local === "object" ? local : {};
  } catch {
    return {};
  }
}

function writeLocal(local: Local): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
  } catch {
    // Storage blocked: offline, the next rounds may ask these again.
  }
}

/** Study `id`'s states, the answers made here included. */
function currentStates(id: number): Record<string, PracticeState> {
  return { ...served.get(id)?.states, ...readLocal()[String(id)] };
}

/** The positions to drill in the next round (see doc/practice.md); optional
 * when nothing is due or new, only review. The server's queue, unless
 * answers made here are missing from its copy (one kept offline): then
 * built here, the same way, with them. */
export async function practiceQueue(id: number): Promise<{ nodeIds: number[]; optional: boolean }> {
  const url = `/api/studies/${id}/practice/queue`;
  const queue = await get<{
    nodeIds: number[];
    optional?: boolean;
    items?: number[];
    states?: Record<string, PracticeState>;
  }>(url);
  const fromServer = { nodeIds: queue.nodeIds, optional: Boolean(queue.optional) };
  if (!queue.items || !queue.states) return fromServer; // a copy from before they were sent
  served.set(id, { items: queue.items, states: queue.states });
  const local = readLocal();
  const mine = local[String(id)] ?? {};
  for (const [nodeId, state] of Object.entries(mine)) {
    const server = queue.states[nodeId];
    const known = server && seenAt(server) >= seenAt(state) - CLOCK_SKEW_MS;
    if (known || Date.now() - seenAt(state) > LOCAL_KEEP_MS) delete mine[nodeId];
  }
  if (Object.keys(mine).length) local[String(id)] = mine;
  else delete local[String(id)];
  writeLocal(local);
  if (!Object.keys(mine).length) return fromServer;
  return buildQueue(queue.items, currentStates(id), Date.now());
}

/** Study `id`'s knowledge, 0..1 (null: nothing to know), with the answers
 * made here; from the summary before the session's queue is in. */
export async function practiceKnowledge(id: number): Promise<number | null | undefined> {
  const study = served.get(id);
  if (study) return studyKnowledge(study.items, currentStates(id), Date.now());
  return (await practiceSummary())[String(id)]?.aggregateKnowledge;
}

/** Records a first answer: the position's streak after it (the server's,
 * or, offline, as the server will have it; unknown without the states),
 * `later` if it waits in the outbox, or null if the server refused it. */
export async function recordAttempt(id: number, nodeId: number, correct: boolean): Promise<Attempt | null> {
  const at = new Date().toISOString();
  let streak: number | undefined;
  if (served.has(id)) {
    const after = { ...applyAnswer(currentStates(id)[nodeId], correct), lastSeenAt: at };
    streak = after.streak;
    const local = readLocal();
    (local[String(id)] ??= {})[String(nodeId)] = after;
    writeLocal(local);
  }
  const result = await send(`/api/studies/${id}/practice/attempt`, { nodeId, correct, answeredAt: at });
  kept.delete("/api/practice/summary");
  if (result.status === "offline") return { streak, later: true };
  if (result.status === "sent") return result.data as Attempt;
  const local = readLocal();
  delete local[String(id)]?.[String(nodeId)];
  writeLocal(local);
  return null;
}

/** Records a Bullet run (see bulletRun.ts): the updated stats, or null
 * (offline: it waits in the outbox). */
export async function recordRun(id: number, run: object): Promise<BulletStats | null> {
  const result = await send(`/api/studies/${id}/bullet/runs`, run);
  kept.delete("/api/practice/summary");
  return result.status === "sent" ? (result.data as BulletStats) : null;
}

/** A leaderboard's row (backend/app/community.py), by expected score or
 * evaluation. */
export interface Ranked {
  rank: number | null;
  id: number;
  name: string;
  side: "white" | "black";
  owner: string | null;
  mine: boolean;
  winProbability?: number | null;
  evalCp?: number | null;
  badge?: StudyStats;
}

/** The leaderboard by expected score ("score") or evaluation ("eval"). */
export const leaderboard = (by: "score" | "eval") =>
  keptGet<Ranked[]>(by === "score" ? "/api/community/openings" : "/api/community/openings-by-eval");

/** Signing in with Lichess, then back to where the app was. */
export function signInUrl(): string {
  return `/auth/login?next=${encodeURIComponent(`/m/${location.hash}`)}`;
}
