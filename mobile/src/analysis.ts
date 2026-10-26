// The analysis: a layer over practice or Bullet, as in the Lichess app,
// on a position of the study's line. You step through the line (‹ ›, or the
// row of moves), play your own moves, which replace the rest of the line
// (they stay here, not in the study), and turn the Explorer and Stockfish
// on or off. The back arrow, or the phone's back, closes it and the screen
// below goes on where it was.
//
// With the study's tree, it also shows the prep: your prepared move (a
// button, and an arrow on the board), or the opponent's prepared replies
// (a button each, in the study's order); moves off the tree are greyed in
// the row. The home screen's study view is this, as a screen of its own.

import type { Api } from "@lichess-org/chessground/api";
import type { DrawShape } from "@lichess-org/chessground/draw";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import {
  engineMovesView,
  getSavedEngineDepth,
  getSavedTools,
  missingPopularMoves,
  moveShares,
  QUALITY_BRUSHES,
  saveTools,
  type Tool,
} from "@web/analysisTools";
import { computeDests, createBoard, playMoveSound, toColor } from "@web/board";
import { Engine, formatScore } from "@web/engine";
import type { ExplorerData, ExplorerSettings } from "@web/explorer";
import { cachedExplorerData, errorMessage, fetchExplorerData } from "@web/explorerClient";
import { escapeHtml } from "@web/layout";
import type { StudyTree } from "@web/tree";

import { FLIP_ICON } from "./icons";

export interface AnalysisOptions {
  /** The moves from the initial position; the analysis opens after them,
   * or after `at` of them. */
  line: string[];
  at?: number;
  orientation: "white" | "black";
  side: "white" | "black";
  explorerSettings?: ExplorerSettings | null;
  /** The study's moves: the prep is shown along them. */
  tree?: StudyTree;
  /** The bar's title (else "Analysis"). */
  title?: string;
  /** A screen of its own, in `root`, rather than a layer: the back arrow
   * goes to `back`, and the returned function undoes it. */
  screen?: { root: HTMLElement; back: string };
  /** Called once it's closed. */
  onClose(): void;
}

const EXPLORER_ROWS = 8;

/** Opens the analysis over the page (or as a screen); returns what closes
 * it. */
