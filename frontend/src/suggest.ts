// Suggested moves: the editor's 💡 window. Adds the studied side's moves to a
// copy of the study one at a time, each time the one that raises the
// expected score most (tools/optimal_repertoire.py does the same from the
// command line). The expected score is the Stats page's (see
// expectedScore.ts): the prepared move is the first child, a line ends with
// its last answered move, and `leafValue` says what a line's end is worth.
//
// An addition answers an opponent reply the study leaves unanswered, after
// one of your moves inside a line or after a line's last move (extending
// it), with one of your most played moves there. Only the positions next to
// the study are needed, so it is fast, but not always optimal: a move worth
// little alone, but much with the next one, is missed.

import { Chess } from "chess.js";

import { MIN_LEAF_GAMES, type ExplorerData, type ExplorerMove, type LeafValue } from "./explorer";
import { scoreFromCp } from "./expectedScore";
import { addMove, sanPathTo, type StudyTree } from "./tree";

export interface SuggestOptions {
  side: "white" | "black";
  startNodeId: number;
  leafValue: LeafValue;
  candidates: number; // your most played moves considered in a position
  minGames: number; // games a move needs to be a candidate
  minReach: number; // replies reached by fewer than this share of games aren't answered
  // The winning chances (−1 to 1, Lichess's curve) a candidate may lose
  // against Stockfish's best move; null: any move.
  maxLoss: number | null;
  explorer: (fen: string) => Promise<ExplorerData>;
  // Stockfish's evaluation in centipawns, White's point of view (null: none).
  evaluate: (fen: string) => Promise<number | null>;
  // What it is doing, for a status line.
  onStatus?: (text: string) => void;
}

export interface Suggestion {
  line: string[]; // SAN from the initial position, ending with your new move
  reply: string; // the opponent's move it answers ("" for the first move)
  move: string;
  score: number; // the expected score with it (and the earlier suggestions)
  gain: number;
}

// An opponent's turn in the study: its node (the move leading to it), the
// share of games reaching it, and, if the line ends with the move before it
// (no reply answered), that line's value. Or (`own`) your turn at the
// starting point, with no move of yours yet: `ended` is its value.
interface Turn {
  nodeId: number;
  chess: Chess;
  reach: number;
  ended: number | null;
  own?: boolean;
}

const games = (m: { white: number; draws: number; black: number }) => m.white + m.draws + m.black;

function finished(chess: Chess): boolean {
  return chess.isCheckmate() || chess.isStalemate() || chess.isInsufficientMaterial();
}

function after(chess: Chess, san: string): Chess {
  const next = new Chess(chess.fen());
  next.move(san);
  return next;
}

export class Suggester {
  readonly tree: StudyTree; // the study's copy, with the suggestions
  private readonly data = new Map<string, ExplorerData>();
  private readonly evals = new Map<string, number>();

  constructor(
    tree: StudyTree,
    private readonly o: SuggestOptions,
  ) {
    this.tree = JSON.parse(JSON.stringify(tree)) as StudyTree;
  }

  // -- Values, as on the Stats page --------------------------------------

  private async explorer(fen: string): Promise<ExplorerData> {
    let data = this.data.get(fen);
    if (!data) {
      data = await this.o.explorer(fen);
      this.data.set(fen, data);
    }
    return data;
  }

  private async stockfish(chess: Chess): Promise<number> {
    const fen = chess.fen();
    let score = this.evals.get(fen);
    if (score === undefined) {
      const white = (await this.o.evaluate(fen)) ?? 0;
      score = scoreFromCp(this.o.side === "white" ? white : -white);
      this.evals.set(fen, score);
    }
    return score;
  }

  private explorerScore(row: { white: number; draws: number; black: number }): number {
    const n = games(row);
    if (!n) return 0.5;
    const wins = this.o.side === "white" ? row.white : row.black;
    return (wins + row.draws / 2) / n;
  }

  /** A move's own results (`row`), or Stockfish's value of the position it
   * leads to (`next`), as `leafValue` says. */
  private async leaf(row: ExplorerMove | { white: number; draws: number; black: number } | undefined, next: Chess): Promise<number> {
    if (this.o.leafValue === "stockfish") return this.stockfish(next);
    if (this.o.leafValue === "explorer-stockfish" && (!row || games(row) < MIN_LEAF_GAMES)) return this.stockfish(next);
    return row ? this.explorerScore(row) : 0.5;
  }

  private studiedToMove(chess: Chess): boolean {
    return (chess.turn() === "w") === (this.o.side === "white");
  }

  private answered(nodeId: number, chess: Chess): boolean {
    return this.tree.nodes[nodeId].children.length > 0 || finished(chess);
  }

  private goesOn(nodeId: number, chess: Chess): boolean {
    return this.tree.nodes[nodeId].children.some((id) => this.answered(id, after(chess, this.tree.nodes[id].san as string)));
  }

