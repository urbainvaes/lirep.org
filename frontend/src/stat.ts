import { Chart } from "chart.js/auto";
import { Chess } from "chess.js";

import { Engine, type EngineLine } from "./engine";
import { openEvaluationCache, type EvaluationCache } from "./evalCache";
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
  evalMisses?: number; // positions without a usable local engine evaluation (counted as 0)
  evalCalculatedAt?: string;
  evalOrigin?: "local";
  source?: "lirep" | "lichess";
  database: "lichess" | "masters";
  minRating: number | null;
  speeds?: ExplorerSpeed[];
  explorerCalls?: number;
}

// Older studies may still have server-side per-node evaluations. Import them
// into this browser's FEN cache; new evaluations stay in IndexedDB.
interface StudyEvals {
  byNode: Record<string, number | null>;
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

// A forced mate is capped at this centipawn value so it can be averaged
// with ordinary evaluations.
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
  if (chess.isDraw()) return 0;
  return null;
}

// A "mate in N" reported by the engine (not yet on the board) gets the same
// distance-sensitive cap used for all position evaluations.
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

// Follow the expected-evaluation tree walk and collect only the positions at
// its frontier: prepared-side leaves, opponent nodes with no games, and
// positions one opponent move beyond the prepared tree.
async function findRequiredEvaluations(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
  explorerCache: Map<string, ExplorerData>,
): Promise<Set<string>> {
  const positions = new Set<string>();

  async function walk(nodeId: number, chess: Chess): Promise<void> {
    if (chess.isGameOver()) return;
    const node = tree.nodes[nodeId];
    const studiedSideToMove = (chess.turn() === "w") === (side === "white");

    if (studiedSideToMove) {
      if (node.children.length === 0) positions.add(chess.fen());
      else {
        const childId = node.children[0];
        const child = new Chess(chess.fen());
        child.move(tree.nodes[childId].san);
        await walk(childId, child);
      }
      return;
    }

    const data = await fetchExplorerPosition(chess.fen(), settings, explorerCache);
    const totalGames = data.moves.reduce((total, move) => total + move.white + move.draws + move.black, 0);
    if (totalGames === 0) {
      positions.add(chess.fen());
      return;
    }

    const childrenBySan = new Map(node.children.map((childId) => [tree.nodes[childId].san, childId]));
    for (const move of data.moves) {
      if (move.white + move.draws + move.black === 0) continue;
      const childId = childrenBySan.get(move.san);
      const child = new Chess(chess.fen());
      child.move(move.san);
      if (childId === undefined) positions.add(child.fen());
      else await walk(childId, child);
    }
  }

  const start = new Chess();
  for (const san of sanPathTo(tree, startNodeId)) start.move(san);
  await walk(startNodeId, start);
  return positions;
}

async function fetchExplorerPosition(
  fen: string,
  settings: ExplorerSettings,
  cache: Map<string, ExplorerData>,
): Promise<ExplorerData> {
  const cached = cache.get(fen);
  if (cached) return cached;
  const res = await fetch(explorerUrl(fen, settings), { credentials: "same-origin" });
  if (!res.ok) throw new Error("Opening Explorer data unavailable for this position");
  const data: ExplorerData = await res.json();
  cache.set(fen, data);
  return data;
}

