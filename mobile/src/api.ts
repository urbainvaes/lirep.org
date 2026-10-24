// The backend's API, as the website uses it (backend/app): same origin,
// the same session cookie.

import type { StudyTree } from "@web/tree";

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
}

export interface PracticeSummary {
  totalItems: number;
  dueCount: number;
  newCount: number;
  aggregateKnowledge: number | null;
  bullet?: { runs: number; successes: number };
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

/** Records a first answer; null if it couldn't be saved. */
export async function recordAttempt(id: number, nodeId: number, correct: boolean): Promise<Attempt | null> {
  try {
    const res = await fetch(`/api/studies/${id}/practice/attempt`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, correct }),
    });
    return res.ok ? ((await res.json()) as Attempt) : null;
  } catch {
    return null;
  }
}

/** Signing in with Lichess, then back to where the app was. */
export function signInUrl(): string {
  return `/auth/login?next=${encodeURIComponent(`/m/${location.hash}`)}`;
}
