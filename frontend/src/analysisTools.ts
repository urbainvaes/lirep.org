import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";
import { formatScore, uciMoveToKeys, winningChances, type EngineLine } from "./engine";
import type { ExplorerData } from "./explorer";
import { escapeHtml } from "./layout";
import { sanPathTo, type StudyTree } from "./tree";

// What the study editor and the read-only opening viewer share: the board
// column, the Explorer / Stockfish tabs and how Stockfish's moves are shown.

// The Stockfish depth, changed 4 at a time with the arrows beside it and
// remembered in this browser. (The Stats page has its own setting.)
export const ENGINE_DEPTH_STEP = 4;
export const ENGINE_DEPTH_MIN = 4;
export const ENGINE_DEPTH_MAX = 24;
const ENGINE_DEPTH_DEFAULT = 12;
const ENGINE_DEPTH_STORAGE_KEY = "study-engine-depth";

export function getSavedEngineDepth(): number {
  try {
    const depth = Number(localStorage.getItem(ENGINE_DEPTH_STORAGE_KEY));
    return depth >= ENGINE_DEPTH_MIN && depth <= ENGINE_DEPTH_MAX && depth % ENGINE_DEPTH_STEP === 0 ? depth : ENGINE_DEPTH_DEFAULT;
  } catch {
    return ENGINE_DEPTH_DEFAULT;
  }
}

export function saveEngineDepth(depth: number): void {
  try {
    localStorage.setItem(ENGINE_DEPTH_STORAGE_KEY, String(depth));
  } catch {
    // The choice just isn't remembered.
  }
}

export type Tool = "explorer" | "engine";
const TOOLS_STORAGE_KEY = "study-tools";

// Which of the Explorer and Stockfish are on, remembered in this browser;
// neither by default, so the move tree has the whole column.
export function getSavedTools(): Set<Tool> {
  try {
    const saved = localStorage.getItem(TOOLS_STORAGE_KEY);
    if (saved === null) return new Set();
    return new Set(saved.split(",").filter((t): t is Tool => t === "explorer" || t === "engine"));
  } catch {
    return new Set();
  }
}

export function saveTools(tools: Set<Tool>): void {
  try {
    localStorage.setItem(TOOLS_STORAGE_KEY, [...tools].join(","));
  } catch {
    // The choice just isn't remembered.
  }
}

// null when there's nothing to say (no starting point set, or it's just the
// real root) — see starting-point.md.
export function describeStartPoint(tree: StudyTree, startNodeId: number | null): string | null {
  if (startNodeId === null || startNodeId === tree.rootId) return null;
  const node = tree.nodes[startNodeId];
  if (!node || node.san === null) return null;
  const ply = sanPathTo(tree, startNodeId).length;
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  return `Starts after ${moveNumber}.${isWhite ? "" : ".."}${node.san}`;
}

// Stockfish's arrows: the colour says how good the move is, the width how
// often it is played. At most MAX_ARROWS: Stockfish's top lines, plus the
// Explorer's moves played in at least ARROW_MIN_SHARE of games that those
// lines miss, which Stockfish then evaluates too.
const MAX_ARROWS = 8;
const ARROW_MIN_SHARE = 0.05;

// Quality by the winning chances lost against the best move (on Lichess's
// −1…1 scale, where it calls 0.1 an inaccuracy, 0.2 a mistake, 0.3 a blunder).
const QUALITY = [
  { maxLoss: 0.02, label: "best", color: "#15781B" },
  { maxLoss: 0.1, label: "good", color: "#629924" },
  { maxLoss: 0.2, label: "inaccuracy", color: "#d9a400" },
  { maxLoss: 0.3, label: "mistake", color: "#e06a1a" },
  { maxLoss: Infinity, label: "blunder", color: "#c52b2b" },
] as const;

export const QUALITY_BRUSHES = Object.fromEntries(
  QUALITY.map((q, i) => [`quality${i}`, { key: `q${i}`, color: q.color, opacity: 0.85, lineWidth: 10 }]),
);

function qualityIndex(loss: number): number {
  return QUALITY.findIndex((q) => loss <= q.maxLoss);
}

// In Chessground's units (64 = a square): the square root of the move's
// share of games, so a 5% move stays visible next to a 60% one.
function arrowWidth(share: number | null): number {
  if (share === null) return 10; // no Explorer data: all alike
  return Math.round(4 + 16 * Math.sqrt(share));
}

export function sanToUci(chess: Chess, san: string): string | null {
  try {
    const move = new Chess(chess.fen()).move(san);
    return move.from + move.to + (move.promotion ?? "");
  } catch {
    return null;
  }
}

export function uciToSan(chess: Chess, uci: string): string {
  const clone = new Chess(chess.fen());
  const move = clone.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  return move ? move.san : uci;
}

/** How often each move (UCI) is played here, from the Explorer's data. */
export interface MoveShares {
  games: Map<string, number>;
  total: number;
  /** false without Explorer data, when arrows are all the same width. */
  known: boolean;
}

export function moveShares(chess: Chess, explorer: ExplorerData | null): MoveShares {
  const games = new Map<string, number>();
  for (const move of explorer?.moves ?? []) {
    const uci = sanToUci(chess, move.san);
    if (uci) games.set(uci, move.white + move.draws + move.black);
  }
  return { games, total: [...games.values()].reduce((a, b) => a + b, 0), known: explorer !== null };
}