// Evaluate only the frontier positions the expected score needs, persisting
// each result in the browser as it completes so interrupted runs can resume.
async function calculateEvaluationsLocally(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
  cache: EvaluationCache,
  explorerCache: Map<string, ExplorerData>,
  onPlan: (ready: number, required: number, work: number) => void,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, number | null>> {
  const required = await findRequiredEvaluations(tree, startNodeId, side, settings, explorerCache);
  const evaluated = new Map<string, number | null>();
  const pending: string[] = [];
  for (const fen of required) {
    const cp = await cache.get(fen);
    if (cp === undefined) pending.push(fen);
    else evaluated.set(fen, cp);
  }
  const total = pending.length;
  const initiallyReady = required.size - total;
  let done = 0;
  onPlan(initiallyReady, required.size, total);

  if (total === 0) return evaluated;
  const engine = new Engine();
  try {
    for (const fen of pending) {
      const cp = await evaluatePosition(engine, new Chess(fen));
      if (cp !== null) await cache.set(fen, cp);
      evaluated.set(fen, cp);
      done += 1;
      onProgress(done, total);
    }
  } finally {
    engine.terminate();
  }
  return evaluated;
}

export async function expectedEvaluation(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
  evaluated: Map<string, number | null>,
  explorerCache: Map<string, ExplorerData>,
): Promise<number> {
  const sign = side === "white" ? 1 : -1;
  const valueAt = (fen: string): number => {
    const cp = evaluated.get(fen);
    if (cp === undefined) throw new Error("An evaluation is missing; update evaluations first");
    return (cp ?? 0) * sign;
  };

  async function walk(nodeId: number, chess: Chess): Promise<number> {
    const terminal = terminalCp(chess);
    if (terminal !== null) return terminal * sign;
    const node = tree.nodes[nodeId];
    if ((chess.turn() === "w") === (side === "white")) {
      if (!node.children.length) return valueAt(chess.fen());
      const childId = node.children[0];
      const child = new Chess(chess.fen());
      child.move(tree.nodes[childId].san);
      return walk(childId, child);
    }

    const data = await fetchExplorerPosition(chess.fen(), settings, explorerCache);
    const total = data.moves.reduce((games, move) => games + move.white + move.draws + move.black, 0);
    if (!total) return valueAt(chess.fen());
    const childrenBySan = new Map(node.children.map((id) => [tree.nodes[id].san, id]));
    let expected = 0;
    for (const move of data.moves) {
      const games = move.white + move.draws + move.black;
      if (!games) continue;
      const child = new Chess(chess.fen());
      child.move(move.san);
      const childId = childrenBySan.get(move.san);
      expected += (games / total) * (childId === undefined ? valueAt(child.fen()) : await walk(childId, child));
    }
    return expected;
  }

  const start = new Chess();
  for (const san of sanPathTo(tree, startNodeId)) start.move(san);
  return walk(startNodeId, start);
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

function trimTrailingCoverageZeros(coverage: number[] | undefined): number[] {
  const displayed = [...(coverage ?? [])];
  while (displayed.at(-1) === 0) displayed.pop();
  return displayed;
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
  cache: EvaluationCache,
): void {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sidePawn = `<span class="side-pawn side-pawn--${study.side}">${study.side === "white" ? "♙" : "♟"}</span>`;
  const opponent = study.side === "white" ? "Black" : "White";
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;
  const stats = study.stats;
  const displayedCoverage = trimTrailingCoverageZeros(stats?.coverage);
  const settings = study.explorerSettings ?? { ...DEFAULT_EXPLORER_SETTINGS };
  const ratingBuckets = explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  const allSpeeds = explorerDefaults?.speeds ?? (["bullet", "blitz", "rapid", "classical"] as ExplorerSpeed[]);

  const tier = scoreTier(stats?.winProbability);
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
              ? `<br>${stats.evalMisses} end-of-prep position${stats.evalMisses === 1 ? "" : "s"} had no engine eval (counted as 0.00)`
              : ""
          }${stats.evalOrigin !== "local" ? "<br>Legacy server calculation; recalculate locally to verify." : ""}</p>`
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
            <span id="evals-count" class="eval-count" aria-live="polite">Click to check positions cached in this browser</span>
          </div>
          <p class="stat-card__meta">${cache.persistent ? "Stockfish runs locally; positions are saved on this device." : "Browser storage is unavailable; evaluations last only until this tab closes."}</p>
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
          <button id="eval-score-btn" class="btn btn-primary" type="button" ${hasMoves ? "" : "disabled"}>
            Update expected evaluation
          </button>
          <p class="stat-card__meta">Combines Explorer frequencies with local Stockfish; missing positions are evaluated here first.</p>
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
          displayedCoverage.length
            ? `<canvas id="coverage-chart"></canvas>`
            : `<p class="empty-state">No coverage data yet — recalculate to generate it.</p>`
        }
      </div>
    </div>
  `;

  if (displayedCoverage.length) {
    const canvas = document.getElementById("coverage-chart") as HTMLCanvasElement;
    renderCoverageChart(canvas, displayedCoverage, nodeCountsByMove(study.tree), opponent);
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
    let requiredPositions = 0;

    allActionButtons().forEach((el) => (el.disabled = true));
    btn.textContent = "Calculating…";
    progress.hidden = false;
    progress.classList.add("progress-bar--indeterminate");
    fill.style.width = "0%";
    label.textContent = "Finding required positions…";
    label.classList.remove("progress-bar__label--error");
    progress.classList.remove("progress-bar--error");

    try {
      const explorerCache = new Map<string, ExplorerData>();
      await calculateEvaluationsLocally(
        study.tree,
        study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId,
        study.side,
        readSettingsFromDom(),
        cache,
        explorerCache,
        (ready, required, work) => {
          readyPositions = ready;
          requiredPositions = required;
          count.textContent = `${ready} / ${required} positions cached (${required - ready} to calculate)`;
          progress.classList.remove("progress-bar--indeterminate");
          fill.style.width = work === 0 ? "100%" : "0%";
          label.textContent = work === 0 ? "Already up to date" : `0 / ${work}`;
        },
        (done, total) => {
          readyPositions++;
          count.textContent = `${readyPositions} / ${requiredPositions} positions ready (${requiredPositions - readyPositions} remaining)`;
          fill.style.width = `${Math.round((done / total) * 100)}%`;
          label.textContent = `${done} / ${total}`;
        },
      );
      count.textContent = `${requiredPositions} / ${requiredPositions} positions ready on this device`;
      btn.textContent = "Update evaluations";
      allActionButtons().forEach((el) => (el.disabled = false));
    } catch (err) {
      if (requiredPositions) count.textContent = `${readyPositions} / ${requiredPositions} positions ready`;
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
      renderPage(main, updated, explorerDefaults, knowledge, cache);
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
    progress.classList.add("progress-bar--indeterminate");
    fill.style.width = "0%";
    label.textContent = "Finding required positions…";
    label.classList.remove("progress-bar__label--error");
    progress.classList.remove("progress-bar--error");

    try {
      const settings = readSettingsFromDom();
      const explorerCache = new Map<string, ExplorerData>();
      const startNodeId = study.startNodeId !== null && study.startNodeId in study.tree.nodes
        ? study.startNodeId
        : study.tree.rootId;
      const positions = await calculateEvaluationsLocally(
        study.tree, startNodeId, study.side, settings, cache, explorerCache,
        (_ready, _required, work) => {
          progress.classList.remove("progress-bar--indeterminate");
          fill.style.width = work === 0 ? "100%" : "0%";
          label.textContent = work === 0 ? "Evaluations ready" : `0 / ${work}`;
        },
        (done, total) => {
          fill.style.width = `${Math.round((done / total) * 100)}%`;
          label.textContent = `${done} / ${total} positions evaluated`;
        },
      );
      label.textContent = "Weighting Explorer replies…";
      const evalCp = await expectedEvaluation(study.tree, startNodeId, study.side, settings, positions, explorerCache);
      const evalMisses = [...positions.values()].filter((cp) => cp === null).length;
      const res = await fetch(`/api/studies/${study.id}/expected-eval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ evalCp, evalMisses, explorerSettings: settings }),
      });
      if (!res.ok) throw new Error("Could not save expected evaluation");
      const updated: Study = await res.json();
      renderPage(main, updated, explorerDefaults, knowledge, cache);
    } catch (err) {
      btn.textContent = "Update expected evaluation";
      btn.disabled = false;
      others.forEach((el) => (el.disabled = false));
      progress.classList.remove("progress-bar--indeterminate");
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

  if (!me.authenticated || !me.username) {
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

  const cache = await openEvaluationCache(me.username);
  for (const [nodeId, cp] of Object.entries(study.evals?.byNode ?? {})) {
    if (cp === null || !Number.isFinite(cp) || Math.abs(cp) > MATE_SCORE_CP || !(Number(nodeId) in study.tree.nodes)) continue;
    const chess = new Chess();
    for (const san of sanPathTo(study.tree, Number(nodeId))) chess.move(san);
    if (await cache.get(chess.fen()) === undefined) await cache.set(chess.fen(), cp);
  }
  renderPage(main, study, explorerDefaults, knowledge, cache);
}

init();
