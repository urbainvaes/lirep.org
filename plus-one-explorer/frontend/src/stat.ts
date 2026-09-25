import { Chart } from "chart.js/auto";
import { Chess } from "chess.js";

import { Engine, type EngineLine } from "./engine";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerUrl,
  fetchExplorerDefaults,
  ratingOptionsHtml,
  speedCheckboxesHtml,
  type ExplorerData,
  type ExplorerDefaults,
  type ExplorerSettings,
  type ExplorerSpeed,
} from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, sanPathTo, type StudyTree } from "./tree";

// winProbability/coverage and evalCp/evalMisses are computed by two
// independent buttons now ("Update win probability" / "Update expected
// evaluation"), so either half can exist without the other — hence both are
// optional, each paired with its own calculatedAt timestamp.
interface StudyStats {
  winProbability?: number;
  coverage?: number[]; // coverage[i] = fraction of games still in-book after the opponent's (i+1)th move
  winProbabilityCalculatedAt?: string;
  nodesEvaluated?: number; // set together with winProbability, by the same job
  evalCp?: number; // expected Stockfish eval (centipawns, studied side's POV) at the end of prep
  evalMisses?: number; // how many of those leaf positions had no cached cloud eval (counted as 0)
  evalCalculatedAt?: string;
  database: "lichess" | "masters";
  minRating: number | null;
  speeds?: ExplorerSpeed[];
  explorerCalls?: number;
}

// Per-node Stockfish evals (White's POV), keyed by tree node id — static
// data that doesn't depend on Opening Explorer settings, so it's computed
// and stored separately from `stats` (see "Update evaluations" below).
// offTreeCount is how many off-tree opponent replies were also covered by
// the same run — not stored here (that half lives in the shared, global
// eval cache, not this study's own record), just counted, so the "N
// positions evaluated" summary always matches what "Update evaluations"
// actually covers, tree and off-tree combined.
interface StudyEvals {
  byNode: Record<string, number | null>;
  calculatedAt: string;
  misses: number;
  offTreeCount?: number;
}

interface Study {
  id: number;
  name: string;
  tree: StudyTree;
  explorerSettings: ExplorerSettings;
  side: "white" | "black";
  stats: StudyStats | null;
  evals: StudyEvals | null;
}

interface JobStatus<T> {
  status: "running" | "done" | "error";
  done: number;
  total: number | null;
  result: T | null;
  error: string | null;
}

async function startJob(url: string, body?: unknown): Promise<{ jobId: string; total: number | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error("failed to start job");
  const data = await res.json();
  return { jobId: data.jobId, total: data.total ?? null };
}

