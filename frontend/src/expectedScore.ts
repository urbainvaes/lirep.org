// The expected score, coverage and expected evaluation of a study. Walks the tree with the
// Opening Explorer's move frequencies, assuming the studied side always plays
// its prepared move (the first child) and the opponent replies as in the
// Explorer. Runs in the browser, so the Explorer requests are the user's own
// (see explorerClient.ts); `explorer` supplies each position's data.
//
// A line ends with its last answered move. Its value comes from `leafValue`:
// that move's own Explorer results, as listed in the position before it;
// Stockfish's evaluation of the position it leads to, as an expected score;
// or the Explorer results, with Stockfish where they count fewer than
// MIN_LEAF_GAMES games. An opponent move in the tree without a prepared
// answer is ignored, as if it weren't there. See doc/expected-score.html.
//
// With Stockfish values, the same walk also averages the evaluations
// themselves, in centipawns, each capped at ±EVAL_CAP_CP: the expected
// evaluation, which therefore has the same lines' ends as the expected score.

import { Chess } from "chess.js";

import { MIN_LEAF_GAMES, type ExplorerData, type LeafValue } from "./explorer";
import { sanPathTo, type StudyTree } from "./tree";

type Outcome = [win: number, draw: number, loss: number]; // for the studied side

// A position's value: its expected score; the win/draw/loss split behind it
// when every line's end has one (Stockfish's values don't); and its
// evaluation in centipawns, for the studied side, when every line's end has
// one (Explorer results don't).
interface Value {
  score: number;
  outcome: Outcome | null;
  cp: number | null;
}

const NEUTRAL: Value = { score: 0.5, outcome: [0.5, 0, 0.5], cp: null };

// A mate on the board, or forced, is capped at this centipawn value so it can
// be averaged with ordinary evaluations.
export const MATE_SCORE_CP = 100_000;

// The expected evaluation counts each evaluation within ±10 pawns, a mate as
// 10 pawns: otherwise a mate after a blunder in 0.1% of games would add a
// whole pawn to the average. The expected score needs no cap, since its
// curve flattens out.
export const EVAL_CAP_CP = 1000;

const capped = (cp: number) => Math.max(-EVAL_CAP_CP, Math.min(EVAL_CAP_CP, cp));

// Centipawns to an expected score, with the curve Lichess uses for its
// winning chances.
export function scoreFromCp(cp: number): number {
  return 1 / (1 + Math.exp(-0.00368208 * cp));
}

function fromOutcome(outcome: Outcome, cp: number | null = null): Value {
  return { score: outcome[0] + outcome[1] / 2, outcome, cp };
}

function outcomeProbabilities(white: number, draws: number, black: number, side: "white" | "black"): Outcome | null {
  const games = white + draws + black;
  if (games === 0) return null;
  const wins = side === "white" ? white : black;
  const losses = side === "white" ? black : white;
  return [wins / games, draws / games, losses / games];
}

// The game is over on the board: mate, stalemate or bare kings. Draws that
// must be claimed (repetition, fifty moves) don't end a prepared line.
function finishedGame(chess: Chess): "white" | "black" | "draw" | null {
  if (chess.isCheckmate()) return chess.turn() === "w" ? "black" : "white";
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return "draw";
  return null;
}

export interface ExpectedScoreResult {
  score: number;
  winRate: number | null; // null when some line's end was valued with Stockfish
  lossProbability: number | null;
  coverage: number[]; // coverage[i] = share of games still in the tree after the opponent's (i+1)th move
  nodesEvaluated: number;
  explorerCalls: number;
  stockfishLeaves: number; // distinct positions valued with Stockfish
  // The expected evaluation, in centipawns for the studied side: null unless
  // every line's end was valued with Stockfish (leafValue "stockfish").
  evalCp: number | null;
  stockfishPositions: string[]; // the FENs Stockfish valued
}