export function openAnalysis(o: AnalysisOptions): () => void {
  let line = [...o.line];
  let ply = Math.min(o.at ?? line.length, line.length);
  const tools: Set<Tool> = getSavedTools();
  const depth = getSavedEngineDepth();
  let engine: Engine | null = null;
  let run = 0; // the position shown: answers for an older one are dropped

  const layer = document.createElement("div");
  layer.className = `analysis session${o.screen ? " analysis--screen" : ""}`;
  layer.innerHTML = `
    <header class="bar">
      ${o.screen
        ? `<a class="bar__back" href="${escapeHtml(o.screen.back)}" aria-label="Back">‹</a>`
        : '<button class="bar__back" type="button" id="an-back" aria-label="Back">‹</button>'}
      <h1 class="bar__title">${escapeHtml(o.title ?? "Analysis")}</h1>
      <span class="bar__aside" id="an-eval"></span>
    </header>
    <div class="session__above">
      <div class="analysis__moves" id="an-moves"></div>
    </div>
    <div class="session__board"><div class="board" id="an-board"></div></div>
    <div class="session__below analysis__below">
      <div class="prep" id="an-prep" hidden></div>
      <div class="analysis__engine" id="an-engine" hidden></div>
      <div class="analysis__explorer" id="an-explorer" hidden></div>
    </div>
    <div class="session__toolbar">
      <button class="icon-button" type="button" id="an-flip" aria-label="Flip the board">${FLIP_ICON}</button>
      <button class="chip" type="button" id="an-tool-engine" aria-pressed="false">Stockfish</button>
      <button class="chip" type="button" id="an-tool-explorer" aria-pressed="false">Explorer</button>
      <button class="icon-button analysis__step" type="button" id="an-prev" aria-label="Previous move">‹</button>
      <button class="icon-button analysis__step" type="button" id="an-next" aria-label="Next move">›</button>
    </div>
  `;
  if (o.screen) o.screen.root.replaceChildren(layer);
  else {
    document.body.append(layer);
    document.body.classList.add("has-layer");
  }
  const el = (id: string) => layer.querySelector(`#${id}`) as HTMLElement;
  const evalEl = el("an-eval");
  const prepEl = el("an-prep");
  const movesEl = el("an-moves");
  const engineEl = el("an-engine");
  const explorerEl = el("an-explorer");

  const position = (n = ply) => {
    const chess = new Chess();
    for (const san of line.slice(0, n)) chess.move(san);
    return chess;
  };

  // The tree's node after the line's first `n` moves; null off the tree
  // (or without one).
  const nodeAt = (n = ply): number | null => {
    const tree = o.tree;
    if (!tree) return null;
    let id = tree.rootId;
    for (const san of line.slice(0, n)) {
      const next = tree.nodes[id].children.find((child) => tree.nodes[child].san === san);
      if (next === undefined) return null;
      id = next;
    }
    return id;
  };
  // How many of the line's first moves are the study's.
  const inTree = (): number => {
    let n = 0;
    while (n < line.length && nodeAt(n + 1) !== null) n++;
    return n;
  };
  // The prepared moves from here, in the study's order.
  const prepared = (): string[] => {
    const node = nodeAt();
    return node === null ? [] : o.tree!.nodes[node].children.map((child) => o.tree!.nodes[child].san as string);
  };

  const board: Api = createBoard(el("an-board"), onMove, o.orientation);
  board.set({ drawable: { brushes: { ...board.state.drawable.brushes, ...QUALITY_BRUSHES } } });

  function onMove(orig: Key, dest: Key): void {
    const chess = position();
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return show();
    playMoveSound(move);
    play(move.san, false);
  }

  /** Plays `san` here: on along the line if it's the line's next move,
   * else it replaces the rest of the line. */
  function play(san: string, sound = true): void {
    if (line[ply] !== san) line = [...line.slice(0, ply), san];
    if (sound) {
      const chess = position();
      const move = chess.move(san);
      if (move) playMoveSound(move);
    }
    ply += 1;
    show();
  }

  function showMoves(): void {
    const book = o.tree ? inTree() : line.length;
    movesEl.innerHTML = line
      .map((san, i) => {
        const number = i % 2 === 0 ? `<span class="analysis__number">${i / 2 + 1}.</span>` : "";
        const classes = `analysis__move${i + 1 === ply ? " analysis__move--on" : ""}${i >= book ? " analysis__move--off" : ""}`;
        return `${number}<button class="${classes}" type="button" data-ply="${i + 1}">${escapeHtml(san)}</button>`;
      })
      .join("");
    movesEl.querySelector(".analysis__move--on")?.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // The prep from here: your prepared move, with its arrow on the board;
  // the opponent's prepared replies, with how often each is played when
  // the Explorer's answer is already in this browser (nothing is asked for
  // it); or that the line ends, or left the prep.
  let prepShapes: DrawShape[] = [];
  function showPrep(chess: Chess): void {
    prepShapes = [];
    const tree = o.tree;
    prepEl.hidden = !tree;
    if (!tree) return;
    const node = nodeAt();
    if (node === null) {
      prepEl.innerHTML = `<p class="analysis__note">Out of prep</p>
        <button class="prep__move" type="button" data-back>Back to prep</button>`;
      return;
    }
    const comment = tree.nodes[node].comment?.trim();
    const commentHtml = comment ? `<p class="prep__comment">${escapeHtml(comment)}</p>` : "";
    const sans = prepared();
    if (!sans.length || chess.isGameOver()) {
      prepEl.innerHTML = `${commentHtml}<p class="analysis__note">End of prep</p>`;
      return;
    }
    const number = `${Math.floor(ply / 2) + 1}${chess.turn() === "w" ? "." : "…"}`;
    if ((chess.turn() === "w") === (o.side === "white")) {
      // Yours: one prepared move.
      const san = sans[0];
      prepEl.innerHTML = `${commentHtml}<button class="prep__move prep__move--own" type="button" data-san="${escapeHtml(san)}">${number}${escapeHtml(san)}<span aria-hidden="true">›</span></button>`;
      const move = new Chess(chess.fen()).move(san);
      prepShapes = [{ orig: move.from as Key, dest: move.to as Key, brush: "blue" }];
      return;
    }
    prepEl.innerHTML = `${commentHtml}<div class="prep__replies">${sans
      .map((san) => `<button class="prep__move" type="button" data-san="${escapeHtml(san)}">${escapeHtml(san)}<span class="prep__share" data-share="${escapeHtml(san)}"></span></button>`)
      .join("")}</div><p class="prep__legend" id="an-unprepared" hidden></p>`;
    void showShares(chess, sans, run);
  }

  async function showShares(chess: Chess, sans: string[], at: number): Promise<void> {
    if (!o.explorerSettings) return;
    const data = await cachedExplorerData(chess.fen(), o.explorerSettings, o.side).catch(() => undefined);
    if (at !== run || !data) return;
    const games = new Map(data.moves.map((m) => [m.san, m.white + m.draws + m.black]));
    const total = [...games.values()].reduce((a, b) => a + b, 0);
    if (!total) return;
    let covered = 0;
    for (const san of sans) {
      const share = (games.get(san) ?? 0) / total;
      covered += share;
      const shareEl = prepEl.querySelector<HTMLElement>(`[data-share="${CSS.escape(san)}"]`);
      if (shareEl) shareEl.textContent = `${Math.round(share * 100)}%`;
    }
    // The legend: these are how often each reply is played (the Explorer's
    // percentages are scores), and how often none of them is.
    const legend = el("an-unprepared");
    if (legend) {
      legend.hidden = false;
      legend.textContent = `% of games playing each${1 - covered >= 0.005 ? ` · not prepared: ${Math.round((1 - covered) * 100)}%` : ""}`;
    }
  }

  function show(): void {
    run += 1;
    const chess = position();
    showPrep(chess);
    const lastMove = ply ? (() => {
      const before = position(ply - 1);
      const move = before.move(line[ply - 1]);
      return [move.from as Key, move.to as Key];
    })() : [];
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      check: chess.isCheck(),
      lastMove,
      movable: { color: toColor(chess), dests: computeDests(chess) },
      drawable: { autoShapes: prepShapes },
    });
    showMoves();
    (el("an-prev") as HTMLButtonElement).disabled = ply === 0;
    (el("an-next") as HTMLButtonElement).disabled = ply >= line.length && !prepared().length;
    el("an-tool-explorer").setAttribute("aria-pressed", String(tools.has("explorer")));
    el("an-tool-engine").setAttribute("aria-pressed", String(tools.has("engine")));
    explorerEl.hidden = !tools.has("explorer");
    engineEl.hidden = !tools.has("engine");
    evalEl.textContent = "";
    void analyse(chess, run);
  }

  // The Explorer's moves here, and Stockfish's lines (with the Explorer's
  // popular moves it misses), as on the website's editor.
  async function analyse(chess: Chess, at: number): Promise<void> {
    let data: ExplorerData | null = null;
    if (o.explorerSettings && (tools.has("explorer") || tools.has("engine"))) {
      if (tools.has("explorer")) explorerEl.innerHTML = `<p class="analysis__note">…</p>`;
      try {
        data = await fetchExplorerData(chess.fen(), o.explorerSettings, o.side, { priority: "interactive" });
      } catch (err) {
        if (at === run && tools.has("explorer")) explorerEl.innerHTML = `<p class="analysis__note">${escapeHtml(errorMessage(err) ?? "No Explorer data")}</p>`;
      }
    } else if (tools.has("explorer")) {
      explorerEl.innerHTML = `<p class="analysis__note">No Explorer settings</p>`;
    }
    if (at !== run) return;
    if (tools.has("explorer") && data) showExplorer(data);
    if (!tools.has("engine") || chess.isGameOver()) return;
    engine ??= new Engine();
    engineEl.innerHTML = `<p class="analysis__note">Stockfish…</p>`;
    const shares = moveShares(chess, data);
    const analysis = await engine.analyze(chess.fen(), depth);
    if (at !== run) return;
    const missing = missingPopularMoves(analysis.lines, shares);
    const extra = missing.length ? (await engine.analyze(chess.fen(), depth, missing)).lines : [];
    if (at !== run) return;
    const lines = [...analysis.lines, ...extra];
    const { shapes, chipsHtml } = engineMovesView(chess, lines, shares, "Play");
    board.set({ drawable: { autoShapes: [...prepShapes, ...shapes] } });
    engineEl.innerHTML = chipsHtml;
    // The best line's evaluation, for White, at the top right.
    if (analysis.lines[0]) {
      evalEl.textContent = formatScore(analysis.lines[0], chess.turn() === "w");
      evalEl.title = `Stockfish, depth ${analysis.depth}`;
    }
  }

  function showExplorer(data: ExplorerData): void {
    const rows = data.moves.filter((m) => m.white + m.draws + m.black > 0);
    if (!rows.length) {
      explorerEl.innerHTML = `<p class="analysis__note">No games</p>`;
      return;
    }
    // A legend first: the percentage is a score, not how often it's played.
    const head = `<div class="explorer-row explorer-row--head" aria-hidden="true">
      <span>Move</span><span class="explorer-row__share" title="Expected score for ${o.side === "white" ? "White" : "Black"}: wins plus half the draws">Score</span><span></span><span class="explorer-row__games">Games</span>
    </div>`;
    explorerEl.innerHTML = head + rows
      .slice(0, EXPLORER_ROWS)
      .map((m) => {
        const games = m.white + m.draws + m.black;
        const pct = (n: number) => (n / games) * 100;
        const wins = o.side === "white" ? m.white : m.black;
        const expectedScore = ((wins + m.draws / 2) / games) * 100;
        const next = (o.tree ? prepared().includes(m.san) : line[ply] === m.san) ? " explorer-row--next" : "";
        return `<button class="explorer-row${next}" type="button" data-san="${escapeHtml(m.san)}">
          <span class="explorer-row__san">${escapeHtml(m.san)}</span>
          <span class="explorer-row__share" title="Expected score for ${o.side === "white" ? "White" : "Black"}: wins plus half the draws">${expectedScore.toFixed(1)}%</span>
          <span class="explorer-row__bar" aria-hidden="true"><span style="width:${pct(m.white)}%" class="w"></span><span style="width:${pct(m.draws)}%" class="d"></span><span style="width:${pct(m.black)}%" class="b"></span></span>
          <span class="explorer-row__games">${games >= 1000 ? `${Math.round(games / 1000)}k` : games}</span>
        </button>`;
      })
      .join("");
  }

  // --- Controls --------------------------------------------------------------
  el("an-prev").addEventListener("click", () => {
    if (ply > 0) {
      ply -= 1;
      show();
    }
  });
  // On along the line, else along the prep (its main line).
  el("an-next").addEventListener("click", () => {
    const next = ply < line.length ? line[ply] : prepared()[0];
    if (next) play(next);
  });
  prepEl.addEventListener("click", (e) => {
    const button = (e.target as Element).closest<HTMLElement>("button");
    if (!button) return;
    if (button.dataset.san) play(button.dataset.san);
    else if (button.hasAttribute("data-back")) {
      ply = inTree();
      show();
    }
  });
  movesEl.addEventListener("click", (e) => {
    const move = (e.target as Element).closest<HTMLElement>("[data-ply]");
    if (!move) return;
    ply = Number(move.dataset.ply);
    show();
  });
  explorerEl.addEventListener("click", (e) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-san]");
    if (row) play(row.dataset.san as string);
  });
  engineEl.addEventListener("click", (e) => {
    const chip = (e.target as Element).closest<HTMLElement>("[data-move]");
    if (!chip) return;
    const chess = position();
    const move = chess.move({ from: chip.dataset.move!.slice(0, 2), to: chip.dataset.move!.slice(2, 4), promotion: chip.dataset.move!.slice(4) || undefined });
    if (move) play(move.san);
  });
  for (const tool of ["explorer", "engine"] as const) {
    el(`an-tool-${tool}`).addEventListener("click", () => {
      if (tools.has(tool)) tools.delete(tool);
      else tools.add(tool);
      saveTools(tools);
      if (tool === "engine" && !tools.has("engine")) {
        engine?.terminate();
        engine = null;
      }
      show();
    });
  }
  el("an-flip").addEventListener("click", () =>
    board.set({ orientation: board.state.orientation === "white" ? "black" : "white" }),
  );

  // --- Closing: the back arrow, or the phone's back ----------------------
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    window.removeEventListener("popstate", onPop);
    engine?.terminate();
    board.destroy();
    layer.remove();
    document.body.classList.remove("has-layer");
    o.onClose();
  }
  const onPop = () => close();
  // A screen's back arrow is a link: the router closes it.
  if (!o.screen) {
    history.pushState({ analysis: true }, "");
    window.addEventListener("popstate", onPop);
    el("an-back").addEventListener("click", () => history.back());
  }

  show();
  return close;
}
