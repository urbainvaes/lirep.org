import { Chess } from "chess.js";

import { DEFAULT_SEARCH_DEPTH, type Engine, type EngineLine } from "./engine";
import { MATE_SCORE_CP } from "./expectedScore";

/** The Stockfish depths the Stats page offers for its evaluations; the
 * editor's figures use the same one. */
export const EVAL_DEPTHS = [8, 12, DEFAULT_SEARCH_DEPTH] as const;
export const EVAL_DEPTH_STORAGE_KEY = "stats-evaluation-depth";

/** The depth last chosen on a Stats page, in this browser. */
export function getSavedEvalDepth(): number {
  try {
    const depth = Number(localStorage.getItem(EVAL_DEPTH_STORAGE_KEY));
    return EVAL_DEPTHS.includes(depth as (typeof EVAL_DEPTHS)[number]) ? depth : DEFAULT_SEARCH_DEPTH;
  } catch {
    return DEFAULT_SEARCH_DEPTH;
  }
}

// Actual game-over positions on the board — checkmate gets a flat mate cap
// (no distance), matching the backend's own terminal-position handling.
// chess.js's isDraw() also covers stalemate, insufficient material,
// threefold repetition, and the 50-move rule, so all of those are handled
// here too rather than falling through to the engine.
function terminalCp(chess: Chess): number | null {
  if (chess.isCheckmate()) return chess.turn() === "w" ? -MATE_SCORE_CP : MATE_SCORE_CP;
  if (chess.isDraw()) return 0;
  return null;
}

// A "mate in N" reported by the engine (not yet on the board) gets the same
// distance-sensitive cap used for all position evaluations.
function mateToCappedCp(mateWhitePov: number): number {
  const magnitude = MATE_SCORE_CP - Math.abs(mateWhitePov);
  return mateWhitePov > 0 ? magnitude : -magnitude;
}

// Centipawns (White's POV), from the engine's best line at this position —
// same conversion regardless of whether the position is a tree node or an
// off-tree continuation, since a position's eval doesn't care which.
export async function evaluatePosition(engine: Engine, chess: Chess, depth: number): Promise<number | null> {
  const terminal = terminalCp(chess);
  if (terminal !== null) return terminal;
  const analysis = await engine.analyze(chess.fen(), depth);
  const best: EngineLine | undefined = analysis.lines[0];
  const sign = chess.turn() === "w" ? 1 : -1;
  if (best?.scoreMate != null) return mateToCappedCp(best.scoreMate * sign);
  if (best?.scoreCp != null) return best.scoreCp * sign;
  return null;
}


export interface EvaluationCache {
  persistent: boolean;
  get(fen: string, depth: number): Promise<number | undefined>;
  set(fen: string, depth: number, cp: number): Promise<void>;
}

export async function openEvaluationCache(username: string): Promise<EvaluationCache> {
  const memory = new Map<string, number>();
  let db: IDBDatabase | null = null;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lirep-position-evals", 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        const transaction = request.transaction;
        if (!database.objectStoreNames.contains("positions")) database.createObjectStore("positions");
        else if (transaction) {
          const store = transaction.objectStore("positions");
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const key = cursor.primaryKey;
            if (Array.isArray(key) && key.length === 2) {
              const value = cursor.value;
              const next = cursor.continue.bind(cursor);
              cursor.delete();
              store.put(value, [...key, DEFAULT_SEARCH_DEPTH]);
              next();
              return;
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    // Browsers that block IndexedDB can still calculate during this page visit.
  }

  const database = db;
  return {
    persistent: database !== null,
    async get(fen, depth) {
      const key = `${fen}|${depth}`;
      if (memory.has(key)) return memory.get(key);
      if (!database) return undefined;
      const value = await new Promise<number | undefined>((resolve, reject) => {
        const request = database.transaction("positions", "readonly").objectStore("positions").get([username, fen, depth]);
        request.onsuccess = () => resolve(request.result as number | undefined);
        request.onerror = () => reject(request.error);
      });
      if (value !== undefined) memory.set(key, value);
      return value;
    },
    async set(fen, depth, cp) {
      const key = `${fen}|${depth}`;
      if (database) {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("positions", "readwrite");
          transaction.objectStore("positions").put(cp, [username, fen, depth]);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      }
      memory.set(key, cp);
    },
  };
}
