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
  winRate?: number;
  lossProbability?: number;
  coverage?: number[]; // coverage[i] = fraction of games still in-book after the opponent's (i+1)th move
  winProbabilityCalculatedAt?: string;
  nodesEvaluated?: number; // set together with winProbability, by the same job
  evalCp?: number; // expected Stockfish eval (centipawns, studied side's POV) at the end of prep
  evalMisses?: number; // how many of those leaf positions had no cached cloud eval (counted as 0)
  evalCalculatedAt?: string;
  source?: "lirep" | "lichess";
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
  // null (the default) means every stat below is calculated from the tree's
  // real root — see starting-point.md.
  startNodeId: number | null;
}

interface PracticeSummary {
  aggregateKnowledge: number | null;
}

async function loadPracticeKnowledge(studyId: number): Promise<number | null> {
  try {
    const res = await fetch("/api/practice/summary", { credentials: "same-origin" });
    if (!res.ok) return null;
    const summaries: Record<string, PracticeSummary> = await res.json();
    return summaries[String(studyId)]?.aggregateKnowledge ?? null;
  } catch {
    return null;
  }
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

interface RequiredEvaluations {
  nodeIds: Set<string>;
  offTreeFens: Set<string>;
}

// Follow the expected-evaluation tree walk and collect only the positions at
// its frontier: prepared-side leaves, opponent nodes with no games, and
// positions one opponent move beyond the prepared tree.
async function findRequiredEvaluations(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
): Promise<RequiredEvaluations> {
  const nodeIds = new Set<string>();
  const offTreeFens = new Set<string>();

  async function walk(nodeId: number, chess: Chess): Promise<void> {
    if (chess.isGameOver()) return;
    const node = tree.nodes[nodeId];
    const studiedSideToMove = (chess.turn() === "w") === (side === "white");

    if (studiedSideToMove) {
      if (node.children.length === 0) nodeIds.add(String(nodeId));
      else {
        const childId = node.children[0];
        const child = new Chess(chess.fen());
        child.move(tree.nodes[childId].san);
        await walk(childId, child);
      }
      return;
    }

    const res = await fetch(explorerUrl(chess.fen(), settings), { credentials: "same-origin" });
    if (!res.ok) throw new Error("failed to find required positions in Opening Explorer");
    const data: ExplorerData = await res.json();
    const totalGames = data.moves.reduce((total, move) => total + move.white + move.draws + move.black, 0);
    if (totalGames === 0) {
      nodeIds.add(String(nodeId));
      return;
    }

    const childrenBySan = new Map(node.children.map((childId) => [tree.nodes[childId].san, childId]));
    for (const move of data.moves) {
      if (move.white + move.draws + move.black === 0) continue;
      const childId = childrenBySan.get(move.san);
      const child = new Chess(chess.fen());
      child.move(move.san);
      if (childId === undefined) offTreeFens.add(child.fen());
      else await walk(childId, child);
    }
  }

  const start = new Chess();
  for (const san of sanPathTo(tree, startNodeId)) start.move(san);
  await walk(startNodeId, start);
  return { nodeIds, offTreeFens };
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

// Evaluate only frontier positions expected evaluation will consume. Existing
// node evals and globally cached off-tree evals are reused; checkpoint batches
// so leaving the page doesn't discard the whole run.
async function calculateEvaluationsLocally(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
  existingByNode: Record<string, number | null>,
  onPlan: (ready: number, required: number, work: number) => void,
  onProgress: (done: number, total: number) => void,
  onCheckpoint: (
    byNode: Record<string, number | null>,
    byFen: Record<string, number | null>,
    misses: number,
    ready: number,
  ) => Promise<void>,
): Promise<{ byNode: Record<string, number | null>; byFen: Record<string, number | null>; misses: number }> {
  const required = await findRequiredEvaluations(tree, startNodeId, side, settings);
  const nodeIds = [...required.nodeIds];
  const offTreeFens = [...required.offTreeFens];
  const cachedOffTree = await lookupEvalCache(offTreeFens);

  const nodeIdsToCompute = nodeIds.filter((id) => !(id in existingByNode));
  const offTreeFensToCompute = offTreeFens.filter((fen) => !(fen in cachedOffTree));
  const total = nodeIdsToCompute.length + offTreeFensToCompute.length;
  const requiredTotal = nodeIds.length + offTreeFens.length;
  const initiallyReady = requiredTotal - total;
  let done = 0;
  onPlan(initiallyReady, requiredTotal, total);

  const byNode: Record<string, number | null> = { ...existingByNode };
  const byFen: Record<string, number | null> = { ...cachedOffTree };
  const readyCount = () =>
    nodeIds.filter((id) => id in byNode).length + offTreeFens.filter((fen) => fen in byFen).length;
  const missCount = () =>
    nodeIds.filter((id) => byNode[id] === null).length + offTreeFens.filter((fen) => byFen[fen] === null).length;
  const checkpoint = async () =>
    onCheckpoint(byNode, byFen, missCount(), readyCount());
  const engine = new Engine();
  try {
    for (const nodeId of nodeIdsToCompute) {
      const chess = new Chess();
      for (const san of sanPathTo(tree, Number(nodeId))) chess.move(san);
      byNode[nodeId] = await evaluatePosition(engine, chess);
      done += 1;
      onProgress(done, total);
      if (done % 5 === 0) await checkpoint();
    }
    for (const fen of offTreeFensToCompute) {
      byFen[fen] = await evaluatePosition(engine, new Chess(fen));
      done += 1;
      onProgress(done, total);
      if (done % 5 === 0) await checkpoint();
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
  const misses = missCount();
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

function statsSourceLabel(stats: StudyStats, fallbackSource: ExplorerSettings["source"]): string {
  const provider = (stats.source ?? fallbackSource) === "lirep" ? "Lirep (Mar 2016)" : "Lichess";
  const database = stats.database === "masters" ? "Masters" : `Players ${stats.minRating ?? "?"}+`;
  return `${provider} ${database}`;
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

// null when there's nothing to say (no starting point set, or it's just the
// real root) — see starting-point.md.
function describeStartPoint(tree: StudyTree, startNodeId: number | null): string | null {
  if (startNodeId === null || startNodeId === tree.rootId) return null;
  const node = tree.nodes[startNodeId];
  if (!node || node.san === null) return null;
  const ply = sanPathTo(tree, startNodeId).length;
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  return `${moveNumber}.${isWhite ? "" : ".."}${node.san}`;
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
// triggers the tooltip), rebuilt with lirep.org's own colors.
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
  const source = (document.getElementById("stat-source") as HTMLSelectElement).value as ExplorerSettings["source"];
  const database = (document.getElementById("stat-database") as HTMLSelectElement).value as ExplorerSettings["database"];
  const minRatingEl = document.getElementById("stat-min-rating") as HTMLSelectElement;
  const minRating = minRatingEl.value === "auto" ? null : Number(minRatingEl.value);
  const speeds = Array.from(
    document.querySelectorAll<HTMLInputElement>("#stat-speeds input:checked"),
  ).map((cb) => cb.value as ExplorerSpeed);
  return { enabled: true, source, database, minRating, speeds };
}

function renderPage(
  main: HTMLElement,
  study: Study,
  explorerDefaults: ExplorerDefaults | null,
  knowledge: number | null,
): void {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sidePawn = `<span class="side-pawn side-pawn--${study.side}">${study.side === "white" ? "♙" : "♟"}</span>`;
  const opponent = study.side === "white" ? "Black" : "White";
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;
  const stats = study.stats;
  const evals = study.evals;
  const settings = study.explorerSettings ?? { ...DEFAULT_EXPLORER_SETTINGS };
  const ratingBuckets = explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  const allSpeeds = explorerDefaults?.speeds ?? (["bullet", "blitz", "rapid", "classical"] as ExplorerSpeed[]);

  const tier = scoreTier(stats?.winProbability);
  const savedEvalCount = evals ? Object.keys(evals.byNode).length + (evals.offTreeCount ?? 0) : 0;
  const startPoint = describeStartPoint(study.tree, study.startNodeId);
  const startPointNote = startPoint ? ` — from move ${startPoint} onward` : "";

  const winProbCardHtml =
    stats?.winRate !== undefined && stats.lossProbability !== undefined
      ? (() => {
          const drawProbability = Math.max(0, Math.min(1, 1 - stats.winRate! - stats.lossProbability!));
          return `<div class="stat-outcome-pair">
              <div class="stat-detail__score">${(stats.winRate * 100).toFixed(1)}%</div>
              <div class="stat-loss-probability" aria-label="Loss probability ${(stats.lossProbability * 100).toFixed(1)}%"><strong>${(stats.lossProbability * 100).toFixed(1)}%</strong></div>
            </div>
            <p class="stat-card__label">Win probability${startPointNote}</p>
            <p class="stat-card__meta">Draws are the remaining probability. Expected score ${((stats.winProbability ?? stats.winRate + drawProbability / 2) * 100).toFixed(1)}% · ${statsSourceLabel(stats, settings.source)} · ${stats.nodesEvaluated ?? 0} positions evaluated · as of ${formatDate(stats.winProbabilityCalculatedAt ?? "")}</p>`;
        })()
      : stats?.winProbability !== undefined
        ? `<div class="stat-detail__score">${(stats.winProbability * 100).toFixed(1)}%</div>
           <p class="stat-card__label">Expected score${startPointNote}</p>
           <p class="stat-card__meta">Recalculate to show win/draw/loss probabilities.</p>`
      : `<div class="stat-detail__score stat-card__score--empty">—</div>
         <p class="stat-card__label">Win probability${startPointNote}</p>
         <p class="stat-card__meta">Not calculated yet.</p>`;

  const evalCardHtml =
    stats?.evalCp !== undefined
      ? `<div class="stat-detail__score">${formatEval(stats.evalCp)}</div>
         <p class="stat-card__label">Expected evaluation at the end of prep${startPointNote}</p>
         <p class="stat-card__meta">From ${study.side === "white" ? "White" : "Black"}'s point of view · as of ${formatDate(stats.evalCalculatedAt ?? "")}${
           stats.evalMisses
             ? `<br>${stats.evalMisses} end-of-prep position${stats.evalMisses === 1 ? "" : "s"} had no cached engine eval yet (counted as 0.00)`
             : ""
         }</p>`
      : `<div class="stat-detail__score stat-card__score--empty">—</div>
         <p class="stat-card__label">Expected evaluation at the end of prep${startPointNote}</p>
         <p class="stat-card__meta">Not calculated yet.</p>`;
  const knowledgeCardHtml = knowledge !== null
    ? `<div class="stat-detail__score">${Math.round(knowledge * 100)}%</div>
       <p class="stat-card__label">Practice knowledge</p>
       <p class="stat-card__meta">Average recall across all positions; decays over time.</p>`
    : `<div class="stat-detail__score stat-card__score--empty">—</div>
       <p class="stat-card__label">Practice knowledge</p>
       <p class="stat-card__meta">No practice positions yet.</p>`;

  main.innerHTML = `
    <div class="stat-page">
      <div class="stat-page__header">
        <h1>
          <button type="button" id="piece-badge" class="piece-badge-btn" aria-label="Score tier: ${TIER_LABELS[tier]} — click for details">
            ${pieceBadgeHtml(tier)}
          </button>
          ${escapeHtml(study.name)}
        </h1>
        <span class="stat-card__side">${sidePawn}${sideLabel}</span>
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
        <div class="stat-metric-card">${knowledgeCardHtml}</div>
      </div>

      <h2 class="stat-detail__chart-title">Analysis</h2>
      <div class="stat-actions stat-actions--single">
        <div class="stat-action">
          <div class="eval-update-row">
            <button id="evals-btn" class="btn btn-secondary" type="button" ${hasMoves ? "" : "disabled"}>
              Update evaluations
            </button>
            <span id="evals-count" class="eval-count" aria-live="polite">${savedEvalCount} saved evaluations; click to check required positions</span>
          </div>
          <p class="stat-card__meta">
            ${
              evals
                ? (() => {
                    const total = Object.keys(evals.byNode).length + (evals.offTreeCount ?? 0);
                    return `${total} position${total === 1 ? "" : "s"} evaluated${evals.misses ? `, ${evals.misses} failed` : ""} · as of ${formatDate(evals.calculatedAt)}`;
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

      <div class="stat-actions stat-actions--compact">
        <div class="stat-action">
          <button id="winprob-btn" class="btn btn-primary" type="button" ${hasMoves ? "" : "disabled"}>
            Update win probability
          </button>
          <p class="stat-card__meta">Based on how often players choose each reply.</p>
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
                ? "Combines Explorer data with calculated evaluations."
                : `Calculate evaluations first. This may be slow and can hit Lichess's rate limit.`
            }
          </p>
          <div class="progress-bar" id="eval-score-progress" hidden>
            <div class="progress-bar__track"><div class="progress-bar__fill" id="eval-score-progress-fill"></div></div>
            <span class="progress-bar__label" id="eval-score-progress-label"></span>
          </div>
        </div>
      </div>

      <details class="stat-settings">
        <summary>Opening Explorer settings</summary>
        <p class="stat-card__meta">These settings determine which replies are weighted in recalculated scores.</p>
        <div class="explorer-settings-panel">
          <div class="analysis-header__settings">
            <select id="stat-source" aria-label="Explorer data source">
              <option value="lirep" ${settings.source === "lirep" ? "selected" : ""} ${explorerDefaults?.lirepAvailable ? "" : "disabled"}>Lirep</option>
              <option value="lichess" ${settings.source === "lichess" ? "selected" : ""}>Lichess</option>
            </select>
            <select id="stat-database" aria-label="Lichess database" ${settings.source === "lirep" ? "disabled" : ""}>
              <option value="lichess" ${settings.database === "lichess" ? "selected" : ""}>Players</option>
              <option value="masters" ${settings.database === "masters" ? "selected" : ""} ${settings.source === "lirep" ? "disabled" : ""}>Masters</option>
            </select>
            <select id="stat-min-rating" ${settings.database === "lichess" ? "" : "disabled"}>
              ${ratingOptionsHtml(ratingBuckets, settings.minRating)}
            </select>
          </div>
          <div class="speed-checkboxes" id="stat-speeds">
            ${speedCheckboxesHtml(allSpeeds, settings.speeds, settings.database !== "lichess")}
          </div>
        </div>
      </details>

      <h2 class="stat-detail__chart-title">Coverage by ${opponent.toLowerCase()}'s move number</h2>
      <p class="tree-hint">Share of games still following your lines after each ${opponent} reply.${startPoint ? ` Move numbers start from ${startPoint}.` : ""}</p>
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
  const sourceEl = document.getElementById("stat-source") as HTMLSelectElement;
  const minRatingEl = document.getElementById("stat-min-rating") as HTMLSelectElement;
  const speedsEl = document.getElementById("stat-speeds") as HTMLElement;

  function updateExplorerControls(): void {
    databaseEl.disabled = sourceEl.value === "lirep";
    databaseEl.querySelector<HTMLOptionElement>('option[value="masters"]')!.disabled = sourceEl.value === "lirep";
    const playersSelected = databaseEl.value === "lichess";
    minRatingEl.disabled = !playersSelected;
    speedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = !playersSelected;
    });
  }

  sourceEl.addEventListener("change", () => {
    if (sourceEl.value === "lirep" && databaseEl.value === "masters") databaseEl.value = "lichess";
    updateExplorerControls();
  });

  databaseEl.addEventListener("change", updateExplorerControls);

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
    const count = document.getElementById("evals-count") as HTMLElement;
    let readyPositions = 0;
    let initialReadyPositions = 0;
    let requiredPositions = 0;
    let planReady = false;

    allActionButtons().forEach((el) => (el.disabled = true));
    btn.textContent = "Calculating…";
    progress.hidden = false;
    progress.classList.add("progress-bar--indeterminate");
    fill.style.width = "0%";
    label.textContent = "Finding required positions…";
    label.classList.remove("progress-bar__label--error");
    progress.classList.remove("progress-bar--error");

    try {
      const { byNode, byFen, misses } = await calculateEvaluationsLocally(
        study.tree,
        study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId,
        study.side,
        readSettingsFromDom(),
        study.evals?.byNode ?? {},
        (ready, required, work) => {
          planReady = true;
          readyPositions = ready;
          initialReadyPositions = ready;
          requiredPositions = required;
          count.textContent = `${ready} / ${required} required positions ready (${required - ready} to calculate)`;
          progress.classList.remove("progress-bar--indeterminate");
          fill.style.width = work === 0 ? "100%" : "0%";
          label.textContent = work === 0 ? "Already up to date" : `0 / ${work}`;
        },
        (done, total) => {
          const calculated = Math.min(requiredPositions, initialReadyPositions + done);
          count.textContent = `${calculated} / ${requiredPositions} required positions calculated (${requiredPositions - calculated} remaining)`;
          progress.classList.remove("progress-bar--indeterminate");
          if (total === 0) {
            fill.style.width = "100%";
            label.textContent = "Already up to date";
            return;
          }
          fill.style.width = `${Math.round((done / total) * 100)}%`;
          label.textContent = `${done} / ${total}`;
        },
        async (byNode, byFen, misses, ready) => {
          const res = await fetch(`/api/studies/${study.id}/evals`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ byNode, byFen, misses }),
          });
          if (!res.ok) throw new Error("failed to save evaluation checkpoint");
          readyPositions = ready;
          count.textContent = `${ready} / ${requiredPositions} required positions saved (${requiredPositions - ready} remaining)`;
        },
      );
      count.textContent = `${requiredPositions} / ${requiredPositions} required positions calculated (0 remaining)`;
      const res = await fetch(`/api/studies/${study.id}/evals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ byNode, byFen, misses }),
      });
      if (!res.ok) throw new Error("failed to save evaluations");
      const updated: Study = await res.json();
      renderPage(main, updated, explorerDefaults, knowledge);
    } catch (err) {
      if (planReady) {
        count.textContent = `${readyPositions} / ${requiredPositions} required positions saved (${requiredPositions - readyPositions} remaining)`;
      }
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
      renderPage(main, updated, explorerDefaults, knowledge);
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
      renderPage(main, updated, explorerDefaults, knowledge);
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
  const [study, explorerDefaults, knowledge] = await Promise.all([
    studyId ? loadStudy(studyId) : Promise.resolve(null),
    fetchExplorerDefaults(),
    studyId ? loadPracticeKnowledge(studyId) : Promise.resolve(null),
  ]);
  if (!study) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  renderPage(main, study, explorerDefaults, knowledge);
}

init();
