// Wraps the Stockfish WASM worker (the "lite single-threaded" build — no
// SharedArrayBuffer / cross-origin-isolation headers needed, still far
// stronger than any human). Served from public/engine/, see its LICENSE.txt
// (GPLv3) for attribution.

const ENGINE_URL = "/engine/stockfish-19-lite-single.js";
const SEARCH_DEPTH = 16;
export const MULTIPV = 5;

// Chessground's own built-in brushes, already in a green (good) -> red (bad)
// gradient matching Lichess's own conventions — no custom brush needed.
export const RANK_BRUSHES = ["green", "paleGreen", "yellow", "paleRed", "red"] as const;

export interface EngineLine {
  move: string; // UCI, e.g. "e2e4" or "e7e8q"
  scoreCp: number | null;
  scoreMate: number | null;
}

export interface EngineAnalysis {
  lines: EngineLine[]; // ranked best (index 0) to worst, up to MULTIPV entries
  depth: number;
}

interface PendingSearch {
  id: number;
  resolve: (result: EngineAnalysis) => void;
}

export class Engine {
  private worker: Worker;
  private readyPromise: Promise<void>;
  private requestId = 0;
  private queue: PendingSearch[] = [];
  private linesByRank: Map<number, EngineLine> = new Map();
  private latestDepth = 0;

  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.readyPromise = new Promise((resolve) => {
      const onHandshake = (event: MessageEvent<string>): void => {
        if (event.data === "uciok") {
          this.worker.postMessage(`setoption name MultiPV value ${MULTIPV}`);
          this.worker.postMessage("isready");
        } else if (event.data === "readyok") {
          this.worker.removeEventListener("message", onHandshake);
          this.worker.addEventListener("message", this.handleMessage);
          resolve();
        }
      };
      this.worker.addEventListener("message", onHandshake);
      this.worker.postMessage("uci");
    });
  }

  private handleMessage = (event: MessageEvent<string>): void => {
    const line = event.data;
    if (line.startsWith("info") && line.includes(" pv ")) {
      const rankMatch = line.match(/multipv (\d+)/);
      const cp = line.match(/score cp (-?\d+)/);
      const mate = line.match(/score mate (-?\d+)/);
      const depth = line.match(/(?:^|\s)depth (\d+)/);
      const pv = line.match(/ pv (\S+)/);
      const rank = rankMatch ? Number(rankMatch[1]) : 1;
      if (depth) this.latestDepth = Number(depth[1]);
      if (pv) {
        this.linesByRank.set(rank, {
          move: pv[1],
          scoreCp: cp ? Number(cp[1]) : null,
          scoreMate: mate ? Number(mate[1]) : null,
        });
      }
    } else if (line.startsWith("bestmove")) {
      const entry = this.queue.shift();
      const lines = [...this.linesByRank.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
      const result: EngineAnalysis = { lines, depth: this.latestDepth };
      this.linesByRank = new Map();
      this.latestDepth = 0;
      // Only the most recently requested search's result is delivered;
      // results from searches superseded by a later analyze() call (and
      // told to "stop") are discarded here.
      if (entry && entry.id === this.requestId) entry.resolve(result);
    }
  };

  async analyze(fen: string): Promise<EngineAnalysis> {
    await this.readyPromise;
    const id = ++this.requestId;
    if (this.queue.length > 0) this.worker.postMessage("stop");
    return new Promise((resolve) => {
      this.queue.push({ id, resolve });
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go depth ${SEARCH_DEPTH}`);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export function uciMoveToKeys(uci: string): { orig: string; dest: string } {
  return { orig: uci.slice(0, 2), dest: uci.slice(2, 4) };
}

export function formatScore(line: EngineLine, sideToMoveIsWhite: boolean): string {
  const sign = sideToMoveIsWhite ? 1 : -1;
  if (line.scoreMate !== null) {
    const mate = line.scoreMate * sign;
    return `M${Math.abs(mate)}${mate < 0 ? " (against)" : ""}`;
  }
  if (line.scoreCp !== null) {
    const pawns = (line.scoreCp * sign) / 100;
    return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
  }
  return "?";
}