/** Popular Explorer moves Stockfish's top lines miss, for it to evaluate too. */
export function missingPopularMoves(lines: EngineLine[], shares: MoveShares): string[] {
  return [...shares.games.entries()]
    .filter(([uci, n]) => shares.total && n / shares.total >= ARROW_MIN_SHARE && !lines.some((l) => l.move === uci))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, MAX_ARROWS - lines.length))
    .map(([uci]) => uci);
}

/** The board's arrows and the row of chips (best first, each in its arrow's
 * colour; a chip's data-move is its UCI move) for Stockfish's lines. */
export function engineMovesView(
  chess: Chess,
  lines: EngineLine[],
  shares: MoveShares,
  chipAction: string,
): { shapes: DrawShape[]; chipsHtml: string } {
  const sideToMoveIsWhite = chess.turn() === "w";
  const best = Math.max(...lines.map(winningChances));
  const moves = lines.slice(0, MAX_ARROWS).map((line) => {
    const quality = qualityIndex(best - winningChances(line));
    const share = shares.known ? (shares.total ? (shares.games.get(line.move) ?? 0) / shares.total : 0) : null;
    return { line, quality, share, san: uciToSan(chess, line.move) };
  });

  // The most played arrows first, so they sit underneath the thinner ones.
  const shapes = [...moves]
    .sort((a, b) => (b.share ?? 0) - (a.share ?? 0))
    .map(({ line, quality, share }) => {
      const { orig, dest } = uciMoveToKeys(line.move);
      return { orig: orig as Key, dest: dest as Key, brush: `quality${quality}`, modifiers: { lineWidth: arrowWidth(share) } };
    });

  const chipsHtml = [...moves]
    .sort((a, b) => winningChances(b.line) - winningChances(a.line))
    .map(({ line, quality, share, san }) => {
      const score = formatScore(line, sideToMoveIsWhite);
      const played = share === null ? "" : ` · played in ${share < 0.01 ? "under 1" : Math.round(share * 100)}% of games`;
      return `<button class="engine-chip" type="button" data-move="${escapeHtml(line.move)}" title="${chipAction} ${escapeHtml(san)} (${QUALITY[quality].label}${played})">
          <span class="engine-chip__dot" style="background:${QUALITY[quality].color}"></span><strong>${escapeHtml(san)}</strong> ${escapeHtml(score)}
        </button>`;
    })
    .join("");

  return { shapes, chipsHtml };
}

/** The board with the material above and below it, the evaluation gauge and
 * the navigation buttons beneath. */
export function boardColumnHtml(): string {
  return `
    <div class="study-board-col">
      <div class="study-card study-card--board">
        <div id="material-top" class="material" aria-label="Material"></div>
        <div id="board" class="study-board"></div>
        <div id="material-bottom" class="material" aria-label="Material"></div>
        <div id="eval-gauge" class="eval-gauge" role="img" aria-label="Evaluation" hidden>
          <div id="eval-gauge-black" class="eval-gauge__black"></div>
        </div>
      </div>
      <div class="board-nav" role="group" aria-label="Move navigation">
        <button id="nav-start" class="board-nav__btn" type="button" title="Go to start (↑)" aria-label="Go to start"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button id="nav-back" class="board-nav__btn" type="button" title="Previous move (←)" aria-label="Previous move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17 5v14L6 12z"/></svg></button>
        <button id="nav-forward" class="board-nav__btn" type="button" title="Next move (→)" aria-label="Next move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg></button>
        <button id="nav-end" class="board-nav__btn" type="button" title="End of line (↓)" aria-label="End of line"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
        <button id="flip-board-btn" class="board-nav__btn board-flip-btn" type="button" data-icon="&#xe07b;" title="Flip board" aria-label="Flip board"></button>
      </div>
    </div>
  `;
}

/** Stockfish's panel and the row of tabs that turn the two tools on and off. */
export function toolTabsHtml(): string {
  return `
    <div id="tool-engine" class="tool-panel tool-panel--engine" hidden>
      <div id="engine-panel" class="engine-chips"></div>
    </div>

    <div class="tool-tabs" role="group" aria-label="Analysis tools">
      <button id="tab-explorer" class="tool-tab" type="button" aria-pressed="false" aria-controls="tool-explorer">
        <span class="analysis-label" data-icon="&#xe03b;" aria-hidden="true"></span>Opening Explorer
      </button>
      <button id="tab-engine" class="tool-tab" type="button" aria-pressed="false" aria-controls="tool-engine">
        <span class="analysis-label" data-icon="&#xe05f;" aria-hidden="true"></span>Stockfish
      </button>
      <span id="engine-depth" class="engine-depth tool-tabs__status" hidden>
        <button id="depth-down" class="engine-depth__btn" type="button" aria-label="Search less deep">‹</button>
        <span id="engine-status" class="engine-eval" title="Stockfish's search depth, in this browser" aria-live="polite"></span>
        <button id="depth-up" class="engine-depth__btn" type="button" aria-label="Search deeper">›</button>
      </span>
    </div>
  `;
}
