// The expected score and coverage of a study. Walks the tree with the
// Opening Explorer's move frequencies, assuming the studied side always plays
// its prepared move (the first child) and the opponent replies as in the
// Explorer. Runs in the browser, so the Explorer requests are the user's own
// (see explorerClient.ts); `explorer` supplies each position's data.

import { Chess } from "chess.js";

import type { ExplorerData } from "./explorer";
import { sanPathTo, type StudyTree } from "./tree";

type Outcome = [win: number, draw: number, loss: number]; // for the studied side

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
  winRate: number;
  lossProbability: number;
  coverage: number[]; // coverage[i] = share of games still in the tree after the opponent's (i+1)th move
  nodesEvaluated: number;
  explorerCalls: number;
}

export async function calculateExpectedScore(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  explorer: (fen: string) => Promise<ExplorerData>,
): Promise<ExpectedScoreResult> {
  let nodesEvaluated = 0;
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

  async function outcomes(nodeId: number, chess: Chess): Promise<Outcome> {
    nodesEvaluated += 1;
    const finished = finishedGame(chess);
    if (finished === "draw") return [0, 1, 0];
    if (finished) return finished === side ? [1, 0, 0] : [0, 0, 1];
    const node = tree.nodes[nodeId];
    if (studiedToMove(chess)) {
      if (!node.children.length) {
        // Prep ends on the studied side's move: the position's overall
        // Explorer results stand in for what happens from here.
        const { totals } = await explorerData(chess.fen());
        return outcomeProbabilities(totals.white, totals.draws, totals.black, side) ?? [0.5, 0, 0.5];
      }
      const childId = node.children[0];
      return outcomes(childId, after(chess, tree.nodes[childId].san as string));
    }
    // The opponent's move: each reply weighted by how often it is played; a
    // reply the tree doesn't answer ends prep there, with that move's results.
    const { moves } = await explorerData(chess.fen());
    const total = moves.reduce((n, m) => n + m.white + m.draws + m.black, 0);
    if (!total) return [0.5, 0, 0.5];
    const children = childrenBySan(nodeId);
    const expected: Outcome = [0, 0, 0];
    for (const move of moves) {
      const games = move.white + move.draws + move.black;
      if (!games) continue;
      const childId = children.get(move.san);
      const value = childId !== undefined
        ? await outcomes(childId, after(chess, move.san))
        : outcomeProbabilities(move.white, move.draws, move.black, side);
      if (!value) continue;
      for (let i = 0; i < 3; i++) expected[i] += (games / total) * value[i];
    }
    return expected;
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
    const { moves } = await explorerData(chess.fen());
    const total = moves.reduce((n, m) => n + m.white + m.draws + m.black, 0);
    if (!total) return;
    const children = childrenBySan(nodeId);
    for (const move of moves) {
      const games = move.white + move.draws + move.black;
      const childId = children.get(move.san);
      if (games && childId !== undefined) await coverageWalk(childId, after(chess, move.san), ply + 1, (mass * games) / total);
    }
  }

  const start = new Chess();
  for (const san of sanPathTo(tree, startNodeId)) start.move(san);
  const [winRate, , lossProbability] = await outcomes(startNodeId, start);
  await coverageWalk(startNodeId, start, 0, 1);
  // Coverage is sampled right after each of the opponent's moves, counted
  // from the starting point: plies 1, 3, 5… if the opponent moves first
  // from there, 2, 4, 6… if the studied side does.
  const firstPly = studiedToMove(start) ? 2 : 1;
  const maxPly = Math.max(0, ...massByPly.keys());
  const coverage: number[] = [];
  for (let ply = firstPly; ply <= maxPly; ply += 2) coverage.push(massByPly.get(ply) ?? 0);
  return { winRate, lossProbability, coverage, nodesEvaluated, explorerCalls: fetched.size };
}
