// The material balance shown beside the board, as Lichess does during a
// game: each side's row lists the pieces it has more of than the other side,
// then the point difference ("+2") on the side that is ahead.

import type { Chess } from "chess.js";

type PieceType = "q" | "r" | "b" | "n" | "p";

const VALUES: Record<PieceType, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const ORDER: PieceType[] = ["q", "r", "b", "n", "p"];
const GLYPHS: Record<PieceType, string> = { q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const NAMES: Record<PieceType, string> = { q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

export interface SideMaterial {
  extra: { type: PieceType; count: number }[];
  score: number;
}

export function materialBalance(chess: Chess): Record<"w" | "b", SideMaterial> {
  const counts = { w: { q: 0, r: 0, b: 0, n: 0, p: 0 }, b: { q: 0, r: 0, b: 0, n: 0, p: 0 } };
  for (const row of chess.board()) {
    for (const square of row) {
      if (square && square.type !== "k") counts[square.color][square.type as PieceType] += 1;
    }
  }
  const balance = { w: { extra: [], score: 0 }, b: { extra: [], score: 0 } } as Record<"w" | "b", SideMaterial>;
  let points = 0; // White's lead
  for (const type of ORDER) {
    const diff = counts.w[type] - counts.b[type];
    points += diff * VALUES[type];
    if (diff > 0) balance.w.extra.push({ type, count: diff });
    if (diff < 0) balance.b.extra.push({ type, count: -diff });
  }
  balance.w.score = Math.max(0, points);
  balance.b.score = Math.max(0, -points);
  return balance;
}

export function materialHtml(side: SideMaterial): string {
  const groups = side.extra
    .map(({ type, count }) => `<span class="material__group" title="${count} more ${NAMES[type]}${count > 1 ? "s" : ""}">${GLYPHS[type].repeat(count)}</span>`)
    .join("");
  return groups + (side.score > 0 ? `<span class="material__score">+${side.score}</span>` : "");
}