async function pollJob<T>(jobId: string, onProgress: (done: number, total: number | null) => void): Promise<T> {
  for (;;) {
    const res = await fetch(`/api/jobs/${jobId}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("job status fetch failed");
    const job: JobStatus<T> = await res.json();
    onProgress(job.done, job.total);
    if (job.status === "done") return job.result as T;
    if (job.status === "error") throw new Error(job.error ?? "job failed");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// Starts a backend job and polls it to completion, driving a plain
// (non-animated) percentage bar the whole time — same visual format as
// "Update evaluations"'s bar. The server doesn't know its own job's total
// upfront (it depends on live Explorer branching), so `estimatedTotal` (the
// tree's node count — a reasonable proxy, since work roughly scales with it)
// stands in for display purposes only; the percentage is capped at 100% in
// case the real count runs a little past the estimate.
async function runProgressJob(
  url: string,
  body: unknown,
  estimatedTotal: number,
  fill: HTMLElement,
  label: HTMLElement,
): Promise<Study> {
  const { jobId } = await startJob(url, body);
  return pollJob<Study>(jobId, (done) => {
    const pct = estimatedTotal > 0 ? Math.min(100, Math.round((done / estimatedTotal) * 100)) : 100;
    fill.style.width = `${pct}%`;
    label.textContent = `${done} position${done === 1 ? "" : "s"} checked…`;
  });
}

// A forced mate is capped at this "centipawn" value server-side (see
// backend/app/stats.py) so it can be averaged with ordinary evals.
const MATE_SCORE_CP = 100_000;

function formatEval(cp: number): string {
  if (Math.abs(cp) > MATE_SCORE_CP - 1000) return cp > 0 ? "Forced mate" : "Forced mate against";
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

// Actual checkmate/stalemate/insufficient material on the board — a flat mate
// cap (no distance), matching the backend's own terminal-position handling.
// Doesn't cover threefold repetition / 50-move (rare at the edge of an
// opening tree, and chess.js's and python-chess's "automatic" outcome rules
// don't quite agree there) — those just get engine-analyzed like any other
// non-terminal position instead.
function terminalCp(chess: Chess): number | null {
  if (chess.isCheckmate()) return chess.turn() === "w" ? -MATE_SCORE_CP : MATE_SCORE_CP;
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return 0;
  return null;
}

// A "mate in N" reported by the engine (not yet on the board) gets the same
// distance-sensitive cap the backend applies to Lichess Cloud Eval mate
// scores, so stored evals are comparable regardless of source.
function mateToCappedCp(mateWhitePov: number): number {
  const magnitude = MATE_SCORE_CP - Math.abs(mateWhitePov);
  return mateWhitePov > 0 ? magnitude : -magnitude;
}

// Centipawns (White's POV), from the engine's best line at this position —
// same conversion regardless of whether the position is a tree node or an
// off-tree continuation, since a position's eval doesn't care which.
async function evaluatePosition(engine: Engine, chess: Chess): Promise<number | null> {
  const terminal = terminalCp(chess);
  if (terminal !== null) return terminal;
  const analysis = await engine.analyze(chess.fen());
  const best: EngineLine | undefined = analysis.lines[0];
  const sign = chess.turn() === "w" ? 1 : -1;
  if (best?.scoreMate != null) return mateToCappedCp(best.scoreMate * sign);
  if (best?.scoreCp != null) return best.scoreCp * sign;
  return null;
}

// Every tree node, plus every "opponent played something you didn't prepare
// for" position `eval_score` would otherwise need to ask Lichess's Cloud
// Eval API for live (see backend/app/stats.py) — discovered here using the
// same (already-cached) Opening Explorer data that calculation itself uses,
// so no extra Explorer load either. Returns the FENs found this way so the
// caller can show a real "N positions found" count before evaluating starts.
async function findOffTreePositions(
  tree: StudyTree,
  side: "white" | "black",
  settings: ExplorerSettings,
): Promise<Set<string>> {
  const fens = new Set<string>();
  for (const nodeIdStr of Object.keys(tree.nodes)) {
    const nodeId = Number(nodeIdStr);
    const chess = new Chess();
    for (const san of sanPathTo(tree, nodeId)) chess.move(san);
    if (chess.isGameOver()) continue;

    const studiedSideToMove = (chess.turn() === "w") === (side === "white");
    if (studiedSideToMove) continue; // only opponent positions can go "off tree"

    try {
      const res = await fetch(explorerUrl(chess.fen(), settings), { credentials: "same-origin" });
      if (!res.ok) continue; // best-effort discovery: skip rather than abort the whole run
      const data: ExplorerData = await res.json();
      const node = tree.nodes[nodeId];
      const childSans = new Set(node.children.map((childId) => tree.nodes[childId].san));
      for (const move of data.moves) {
        if (childSans.has(move.san)) continue;
        const child = new Chess(chess.fen());
        child.move(move.san);
        fens.add(child.fen());
      }
    } catch {
      // Network hiccup on our own (cached) /api/explorer — skip this node's
      // off-tree moves rather than fail the whole discovery pass over it.
    }
  }
  return fens;
}

// Bulk-checks the shared, global, FEN-keyed eval cache (backend
// store.cloud_eval_cache) for positions this browser hasn't necessarily seen
// before — e.g. off-tree positions another study's "Update evaluations" run
// (or the server's own Cloud Eval fallback) already covered. Deliberately
// generic (just FENs in, a FEN->cp map of the ones found back out) so
// anything else that wants to avoid recomputing a position's eval can reuse
// it too, not just this one caller. A FEN missing from the result means
// "nothing usable cached yet" — the caller decides what to do about that.
async function lookupEvalCache(fens: string[]): Promise<Record<string, number>> {
  if (fens.length === 0) return {};
  try {
    const res = await fetch("/api/eval-cache/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ fens }),
    });
    if (!res.ok) return {};
    const data: { evals: Record<string, number> } = await res.json();
    return data.evals;
  } catch {
    return {}; // best-effort: worst case, this run evaluates a few positions it didn't strictly need to
  }
}

// Evaluates every position in the tree, plus every off-tree opponent
// continuation `eval_score` would otherwise need Cloud Eval for, with the
// same Stockfish WASM engine used for live analysis in the Study editor —
// entirely in the browser, like Lichess's own analysis board. Incremental:
// a tree node already in `existingByNode`, or an off-tree position already
// in the shared cache (`lookupEvalCache`), is reused as-is rather than
// recomputed — re-running this after nothing's changed does virtually no
// work. No server round-trip per *newly computed* position, so no external
// rate limit and no "sparse coverage" misses there: local Stockfish can
// always produce a value.
async function calculateEvaluationsLocally(
  tree: StudyTree,
  side: "white" | "black",
  settings: ExplorerSettings,
  existingByNode: Record<string, number | null>,
  onProgress: (done: number, total: number) => void,
): Promise<{ byNode: Record<string, number | null>; byFen: Record<string, number | null>; misses: number }> {
  const nodeIds = Object.keys(tree.nodes);
  const offTreeFens = [...(await findOffTreePositions(tree, side, settings))];
  const cachedOffTree = await lookupEvalCache(offTreeFens);

  const nodeIdsToCompute = nodeIds.filter((id) => !(id in existingByNode));
  const offTreeFensToCompute = offTreeFens.filter((fen) => !(fen in cachedOffTree));
  const total = nodeIdsToCompute.length + offTreeFensToCompute.length;
  let done = 0;

  const byNode: Record<string, number | null> = { ...existingByNode };
  const byFen: Record<string, number | null> = { ...cachedOffTree };
  const engine = new Engine();
  try {
    for (const nodeId of nodeIdsToCompute) {
      const chess = new Chess();
      for (const san of sanPathTo(tree, Number(nodeId))) chess.move(san);
      byNode[nodeId] = await evaluatePosition(engine, chess);
      done += 1;
      onProgress(done, total);
    }
    for (const fen of offTreeFensToCompute) {
      byFen[fen] = await evaluatePosition(engine, new Chess(fen));
      done += 1;
      onProgress(done, total);
    }
  } finally {
    engine.terminate();
  }
  // Only keep evaluating positions that are still relevant to the current
  // tree/Explorer response — a stale entry from a deleted branch shouldn't
  // linger in byNode forever (byFen is global and shared, so it's left
  // alone; other studies may still need those entries).
  for (const id of Object.keys(byNode)) {
    if (!(id in tree.nodes)) delete byNode[id];
  }
  const misses = Object.values(byNode).filter((v) => v === null).length + Object.values(byFen).filter((v) => v === null).length;
  return { byNode, byFen, misses };
}

function getStudyId(): number | null {
  const id = new URLSearchParams(window.location.search).get("id");
  return id ? Number(id) : null;
}

async function loadStudy(id: number): Promise<Study | null> {
  const res = await fetch(`/api/studies/${id}`, { credentials: "same-origin" });
  return res.ok ? res.json() : null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statsSourceLabel(stats: StudyStats): string {
  return stats.database === "masters" ? "Masters" : `Players ${stats.minRating ?? "?"}+`;
}

// Gamification tiers for the expected score. 50% is breakeven for any
// opening, so these mark increasingly meaningful practical edges above it.
// Shown as a colored chess piece (see .piece-badge) rather than a medal.
type ScoreTier = "gold" | "silver" | "bronze" | "none";

const TIER_LABELS: Record<ScoreTier, string> = {
  gold: "Gold",
  silver: "Silver",
  bronze: "Bronze",
  none: "Below breakeven",
};

function scoreTier(winProbability: number | undefined): ScoreTier {
  if (winProbability === undefined) return "none";
  const pct = winProbability * 100;
  if (pct >= 60) return "gold";
  if (pct >= 55) return "silver";
  if (pct >= 50) return "bronze";
  return "none";
}

function pieceBadgeHtml(tier: ScoreTier, size: "" | "sm" = ""): string {
  const sizeClass = size ? ` piece-badge--${size}` : "";
  return `<span class="piece-badge piece-badge--${tier}${sizeClass}">♚</span>`;
}

// True once every current tree position has a stored evaluation — i.e.
// "Update evaluations" has run since the last time the tree changed. Purely
// structural: doesn't care whether any off-tree positions are covered too,
// since that's the part "Update expected evaluation" can still fall back on
// live Cloud Eval for regardless.
function evalsAreCurrent(tree: StudyTree, evals: StudyEvals | null): boolean {
  if (!evals) return false;
  return Object.keys(tree.nodes).every((id) => id in evals.byNode);
}

// nodeCounts[i] = how many distinct positions (branches) the tree has
// recorded at move i+1 — i.e. how many of the opponent's replies you've
// memorized a response to by that point, regardless of how often each is
// actually played. Purely structural: no explorer data needed.
function nodeCountsByMove(tree: StudyTree): number[] {
  const counts: number[] = [];
  let level = [tree.rootId];
  let depth = 0;
  while (level.length > 0) {
    const next: number[] = [];
    for (const nodeId of level) next.push(...tree.nodes[nodeId].children);
    depth += 1;
    if (depth % 2 === 0) counts.push(next.length);
    level = next;
  }
  return counts;
}

// Resolves a CSS custom property to its actual computed color, since
// <canvas> (unlike inline SVG) isn't part of the CSS cascade — Chart.js
// needs real color strings, not var(--x) references.
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let coverageChart: Chart | null = null;

// Same chart type and hover behavior as lichess.org's own rating-distribution
// chart (a Chart.js line chart with intersect:false + a generous hit radius,
// so hovering anywhere near the line — not just exactly on a point —
// triggers the tooltip), rebuilt with Chesster's own colors.
function renderCoverageChart(
  canvas: HTMLCanvasElement,
  coverage: number[],
  nodeCounts: number[],
  opponent: string,
): void {
  const primary = cssVar("--primary");
  const textDim = cssVar("--text-dim");
  const border = cssVar("--border");
  const panelBg = cssVar("--panel-bg");
  const textStrong = cssVar("--text-strong");

  const ctx = canvas.getContext("2d");
  const gradient = ctx?.createLinearGradient(0, 0, 0, canvas.height);
  if (gradient) {
    gradient.addColorStop(0, `${primary}66`);
    gradient.addColorStop(1, `${primary}05`);
  }
  const fillStyle = gradient ?? primary;

  coverageChart?.destroy();
  coverageChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: coverage.map((_, i) => `${i + 1}`),
      datasets: [
        {
          data: coverage.map((c) => c * 100),
          borderColor: primary,
          backgroundColor: fillStyle,
          pointBackgroundColor: primary,
          pointHoverBackgroundColor: primary,
          pointHoverBorderColor: textStrong,
          pointHoverBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointHitRadius: 60,
          fill: true,
          tension: 0.15,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false, axis: "x" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: panelBg,
          borderColor: border,
          borderWidth: 1,
          titleColor: textStrong,
          bodyColor: textDim,
          padding: 8,
          displayColors: false,
          callbacks: {
            title: (items) => `After ${opponent}'s move ${items[0].label}`,
            label: (item) => `${(item.raw as number).toFixed(1)}% covered`,
            afterLabel: (item) => {
              const count = nodeCounts[item.dataIndex];
              if (count === undefined) return "";
              return `${count} ${count === 1 ? "move" : "moves"} remembered`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: border },
          ticks: { color: textDim },
          title: { display: true, text: `${opponent}'s move number`, color: textDim },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: border },
          ticks: { color: textDim, callback: (value) => `${value}%` },
          title: { display: true, text: "Coverage", color: textDim },
        },
      },
    },
  });
}

