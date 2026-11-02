// The practice rules as the server has them (backend/app/practice.py,
// doc/practice.md §3 and §5): a position's knowledge, when it's due, what
// an answer does to it, and the queue. The app builds the next rounds with
// them while the server can't: offline, from the states it last sent and
// the answers made since. Keep the two in step.

export const TAU0_DAYS = 1;
export const RETENTION_FLOOR = 0.8;
export const SESSION_SIZE = 20;

const DAY_MS = 86_400_000;

/** A position's state, as the queue sends it. */
export interface PracticeState {
  streak: number;
  tauDays: number;
  /** ISO time, the server's (microseconds) or the phone's. */
  lastSeenAt: string;
}

/** `lastSeenAt` in ms (JavaScript keeps three of Python's six decimals). */
export function seenAt(state: PracticeState): number {
  return Date.parse(state.lastSeenAt.replace(/(\.\d{3})\d+/, "$1"));
}

function retention(state: PracticeState, now: number): number {
  return Math.exp(-(now - seenAt(state)) / DAY_MS / state.tauDays);
}

/** 0..1, or null if never answered. */
export function knowledge(state: PracticeState | undefined, now: number): number | null {
  return state ? (state.streak / 3) * retention(state, now) : null;
}

function isDue(state: PracticeState | undefined, now: number): boolean {
  return state !== undefined && retention(state, now) < RETENTION_FLOOR;
}

/** The streak and stability after an answer. */
export function applyAnswer(prev: PracticeState | undefined, correct: boolean): { streak: number; tauDays: number } {
  if (!correct) return { streak: 0, tauDays: TAU0_DAYS };
  if (!prev) return { streak: 1, tauDays: TAU0_DAYS };
  return { streak: Math.min(prev.streak + 1, 3), tauDays: prev.tauDays * 2 };
}

/** The study's knowledge: the mean over its positions, the new ones at 0. */
export function studyKnowledge(items: number[], states: Record<string, PracticeState>, now: number): number | null {
  if (!items.length) return null;
  return items.reduce((sum, nodeId) => sum + (knowledge(states[nodeId], now) ?? 0), 0) / items.length;
}

/** The next round: due positions (longest unseen first), then new ones,
 * in tree order; if none, optional review of what isn't at 100%, or of
 * everything when all is. */
export function buildQueue(
  items: number[],
  states: Record<string, PracticeState>,
  now: number,
): { nodeIds: number[]; optional: boolean } {
  const bySeen = (a: number, b: number) => seenAt(states[a]) - seenAt(states[b]);
  const due = items.filter((nodeId) => isDue(states[nodeId], now)).sort(bySeen);
  const fresh = items.filter((nodeId) => !states[nodeId]);
  let queue = [...due, ...fresh];
  const optional = !queue.length;
  if (optional && items.length) {
    const notFull = items.filter((nodeId) => Math.round((knowledge(states[nodeId], now) ?? 0) * 100) < 100);
    queue = (notFull.length ? notFull : [...items]).sort(bySeen);
  }
  return { nodeIds: queue.slice(0, SESSION_SIZE), optional };
}
