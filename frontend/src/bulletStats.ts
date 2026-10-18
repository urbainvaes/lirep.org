// Bullet practice's stats (see bullet.ts), apart so that the Practice page
// can show them without loading the board.

/** Successes out of all runs, out of the most recent ones, and in the
 * last month (30 days). */
export interface BulletStats {
  runs: number;
  successes: number;
  recentRuns: number;
  recentSuccesses: number;
  monthSuccesses: number;
}

// Kept in step with BULLET_RECENT_RUNS in backend/app/practice.py.
export const BULLET_RECENT_RUNS = 30;

export function statsLine(stats: BulletStats): string {
  if (!stats.runs) return "No runs yet";
  return `${stats.successes} / ${stats.runs} · last ${BULLET_RECENT_RUNS}: ${stats.recentSuccesses} / ${stats.recentRuns}`;
}
