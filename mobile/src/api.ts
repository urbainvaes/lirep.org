// The backend's API, as the website uses it (backend/app): same origin,
// the same session cookie.

import type { BulletStats } from "@web/bulletStats";
import type { ExplorerSettings } from "@web/explorer";
import type { StudyTree } from "@web/tree";

import { send } from "./outbox";

export interface StudyStats {
  winProbability?: number;
  evalCp?: number;
}

export interface Study {
  id: number;
  name: string;
  side: "white" | "black";
  tree: StudyTree;
  startNodeId: number | null;
  stats?: StudyStats | null;
  archived?: boolean;
  explorerSettings?: ExplorerSettings | null;
}

export interface PracticeSummary {
  totalItems: number;
  dueCount: number;
  newCount: number;
  aggregateKnowledge: number | null;
  bullet?: BulletStats;
}

export interface Attempt {
  streak: number;
  knowledge: number;
}

/** Thrown when the session has ended: the app then asks to sign in. */
export class SignedOut extends Error {}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function me(): Promise<{ authenticated: boolean; displayName?: string }> {
  return get("/api/me");
}

/** The account's studies, in its order, without the archived ones. */
export async function studies(): Promise<Study[]> {
  return (await get<Study[]>("/api/studies")).filter((study) => !study.archived);
}

export const study = (id: number) => get<Study>(`/api/studies/${id}`);

export const practiceSummary = () => get<Record<string, PracticeSummary>>("/api/practice/summary");

/** The positions to drill in the next round (see practice.md). */
export async function practiceQueue(id: number): Promise<number[]> {
  return (await get<{ nodeIds: number[] }>(`/api/studies/${id}/practice/queue`)).nodeIds;
}

/** Records a first answer: the server's result, "later" if it waits in
 * the outbox (offline), or null if the server refused it. */
export async function recordAttempt(id: number, nodeId: number, correct: boolean): Promise<Attempt | "later" | null> {
  const result = await send(`/api/studies/${id}/practice/attempt`, {
    nodeId,
    correct,
    answeredAt: new Date().toISOString(),
  });
  if (result.status === "offline") return "later";
  return result.status === "sent" ? (result.data as Attempt) : null;
}

/** Records a Bullet run (see bulletRun.ts): the updated stats, or null
 * (offline: it waits in the outbox). */
export async function recordRun(id: number, run: object): Promise<BulletStats | null> {
  const result = await send(`/api/studies/${id}/bullet/runs`, run);
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
  get<Ranked[]>(by === "score" ? "/api/community/openings" : "/api/community/openings-by-eval");

/** Signing in with Lichess, then back to where the app was. */
export function signInUrl(): string {
  return `/auth/login?next=${encodeURIComponent(`/m/${location.hash}`)}`;
}
