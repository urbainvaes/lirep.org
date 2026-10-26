// A study's badge: a chess piece whose shine is the expected score's tier
// and whose rank is the expected evaluation's, on its Stats page (with
// their legend) and on its card on the home page.

// Gamification tiers for the expected score, by side: White scores about
// 52% on average in the Explorer's pools, Black about 48%, so Bronze is the
// colour's average and Black's thresholds are BLACK_TIER_OFFSET points
// lower. Shown as a colored chess piece (see .piece-badge), not a medal.
export type ScoreTier = "legendary" | "brilliant" | "gold" | "silver" | "bronze" | "none";

export const TIERS: { tier: Exclude<ScoreTier, "none">; label: string; white: number }[] = [
  { tier: "legendary", label: "Legendary", white: 60 },
  { tier: "brilliant", label: "Brilliant", white: 59 },
  { tier: "gold", label: "Gold", white: 57 },
  { tier: "silver", label: "Silver", white: 54 },
  { tier: "bronze", label: "Bronze", white: 52 },
];
export const BLACK_TIER_OFFSET = 4;

export const TIER_LABELS: Record<ScoreTier, string> = {
  ...(Object.fromEntries(TIERS.map((t) => [t.tier, t.label])) as Record<Exclude<ScoreTier, "none">, string>),
  none: "No tier",
};

// The lowest expected score, in percent, for a tier on `side`.
export const tierThreshold = (white: number, side: "white" | "black") => white - (side === "black" ? BLACK_TIER_OFFSET : 0);

export function scoreTier(expectedScore: number | undefined, side: "white" | "black"): ScoreTier {
  if (expectedScore === undefined) return "none";
  const pct = expectedScore * 100;
  return TIERS.find((t) => pct >= tierThreshold(t.white, side))?.tier ?? "none";
}

// The expected evaluation's pieces, highest first: the lowest evaluation,
// in pawns from the studied side's point of view, for each (the same for
// both sides). A study without one shows the pawn.
export type EvalPiece = "king" | "queen" | "rook" | "bishop" | "knight" | "pawn";

export const PIECES: { piece: EvalPiece; label: string; glyph: string; from: number }[] = [
  { piece: "king", label: "King", glyph: "♚", from: 1.0 },
  { piece: "queen", label: "Queen", glyph: "♛", from: 0.9 },
  { piece: "rook", label: "Rook", glyph: "♜", from: 0.75 },
  { piece: "bishop", label: "Bishop", glyph: "♝", from: 0.5 },
  { piece: "knight", label: "Knight", glyph: "♞", from: 0.25 },
  { piece: "pawn", label: "Pawn", glyph: "♟", from: -Infinity },
];

export const PIECE_LABELS = Object.fromEntries(PIECES.map((p) => [p.piece, p.label])) as Record<EvalPiece, string>;

/** `evalCp`: the expected evaluation, in centipawns for the studied side. */
export function evalPiece(evalCp: number | undefined): EvalPiece {
  if (evalCp === undefined) return "pawn";
  return PIECES.find((p) => evalCp / 100 >= p.from)!.piece;
}

/** The expected evaluation `evalCp` (centipawns for the studied side `side`)
 * as shown: pawns from White's point of view, as on Lichess (−0.40 is
 * Black's advantage), forced mates (capped near 100,000 cp) spelled out. */
export function formatExpectedEval(evalCp: number, side: "white" | "black"): string {
  const cp = side === "white" ? evalCp : -evalCp;
  if (Math.abs(cp) > 99_000) return cp > 0 ? "White mates" : "Black mates";
  return `${cp > 0 ? "+" : cp < 0 ? "−" : ""}${Math.abs(cp / 100).toFixed(2)}`;
}

export function pieceBadgeHtml(tier: ScoreTier, size: "" | "sm" = "", piece: EvalPiece = "king"): string {
  const sizeClass = size ? ` piece-badge--${size}` : "";
  // U+FE0E: the glyph's text form; the pawn's emoji form would ignore the
  // gradient.
  // The piece's own class: the Lichess pieces option (badgePrefs.ts) draws
  // its shape instead of the glyph.
  const glyph = PIECES.find((p) => p.piece === piece)!.glyph;
  return `<span class="piece-badge piece-badge--${tier} piece-badge--p-${piece}${sizeClass}">${glyph}\uFE0E</span>`;
}