function readSettingsFromDom(): ExplorerSettings {
  const database = (document.getElementById("stat-database") as HTMLSelectElement).value as ExplorerSettings["database"];
  const minRatingEl = document.getElementById("stat-min-rating") as HTMLSelectElement;
  const minRating = minRatingEl.value === "auto" ? null : Number(minRatingEl.value);
  const speeds = Array.from(
    document.querySelectorAll<HTMLInputElement>("#stat-speeds input:checked"),
  ).map((cb) => cb.value as ExplorerSpeed);
  return { enabled: true, database, minRating, speeds };
}

function renderPage(main: HTMLElement, study: Study, explorerDefaults: ExplorerDefaults | null): void {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sideDotClass = `side-dot side-dot--${study.side}`;
  const opponent = study.side === "white" ? "Black" : "White";
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;
  const stats = study.stats;
  const evals = study.evals;
  const settings = study.explorerSettings ?? { ...DEFAULT_EXPLORER_SETTINGS };
  const ratingBuckets = explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  const allSpeeds = explorerDefaults?.speeds ?? (["bullet", "blitz", "rapid", "classical"] as ExplorerSpeed[]);

  const tier = scoreTier(stats?.winProbability);
  const evalsCurrent = evalsAreCurrent(study.tree, evals);

  const winProbCardHtml =
    stats?.winProbability !== undefined
      ? `<div class="stat-detail__score">${(stats.winProbability * 100).toFixed(1)}%</div>
         <p class="stat-card__label">Win probability</p>
         <p class="stat-card__meta">Expected score, assuming perfect memorization<br>${statsSourceLabel(stats)} · ${stats.nodesEvaluated ?? 0} positions evaluated · as of ${formatDate(stats.winProbabilityCalculatedAt ?? "")}</p>`
      : `<div class="stat-detail__score stat-card__score--empty">—</div>
         <p class="stat-card__label">Win probability</p>
         <p class="stat-card__meta">Not calculated yet.</p>`;

  const evalCardHtml =
    stats?.evalCp !== undefined
      ? `<div class="stat-detail__score">${formatEval(stats.evalCp)}</div>
         <p class="stat-card__label">Expected evaluation at the end of prep</p>
         <p class="stat-card__meta">From ${study.side === "white" ? "White" : "Black"}'s point of view · as of ${formatDate(stats.evalCalculatedAt ?? "")}${
           stats.evalMisses
             ? `<br>${stats.evalMisses} end-of-prep position${stats.evalMisses === 1 ? "" : "s"} had no cached engine eval yet (counted as 0.00)`
             : ""
         }</p>`
      : `<div class="stat-detail__score stat-card__score--empty">—</div>
         <p class="stat-card__label">Expected evaluation at the end of prep</p>
         <p class="stat-card__meta">Not calculated yet.</p>`;

  main.innerHTML = `
    <a class="btn btn-secondary" href="/stats.html">&larr; Back to Stats</a>
    <div class="stat-page">
      <div class="stat-page__header">
        <h1>
          <button type="button" id="piece-badge" class="piece-badge-btn" aria-label="Score tier: ${TIER_LABELS[tier]} — click for details">
            ${pieceBadgeHtml(tier)}
          </button>
          ${escapeHtml(study.name)}
        </h1>
        <span class="stat-card__side"><span class="${sideDotClass}"></span>${sideLabel}</span>
      </div>
      <div class="piece-legend" id="piece-legend" hidden>
        <p class="piece-legend__title">Score tiers, by win probability</p>
        <div class="piece-legend__row">${pieceBadgeHtml("gold", "sm")}<span>Gold — 60% or higher</span></div>
        <div class="piece-legend__row">${pieceBadgeHtml("silver", "sm")}<span>Silver — 55% or higher</span></div>
        <div class="piece-legend__row">${pieceBadgeHtml("bronze", "sm")}<span>Bronze — 50% or higher</span></div>
        <div class="piece-legend__row">${pieceBadgeHtml("none", "sm")}<span>Below 50% — behind on average</span></div>
      </div>

      <div class="stat-metrics">
        <div class="stat-metric-card">${winProbCardHtml}</div>
        <div class="stat-metric-card">${evalCardHtml}</div>
      </div>

      <div class="stat-actions stat-actions--single">
        <div class="stat-action">
          <p class="tree-hint">
            Expected evaluation needs a Stockfish assessment of every position that
            matters for it — computing that here, once, locally in your browser,
            means updating the expected evaluation later never has to ask Lichess
            for it.
          </p>
          <div class="eval-update-row">
            <button id="evals-btn" class="btn btn-secondary" type="button" ${hasMoves ? "" : "disabled"}>
              Update evaluations
            </button>
            ${evalsCurrent ? `<span class="status-check" title="Up to date with the current tree">✓</span>` : ""}
          </div>
          <p class="stat-card__meta">
            ${
              evals
                ? (() => {
                    const total = Object.keys(evals.byNode).length + (evals.offTreeCount ?? 0);
                    return `${total} position${total === 1 ? "" : "s"} evaluated${evals.misses ? `, ${evals.misses} failed` : ""} · as of ${formatDate(evals.calculatedAt)}${evalsCurrent ? "" : " · tree has changed since — you may want to update"}`;
                  })()
                : "Not calculated yet."
            }
          </p>
          <div class="progress-bar" id="evals-progress" hidden>
            <div class="progress-bar__track"><div class="progress-bar__fill" id="evals-progress-fill"></div></div>
            <span class="progress-bar__label" id="evals-progress-label"></span>
          </div>
        </div>
      </div>

      <div class="stat-actions">
        <div class="stat-action">
          <button id="winprob-btn" class="btn btn-primary" type="button" ${hasMoves ? "" : "disabled"}>
            Update win probability
          </button>
          <p class="stat-card__meta">Uses the Opening Explorer settings below.</p>
          <div class="progress-bar" id="winprob-progress" hidden>
            <div class="progress-bar__track"><div class="progress-bar__fill" id="winprob-progress-fill"></div></div>
            <span class="progress-bar__label" id="winprob-progress-label"></span>
          </div>
        </div>

        <div class="stat-action">
          <button id="eval-score-btn" class="btn ${evals ? "btn-primary" : "btn-warning"}" type="button" ${hasMoves ? "" : "disabled"}>
            Update expected evaluation
          </button>
          <p class="stat-card__meta${evals ? "" : " stat-card__meta--warning"}">
            ${
              evals
                ? "Uses the Opening Explorer settings below, and your calculated evaluations."
                : `⚠ Evaluations haven't been calculated yet — click "Update evaluations" above first, or this may be slow and can hit Lichess's rate limit.`
            }
          </p>
          <div class="progress-bar" id="eval-score-progress" hidden>
            <div class="progress-bar__track"><div class="progress-bar__fill" id="eval-score-progress-fill"></div></div>
            <span class="progress-bar__label" id="eval-score-progress-label"></span>
          </div>
        </div>
      </div>

      <h2 class="stat-detail__chart-title">Opening Explorer settings</h2>
      <p class="tree-hint">
        Scores are calculated by weighting ${opponent}'s replies by how often real players actually
        choose them, at these settings. Change them and recalculate to see how your scores hold up
        against a different pool of opponents.
      </p>
      <div class="explorer-settings-panel">
        <div class="analysis-header__settings">
          <select id="stat-database">
            <option value="lichess" ${settings.database === "lichess" ? "selected" : ""}>Players</option>
            <option value="masters" ${settings.database === "masters" ? "selected" : ""}>Masters</option>
          </select>
          <select id="stat-min-rating" ${settings.database === "lichess" ? "" : "disabled"}>
            ${ratingOptionsHtml(ratingBuckets, settings.minRating)}
          </select>
        </div>
        <div class="speed-checkboxes" id="stat-speeds">
          ${speedCheckboxesHtml(allSpeeds, settings.speeds, settings.database !== "lichess")}
        </div>
      </div>

      <h2 class="stat-detail__chart-title">Coverage by ${opponent.toLowerCase()}'s move number</h2>
      <p class="tree-hint">
        What fraction of real games (by move frequency, at this study's Opening Explorer settings)
        are still following a line inside this study after each of ${opponent}'s replies. Your own
        moves never reduce this — by the one-move-per-position rule, you always have exactly one
        prepared reply — so every drop here comes from an ${opponent} move you haven't covered.
      </p>
      <div class="coverage-chart-wrap">
        ${
          stats?.coverage?.length
            ? `<canvas id="coverage-chart"></canvas>`
            : `<p class="empty-state">No coverage data yet — recalculate to generate it.</p>`
        }
      </div>
    </div>
  `;

  if (stats?.coverage?.length) {
    const canvas = document.getElementById("coverage-chart") as HTMLCanvasElement;
    renderCoverageChart(canvas, stats.coverage, nodeCountsByMove(study.tree), opponent);
  }

  document.getElementById("piece-badge")?.addEventListener("click", () => {
    const legend = document.getElementById("piece-legend") as HTMLElement;
    legend.hidden = !legend.hidden;
  });

  const databaseEl = document.getElementById("stat-database") as HTMLSelectElement;
  const minRatingEl = document.getElementById("stat-min-rating") as HTMLSelectElement;
  const speedsEl = document.getElementById("stat-speeds") as HTMLElement;

  databaseEl.addEventListener("change", () => {
    const isLichess = databaseEl.value === "lichess";
    minRatingEl.disabled = !isLichess;
    speedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = !isLichess;
    });
  });

  speedsEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.type !== "checkbox") return;
    const checkedCount = speedsEl.querySelectorAll<HTMLInputElement>("input:checked").length;
    if (!target.checked && checkedCount === 0) target.checked = true; // keep at least one speed selected
  });

  const allActionButtons = () =>
    ["evals-btn", "winprob-btn", "eval-score-btn"]
      .map((id) => document.getElementById(id) as HTMLButtonElement)
      .filter((el): el is HTMLButtonElement => el !== null);

  document.getElementById("evals-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const others = allActionButtons().filter((el) => el !== btn);
    const progress = document.getElementById("evals-progress") as HTMLElement;
    const fill = document.getElementById("evals-progress-fill") as HTMLElement;
    const label = document.getElementById("evals-progress-label") as HTMLElement;

    allActionButtons().forEach((el) => (el.disabled = true));
    btn.textContent = "Calculating…";
    progress.hidden = false;
    progress.classList.add("progress-bar--indeterminate");
    fill.style.width = "0%";
    label.textContent = "Finding positions to evaluate…";
    label.classList.remove("progress-bar__label--error");
    progress.classList.remove("progress-bar--error");

    try {
      const { byNode, byFen, misses } = await calculateEvaluationsLocally(
        study.tree,
        study.side,
        readSettingsFromDom(),
        study.evals?.byNode ?? {},
        (done, total) => {
          progress.classList.remove("progress-bar--indeterminate");
          if (total === 0) {
            fill.style.width = "100%";
            label.textContent = "Already up to date";
            return;
          }
          fill.style.width = `${Math.round((done / total) * 100)}%`;
          label.textContent = `${done} / ${total}`;
        },
      );
      const res = await fetch(`/api/studies/${study.id}/evals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ byNode, byFen, misses }),
      });
      if (!res.ok) throw new Error("failed to save evaluations");
      const updated: Study = await res.json();
      renderPage(main, updated, explorerDefaults);
    } catch (err) {
      btn.textContent = "Update evaluations";
      btn.disabled = false;
      others.forEach((el) => (el.disabled = false));
      progress.classList.remove("progress-bar--indeterminate");
      label.textContent = err instanceof Error ? err.message : "Something went wrong.";
      label.classList.add("progress-bar__label--error");
      progress.classList.add("progress-bar--error");
      fill.style.width = "0%";
    }
  });

  document.getElementById("winprob-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const others = allActionButtons().filter((el) => el !== btn);
    const progress = document.getElementById("winprob-progress") as HTMLElement;
    const fill = document.getElementById("winprob-progress-fill") as HTMLElement;
    const label = document.getElementById("winprob-progress-label") as HTMLElement;

    allActionButtons().forEach((el) => (el.disabled = true));
    btn.textContent = "Calculating…";
    progress.hidden = false;
    fill.style.width = "0%";
    label.textContent = "";
    label.classList.remove("progress-bar__label--error");
    progress.classList.remove("progress-bar--error");

    try {
      const estimatedTotal = Object.keys(study.tree.nodes).length;
      const updated = await runProgressJob(
        `/api/studies/${study.id}/win-probability`,
        { explorerSettings: readSettingsFromDom() },
        estimatedTotal,
        fill,
        label,
      );
      renderPage(main, updated, explorerDefaults);
    } catch (err) {
      btn.textContent = "Update win probability";
      btn.disabled = false;
      others.forEach((el) => (el.disabled = false));
      label.textContent = err instanceof Error ? err.message : "Something went wrong.";
      label.classList.add("progress-bar__label--error");
      progress.classList.add("progress-bar--error");
      fill.style.width = "0%";
    }
  });

  document.getElementById("eval-score-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const others = allActionButtons().filter((el) => el !== btn);
    const progress = document.getElementById("eval-score-progress") as HTMLElement;
    const fill = document.getElementById("eval-score-progress-fill") as HTMLElement;
    const label = document.getElementById("eval-score-progress-label") as HTMLElement;

    allActionButtons().forEach((el) => (el.disabled = true));
    btn.textContent = "Calculating…";
    progress.hidden = false;
    fill.style.width = "0%";
    label.textContent = "";
    label.classList.remove("progress-bar__label--error");
    progress.classList.remove("progress-bar--error");

    try {
      const estimatedTotal = Object.keys(study.tree.nodes).length;
      const updated = await runProgressJob(
        `/api/studies/${study.id}/expected-eval`,
        { explorerSettings: readSettingsFromDom() },
        estimatedTotal,
        fill,
        label,
      );
      renderPage(main, updated, explorerDefaults);
    } catch (err) {
      btn.textContent = "Update expected evaluation";
      btn.disabled = false;
      others.forEach((el) => (el.disabled = false));
      label.textContent = err instanceof Error ? err.message : "Something went wrong.";
      label.classList.add("progress-bar__label--error");
      progress.classList.add("progress-bar--error");
      fill.style.width = "0%";
    }
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("stat-main");
  if (!main) return;

  if (!me.authenticated) {
    main.innerHTML = `
      <div class="empty-state">
        <p>Sign in with your Lichess account to see study stats.</p>
        <a class="btn btn-primary" href="/auth/login">Sign in</a>
      </div>
    `;
    return;
  }

  const studyId = getStudyId();
  const [study, explorerDefaults] = await Promise.all([
    studyId ? loadStudy(studyId) : Promise.resolve(null),
    fetchExplorerDefaults(),
  ]);
  if (!study) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  renderPage(main, study, explorerDefaults);
}

init();