export async function calculateExpectedScore(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  explorer: (fen: string) => Promise<ExplorerData>,
  leafValue: LeafValue = "explorer",
  // Stockfish's evaluation in centipawns, from White's point of view; null
  // when the engine gave none (counted as 0.00). Needed unless leafValue is
  // "explorer".
  evaluate?: (fen: string) => Promise<number | null>,
): Promise<ExpectedScoreResult> {
  let nodesEvaluated = 0;
  const stockfishLeaves = new Set<string>();
  const fetched = new Set<string>();
  const explorerData = (fen: string): Promise<ExplorerData> => {
    fetched.add(fen);
    return explorer(fen);
  };
  const studiedToMove = (chess: Chess) => (chess.turn() === "w") === (side === "white");
  const childrenBySan = (nodeId: number) => new Map(tree.nodes[nodeId].children.map((id) => [tree.nodes[id].san as string, id]));
  const after = (chess: Chess, san: string) => {
    const next = new Chess(chess.fen());
    next.move(san);
    return next;
  };
  // An opponent move in the tree is answered if the studied side has a move
  // prepared after it, or if it ends the game (nothing left to answer).
  const answered = (nodeId: number, chess: Chess) =>
    tree.nodes[nodeId].children.length > 0 || finishedGame(chess) !== null;
  // After the studied side's move, the line goes on if at least one of the
  // opponent's replies in the tree is answered.
  const lineGoesOn = (nodeId: number, chess: Chess) =>
    tree.nodes[nodeId].children.some((id) => answered(id, after(chess, tree.nodes[id].san as string)));

  async function stockfishValue(chess: Chess): Promise<Value> {
    if (!evaluate) throw new Error("Stockfish is needed for these end-of-prep values");
    const fen = chess.fen();
    stockfishLeaves.add(fen);
    const white = (await evaluate(fen)) ?? 0;
    const cp = side === "white" ? white : -white;
    return { score: scoreFromCp(cp), outcome: null, cp: capped(cp) };
  }

  // A line's end valued from Explorer results (a move's row, or a position's
  // totals). With the Stockfish fallback, too few games give `stockfish()`
  // instead. null: no games, for the caller's own fallback.
  async function explorerValue(
    results: { white: number; draws: number; black: number } | undefined,
    stockfish: () => Promise<Value>,
  ): Promise<Value | null> {
    const games = results ? results.white + results.draws + results.black : 0;
    if (leafValue === "explorer-stockfish" && games < MIN_LEAF_GAMES) return stockfish();
    const outcome = results ? outcomeProbabilities(results.white, results.draws, results.black, side) : null;
    return outcome && fromOutcome(outcome);
  }

  async function value(nodeId: number, chess: Chess): Promise<Value> {
    nodesEvaluated += 1;
    const finished = finishedGame(chess);
    if (finished === "draw") return fromOutcome([0, 1, 0], 0);
    if (finished) return finished === side ? fromOutcome([1, 0, 0], EVAL_CAP_CP) : fromOutcome([0, 0, 1], -EVAL_CAP_CP);
    const node = tree.nodes[nodeId];
    if (studiedToMove(chess)) {
      if (!node.children.length) {
        // Nothing prepared at all (the starting point itself): the
        // position's overall Explorer results.
        if (leafValue === "stockfish") return stockfishValue(chess);
        const { totals } = await explorerData(chess.fen());
        return (await explorerValue(totals, () => stockfishValue(chess))) ?? NEUTRAL;
      }
      const childId = node.children[0];
      const san = tree.nodes[childId].san as string;
      const next = after(chess, san);
      if (finishedGame(next) || lineGoesOn(childId, next)) return value(childId, next);
      // The line ends with this move: its own results, as listed here.
      if (leafValue === "stockfish") return stockfishValue(next);
      const { moves } = await explorerData(chess.fen());
      const own = await explorerValue(moves.find((m) => m.san === san), () => stockfishValue(next));
      // Too rare to be listed: no games to go by, so even, like a position
      // without games (with the Stockfish fallback, Stockfish's value).
      return own ?? NEUTRAL;
    }
    // The opponent's move: each reply weighted by how often it is played; a
    // reply the tree doesn't answer ends prep there, with that move's results.
    const { moves } = await explorerData(chess.fen());
    const total = moves.reduce((n, m) => n + m.white + m.draws + m.black, 0);
    if (!total) return leafValue === "explorer" ? NEUTRAL : stockfishValue(chess);
    const children = childrenBySan(nodeId);
    let score = 0;
    let outcome: Outcome | null = [0, 0, 0];
    let cp: number | null = 0;
    for (const move of moves) {
      const games = move.white + move.draws + move.black;
      if (!games) continue;
      const childId = children.get(move.san);
      const next = after(chess, move.san);
      const reply = childId !== undefined && answered(childId, next)
        ? await value(childId, next)
        : leafValue === "stockfish"
          ? await stockfishValue(next)
          : await explorerValue(move, () => stockfishValue(next));
      if (!reply) continue;
      score += (games / total) * reply.score;
      if (outcome && reply.outcome) for (let i = 0; i < 3; i++) outcome[i] += (games / total) * reply.outcome[i];
      else outcome = null;
      cp = cp !== null && reply.cp !== null ? cp + (games / total) * reply.cp : null;
    }
    return { score, outcome, cp };
  }

  // Probability mass still inside the tree at each ply from the start.
  const massByPly = new Map<number, number>();
  async function coverageWalk(nodeId: number, chess: Chess, ply: number, mass: number): Promise<void> {
    massByPly.set(ply, (massByPly.get(ply) ?? 0) + mass);
    if (finishedGame(chess)) return;
    const node = tree.nodes[nodeId];
    if (studiedToMove(chess)) {
      const childId = node.children[0];
      if (childId !== undefined) await coverageWalk(childId, after(chess, tree.nodes[childId].san as string), ply + 1, mass);
      return;
    }
    // Nothing prepared after this move: all the games leave the tree here,
    // whatever the opponent plays, so there's no need to ask.
    if (!node.children.length) return;
    const { moves } = await explorerData(chess.fen());
    const total = moves.reduce((n, m) => n + m.white + m.draws + m.black, 0);
    if (!total) return;
    const children = childrenBySan(nodeId);
    for (const move of moves) {
      const games = move.white + move.draws + move.black;
      const childId = children.get(move.san);
      if (!games || childId === undefined) continue;
      // An unanswered move leaves the preparation, like one not in the tree.
      const next = after(chess, move.san);
      if (answered(childId, next)) await coverageWalk(childId, next, ply + 1, (mass * games) / total);
    }
  }

  const start = new Chess();
  for (const san of sanPathTo(tree, startNodeId)) start.move(san);
  const { score, outcome, cp } = await value(startNodeId, start);
  await coverageWalk(startNodeId, start, 0, 1);
  // Coverage is sampled right after each of the opponent's moves, counted
  // from the starting point: plies 1, 3, 5… if the opponent moves first
  // from there, 2, 4, 6… if the studied side does.
  const firstPly = studiedToMove(start) ? 2 : 1;
  const maxPly = Math.max(0, ...massByPly.keys());
  const coverage: number[] = [];
  for (let ply = firstPly; ply <= maxPly; ply += 2) coverage.push(massByPly.get(ply) ?? 0);
  return {
    score,
    winRate: outcome ? outcome[0] : null,
    lossProbability: outcome ? outcome[2] : null,
    coverage,
    nodesEvaluated,
    explorerCalls: fetched.size,
    stockfishLeaves: stockfishLeaves.size,
    evalCp: leafValue === "stockfish" ? cp : null,
    stockfishPositions: [...stockfishLeaves],
  };
}