  /** The expected score from `nodeId`, listing the opponent's turns met. */
  private async value(nodeId: number, chess: Chess, reach: number, turns: Turn[]): Promise<number> {
    if (chess.isCheckmate()) return this.studiedToMove(chess) ? 0 : 1;
    if (finished(chess)) return 0.5;
    const node = this.tree.nodes[nodeId];
    if (this.studiedToMove(chess)) {
      if (!node.children.length) {
        // Nothing prepared from the starting point: its own results.
        const ended = await this.leaf((await this.explorer(chess.fen())).totals, chess);
        turns.push({ nodeId, chess, reach, ended, own: true });
        return ended;
      }
      const childId = node.children[0];
      const san = this.tree.nodes[childId].san as string;
      const next = after(chess, san);
      if (finished(next) || this.goesOn(childId, next)) return this.value(childId, next, reach, turns);
      const own = (await this.explorer(chess.fen())).moves.find((m) => m.san === san);
      const ended = await this.leaf(own, next);
      turns.push({ nodeId: childId, chess: next, reach, ended });
      return ended;
    }
    turns.push({ nodeId, chess, reach, ended: null });
    const { moves } = await this.explorer(chess.fen());
    const total = moves.reduce((n, m) => n + games(m), 0);
    if (!total) return this.o.leafValue === "explorer" ? 0.5 : this.stockfish(chess);
    const children = new Map(node.children.map((id) => [this.tree.nodes[id].san as string, id]));
    let score = 0;
    for (const m of moves) {
      if (!games(m)) continue;
      const next = after(chess, m.san);
      const childId = children.get(m.san);
      const p = games(m) / total;
      score += p * (childId !== undefined && this.answered(childId, next)
        ? await this.value(childId, next, reach * p, turns)
        : await this.leaf(m, next));
    }
    return score;
  }

  private start(): Chess {
    const chess = new Chess();
    for (const san of sanPathTo(this.tree, this.o.startNodeId)) chess.move(san);
    return chess;
  }

  /** The expected score of the study with the suggestions so far, and the
   * opponent's turns in it. */
  async total(): Promise<{ score: number; turns: Turn[] }> {
    const turns: Turn[] = [];
    const score = await this.value(this.o.startNodeId, this.start(), 1, turns);
    return { score, turns };
  }

  // -- The additions -----------------------------------------------------

  /** Your candidates after the opponent's move: your most played moves
   * there, leaving out those losing more than maxLoss against Stockfish's
   * best; with the value of a line ending with each, best first. */
  private async candidates(chess: Chess): Promise<{ san: string; value: number }[]> {
    const { moves } = await this.explorer(chess.fen());
    const played = moves.filter((m) => games(m) >= this.o.minGames).sort((a, b) => games(b) - games(a));
    const values = [];
    for (const m of played) {
      if (values.length >= this.o.candidates) break;
      const next = after(chess, m.san);
      // Your winning chances are 2 × the expected score − 1: before the
      // move, with Stockfish's best, and after this one.
      if (this.o.maxLoss !== null && 2 * ((await this.stockfish(chess)) - (await this.stockfish(next))) > this.o.maxLoss) continue;
      values.push({ san: m.san, value: await this.leaf(m, next) });
    }
    return values.sort((a, b) => b.value - a.value);
  }

  /** Finds the addition raising the score most and adds it to the copy;
   * null when none raises it. `stopped` is checked between positions. */
  async next(stopped: () => boolean = () => false): Promise<Suggestion | null> {
    const status = this.o.onStatus ?? (() => {});
    status("Valuing the study…");
    const { score: before, turns } = await this.total();
    // The unanswered replies, by the best gain they could give (answered
    // with a move scoring 100%), most promising first.
    const frontier: {
      bound: number; turn: Turn; reply: string | null; next: Chess; p: number; base: number; old: number;
    }[] = [];
    for (const turn of turns) {
      if (stopped()) return null;
      if (turn.own) {
        // Your first move: the line goes on with it, worth what it gives.
        const old = turn.ended as number;
        frontier.push({ bound: turn.reach * (1 - old), turn, reply: null, next: turn.chess, p: 1, base: 0, old });
        continue;
      }
      const { moves } = await this.explorer(turn.chess.fen());
      const total = moves.reduce((n, m) => n + games(m), 0);
      if (!total) continue;
      const node = this.tree.nodes[turn.nodeId];
      const children = new Map(node.children.map((id) => [this.tree.nodes[id].san as string, id]));
      const values = new Map<string, number>();
      for (const m of moves) {
        if (!games(m)) continue;
        const next = after(turn.chess, m.san);
        const childId = children.get(m.san);
        values.set(m.san, childId !== undefined && this.answered(childId, next)
          ? await this.value(childId, next, 0, [])
          : await this.leaf(m, next));
      }
      const now = moves.reduce((s, m) => s + (games(m) / total) * (values.get(m.san) ?? 0), 0);
      for (const m of moves) {
        if (!games(m)) continue;
        const childId = children.get(m.san);
        const next = after(turn.chess, m.san);
        if (childId !== undefined && this.answered(childId, next)) continue;
        const p = games(m) / total;
        if (turn.reach * p < this.o.minReach) continue;
        // Answering m changes this position's value by p * (yours - m's); a
        // line that ended before it goes on, worth this position.
        const base = now - p * (values.get(m.san) ?? 0);
        const old = turn.ended ?? now;
        frontier.push({ bound: turn.reach * (base + p - old), turn, reply: m.san, next, p, base, old });
      }
    }
    frontier.sort((a, b) => b.bound - a.bound);
    let best: { gain: number; turn: Turn; reply: string | null; move: string } | null = null;
    let examined = 0;
    for (const f of frontier) {
      if (stopped()) return null;
      if (best && f.bound <= best.gain) break;
      examined += 1;
      status(f.reply === null
        ? "Trying your first moves…"
        : `Trying answers to ${f.reply} (reply ${examined} of at most ${frontier.length})…`);
      const [top] = await this.candidates(f.next);
      if (!top) continue;
      const gain = f.turn.reach * (f.base + f.p * top.value - f.old);
      if (!best || gain > best.gain) best = { gain, turn: f.turn, reply: f.reply, move: top.san };
    }
    if (!best || best.gain <= 1e-12) return null;
    const replyId = best.reply === null ? best.turn.nodeId : addMove(this.tree, best.turn.nodeId, best.reply);
    const moveId = addMove(this.tree, replyId, best.move);
    const { score } = await this.total();
    const line = sanPathTo(this.tree, moveId);
    return { line, reply: line[line.length - 2] ?? "", move: best.move, score, gain: score - before };
  }
}
