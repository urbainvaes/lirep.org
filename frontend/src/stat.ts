import { Chart } from "chart.js/auto";
import { Chess } from "chess.js";

import { DEFAULT_SEARCH_DEPTH, Engine } from "./engine";
import {
  EVAL_DEPTH_STORAGE_KEY,
  evaluatePosition,
  openEvaluationCache,
  studyDepth,
  type EvaluationCache,
} from "./evalCache";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerSummary,
  fetchExplorerDefaults,
  LEAF_VALUE_LABELS,
  bindExplorerSettingsForm,
  explorerSettingsFormHtml,
  type ExplorerData,
  type ExplorerDefaults,
  type ExplorerSettings,
  type ExplorerSpeed,
  type LeafValue,
  LEGACY_LEAF_GAMES,
  MIN_LEAF_GAMES,
} from "./explorer";
import { calculateExpectedScore, MATE_SCORE_CP } from "./expectedScore";
import {
  BLACK_TIER_OFFSET,
  evalPiece,
  formatExpectedEval,
  PIECE_LABELS,
  PIECES,
  pieceBadgeHtml,
  scoreTier,
  TIER_LABELS,
  TIERS,
  tierThreshold,
} from "./scoreTiers";
import { fetchExplorerData } from "./explorerClient";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, sanPathTo, type StudyTree } from "./tree";

// The expected evaluation's method, saved with it (see EVAL_METHOD in
// backend/app/stats.py): 3 evaluates the same lines' ends as the expected
// score with Stockfish values, each evaluation capped at ±10 pawns. Older
// evaluations are out of date.
const EVAL_METHOD = 3;
// The settings a result was calculated with; compared with the current
// settings to mark the result out of date.
interface CalculationSettings {
  source?: "lirep" | "lichess";
  database: "lichess" | "masters" | "player";
  minRating: number | null;
  speeds?: ExplorerSpeed[];
  player?: string | null;
}

// The expected score (winProbability, coverage, …) and the expected
// evaluation (evalCp, …) are calculated separately, so either can exist
// without the other — hence both are optional, each with its own settings,
// timestamp and moves fingerprint.
interface StudyStats extends CalculationSettings {
  // Despite the name, the expected score: wins plus half the draws. The
  // score tiers and the community leaderboard use it.
  winProbability?: number;
  // null when Stockfish valued some line's end: no win/draw/loss split then.
  winRate?: number | null;
  lossProbability?: number | null;
  leafValue?: LeafValue; // missing on scores saved before the choice existed: "explorer"
  scoreDepth?: number | null; // Stockfish depth, when Stockfish valued some lines' ends
  leafGames?: number | null; // Hybrid's threshold; missing on Hybrid scores saved with LEGACY_LEAF_GAMES
  stockfishLeaves?: number;
  coverage?: number[]; // coverage[i] = fraction of games still in-book after the opponent's (i+1)th move
  winProbabilityCalculatedAt?: string;
  winProbabilityMovesFingerprint?: string;
  nodesEvaluated?: number; // set together with winProbability, by the same job
  evalCp?: number; // expected Stockfish eval (centipawns, studied side's POV) at the end of prep
  evalMisses?: number; // positions without a usable local engine evaluation (counted as 0)
  evalCalculatedAt?: string;
  evalOrigin?: "local";
  evalDepth?: number | null; // Stockfish depth; missing on evaluations saved before it was recorded
  evalMethod?: number; // missing on evaluations from method 1
  evalSettings?: CalculationSettings;
  evalMovesFingerprint?: string;
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
  shared: boolean;
  // Changes whenever the moves or the starting point do; see moves_fingerprint
  // in store.py.
  movesFingerprint: string;
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

// Told when a calculation's Explorer requests wait out a Lichess rate-limit
// pause, so its progress label can say so; set by the running calculation.
let onRateLimited: ((resumeAt: number) => void) | null = null;

async function fetchExplorerPosition(
  fen: string,
  settings: ExplorerSettings,
  side: "white" | "black",
  cache: Map<string, ExplorerData>,
): Promise<ExplorerData> {
  const cached = cache.get(fen);
  if (cached) return cached;
  const data = await fetchExplorerData(fen, settings, side, {
    priority: "background",
    onRateLimited: (resumeAt) => onRateLimited?.(resumeAt),
  });
  cache.set(fen, data);
  return data;
}

// Evaluate only the positions where lines end (see expectedScore.ts),
// persisting each result in the browser as it completes so interrupted runs
// can resume.
async function calculateEvaluationsLocally(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
  cache: EvaluationCache,
  explorerCache: Map<string, ExplorerData>,
  depth: number,
  onPlan: (ready: number, required: number, work: number) => void,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, number | null>> {
  // A first walk, without evaluations, finds the positions to evaluate.
  const { stockfishPositions } = await calculateExpectedScore(
    tree, startNodeId, side, (fen) => fetchExplorerPosition(fen, settings, side, explorerCache), "stockfish", async () => null,
  );
  const evaluated = new Map<string, number | null>();
  const pending: string[] = [];
  for (const fen of stockfishPositions) {
    const cp = await cache.get(fen, depth);
    if (cp === undefined) pending.push(fen);
    else evaluated.set(fen, cp);
  }
  const total = pending.length;
  const initiallyReady = stockfishPositions.length - total;
  let done = 0;
  onPlan(initiallyReady, stockfishPositions.length, total);

  if (total === 0) return evaluated;
  const engine = new Engine();
  try {
    for (const fen of pending) {
      const cp = await evaluatePosition(engine, new Chess(fen), depth);
      if (cp !== null) await cache.set(fen, depth, cp);
      evaluated.set(fen, cp);
      done += 1;
      onProgress(done, total);
    }
  } finally {
    engine.terminate();
  }
  return evaluated;
}

// The expected evaluation: the expected score's walk with Stockfish values,
// averaging the evaluations themselves (centipawns, studied side's point of
// view). A position without a usable evaluation counts as 0.00.
export async function expectedEvaluation(
  tree: StudyTree,
  startNodeId: number,
  side: "white" | "black",
  settings: ExplorerSettings,
  evaluated: Map<string, number | null>,
  explorerCache: Map<string, ExplorerData>,
): Promise<number> {
  const { evalCp } = await calculateExpectedScore(
    tree, startNodeId, side, (fen) => fetchExplorerPosition(fen, settings, side, explorerCache), "stockfish",
    async (fen) => {
      const cp = evaluated.get(fen);
      if (cp === undefined) throw new Error("An evaluation is missing; update evaluations first");
      return cp;
    },
  );
  return evalCp ?? 0;
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

// Whether two sets of Explorer settings select the same games. Controls the
// database ignores (rating and speeds for Masters, the source and rating for
// one player's games) don't count.
function sameExplorerSettings(a: CalculationSettings, b: CalculationSettings): boolean {
  if (a.database !== b.database) return false;
  if (a.database === "masters") return (a.source ?? "lichess") === (b.source ?? "lichess");
  const sameSpeeds = [...(a.speeds ?? [])].sort().join() === [...(b.speeds ?? [])].sort().join();
  if (a.database === "player") return sameSpeeds && (a.player ?? "").toLowerCase() === (b.player ?? "").toLowerCase();
  return (a.source ?? "lichess") === (b.source ?? "lichess") && a.minRating === b.minRating && sameSpeeds;
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

// Deep lines leave a long tail of moves that almost no game reaches; on a
// 0–100% axis they draw as a flat line at zero, so the chart stops at the
// last move still reached by at least 1 game in 200.
const MIN_DISPLAYED_COVERAGE = 0.005;

function trimCoverageTail(coverage: number[] | undefined): number[] {
  const displayed = [...(coverage ?? [])];
  while (displayed.length > 1 && displayed[displayed.length - 1] < MIN_DISPLAYED_COVERAGE) displayed.pop();
  return displayed;
}

// Resolves a CSS custom property to its actual computed color, since
// <canvas> (unlike inline SVG) isn't part of the CSS cascade — Chart.js
// needs real color strings, not var(--x) references.
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let coverageChart: Chart | null = null;
let lastCoverageChart: { canvas: HTMLCanvasElement; coverage: number[]; nodeCounts: number[]; opponent: string } | null = null;

// <canvas> doesn't follow the CSS cascade, so redraw with the new colors when
// the light/dark theme changes.
document.addEventListener("themechange", () => {
  if (lastCoverageChart) {
    const { canvas, coverage, nodeCounts, opponent } = lastCoverageChart;
    renderCoverageChart(canvas, coverage, nodeCounts, opponent);
  }
});

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
  lastCoverageChart = { canvas, coverage, nodeCounts, opponent };
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

// The Explorer settings as edited in the calculation settings (see
// bindExplorerSettingsForm); applied only by a calculation.
let formSettings: ExplorerSettings = { ...DEFAULT_EXPLORER_SETTINGS };

function readSettingsFromDom(): ExplorerSettings {
  const { database, source } = formSettings;
  return {
    ...formSettings,
    enabled: true,
    source: database === "player" ? "lichess" : source,
    speeds: [...formSettings.speeds],
    // The study's end-of-prep value and Stockfish depth, saved with its
    // settings (shared with the editor).
    leafValue: readLeafValueFromDom(),
    depth: readDepthFromDom(),
  };
}

function readDepthFromDom(): number {
  return Number((document.getElementById("eval-depth") as HTMLSelectElement).value);
}

function readLeafValueFromDom(): LeafValue {
  return (document.getElementById("leaf-value") as HTMLSelectElement).value as LeafValue;
}

// Why a result no longer matches the current settings or moves; empty when
// it is up to date. Results saved before fingerprints (or the depth) were
// recorded are not flagged for what wasn't recorded.
function scoreStaleness(study: Study, current: ExplorerSettings, leaf: LeafValue, depth: number): string[] {
  const stats = study.stats;
  if (stats?.winProbability === undefined) return [];
  const reasons: string[] = [];
  if (!sameExplorerSettings(stats, current)) reasons.push("Explorer settings changed");
  if ((stats.leafValue ?? "explorer") !== leaf) reasons.push("end-of-prep values changed");
  else if (leaf !== "explorer" && stats.scoreDepth && stats.scoreDepth !== depth) reasons.push("Stockfish depth changed");
  else if (leaf === "explorer-stockfish" && (stats.leafGames ?? LEGACY_LEAF_GAMES) !== MIN_LEAF_GAMES) {
    reasons.push(`Hybrid now uses Stockfish under ${MIN_LEAF_GAMES} games`);
  }
  const fingerprint = stats.winProbabilityMovesFingerprint;
  if (fingerprint && fingerprint !== study.movesFingerprint) reasons.push("moves changed");
  return reasons;
}

function evalStaleness(study: Study, current: ExplorerSettings, depth: number): string[] {
  const stats = study.stats;
  if (stats?.evalCp === undefined) return [];
  const reasons: string[] = [];
  if (stats.evalSettings && !sameExplorerSettings(stats.evalSettings, current)) reasons.push("Explorer settings changed");
  if (stats.evalDepth && stats.evalDepth !== depth) reasons.push("Stockfish depth changed");
  if ((stats.evalMethod ?? 1) < EVAL_METHOD) reasons.push("the calculation method changed");
  const fingerprint = stats.evalMovesFingerprint;
  if (fingerprint && fingerprint !== study.movesFingerprint) reasons.push("moves changed");
  return reasons;
}

function staleHtml(reasons: string[]): string {
  if (!reasons.length) return "";
  const text = reasons.join(", ");
  return `<p class="stat-stale"><strong>Out of date:</strong> ${text[0].toUpperCase()}${text.slice(1)} since it was calculated.</p>`;
}

interface LeaderboardEntry {
  id: number;
  rank: number | null;
}

// Where each result stands on the community leaderboards, in the default
// view (Lichess Explorer only). Fetched after the page renders.
async function leaderboardStatus(study: Study): Promise<{ score: string; evaluation: string }> {
  const stats = study.stats;
  const sideName = study.side === "white" ? "White" : "Black";
  const link = `<a href="/community.html">leaderboard</a>`;
  if (!study.shared) {
    const text = `Not on the ${link}: this study isn't shared.`;
    return { score: stats?.winProbability !== undefined ? text : "", evaluation: stats?.evalCp !== undefined ? text : "" };
  }
  const fetchBoard = async (url: string): Promise<LeaderboardEntry[]> => {
    const res = await fetch(url, { credentials: "same-origin" });
    return res.ok ? res.json() : [];
  };
  // Each result is ranked among scores from the same Explorer: Lichess's, or
  // the 2016 sample's (a separate view of the leaderboards).
  const scoreSource = stats?.source ?? "lichess";
  // Scores valued with Stockfish rank only at depth 12 or more.
  const scoreLeaf = stats?.leafValue ?? "explorer";
  const evalSource = stats?.evalSettings?.source ?? "lichess";
  const [byScore, byEval] = await Promise.all([
    fetchBoard(`/api/community/openings?source=${scoreSource}`),
    fetchBoard(`/api/community/openings-by-eval?source=${evalSource}`),
  ]);

  const status = (entries: LeaderboardEntry[], settings: CalculationSettings | undefined, depth?: number | null): string => {
    const where = settings?.source === "lirep" ? `${link} (2016 sample)` : link;
    const rank = entries.find((e) => e.id === study.id)?.rank;
    if (rank) {
      const medal = ["gold", "silver", "bronze"][rank - 1] ?? "other";
      return `<span class="stat-rank__badge stat-rank__badge--${medal}">#${rank}</span> for ${sideName} on the ${where}`;
    }
    if (settings?.database === "player") return `Not ranked: calculated from one player's games.`;
    if (depth !== undefined && !depth) return `Not ranked: Stockfish depth unknown. Recalculate to rank it.`;
    if (depth !== undefined && depth! < 12) return `Not ranked: depth ${depth}. Recalculate at Balanced (12) or more.`;
    return `Not in the top 10 for ${sideName} on the ${where}.`;
  };
  return {
    score: stats?.winProbability !== undefined
      ? status(byScore, stats, scoreLeaf === "explorer" ? undefined : stats.scoreDepth ?? null)
      : "",
    evaluation: stats?.evalCp === undefined
      ? ""
      : (stats.evalMethod ?? 1) < EVAL_METHOD
        ? "Not ranked: calculated with an older method. Recalculate to rank it."
        : status(byEval, stats.evalSettings, stats.evalDepth ?? null),
  };
}

function progressHtml(id: string): string {
  return `<div class="progress-bar" id="${id}-progress" hidden>
      <div class="progress-bar__track"><div class="progress-bar__fill" id="${id}-progress-fill"></div></div>
      <span class="progress-bar__label" id="${id}-progress-label"></span>
    </div>`;
}

// Survive the re-render after a calculation finishes.
let settingsOpen = false;
// The Stockfish depth chosen on this page, kept when the page is redrawn
// (after each calculation); null until one is chosen.
let chosenDepth: number | null = null;

let lastEvalRun: { required: number; computed: number } | null = null;

// What remains of a Recalculate run when the page is redrawn between its
// parts, with the settings it started with.
type PendingRun = {
  which: ("score" | "eval")[];
  settings: ExplorerSettings;
  depth: number;
  leaf: LeafValue;
};

function renderPage(
  main: HTMLElement,
  study: Study,
  explorerDefaults: ExplorerDefaults | null,
  knowledge: number | null,
  cache: EvaluationCache,
  pending?: PendingRun,
): void {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sidePawn = `<span class="side-pawn side-pawn--${study.side}">${study.side === "white" ? "♙" : "♟"}</span>`;
  const sideName = study.side === "white" ? "White" : "Black";
  const opponent = study.side === "white" ? "Black" : "White";
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;
  const stats = study.stats;
  const displayedCoverage = trimCoverageTail(stats?.coverage);
  const settings = study.explorerSettings ?? { ...DEFAULT_EXPLORER_SETTINGS };
  formSettings = { ...settings, speeds: [...settings.speeds] };
  const formChoices = {
    lirepAvailable: Boolean(explorerDefaults?.lirepAvailable),
    ratingBuckets: explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500],
    defaultMinRating: explorerDefaults?.defaultMinRating ?? 1400,
    speeds: explorerDefaults?.speeds ?? (["bullet", "blitz", "rapid", "classical"] as ExplorerSpeed[]),
  };
  const tier = scoreTier(stats?.winProbability, study.side);
  const piece = evalPiece(stats?.evalCp);
  const startPoint = describeStartPoint(study.tree, study.startNodeId);
  const disabled = hasMoves ? "" : "disabled";

  const scoreHtml = stats?.winProbability !== undefined
    ? (() => {
        const leaf = stats.leafValue ?? "explorer";
        const outcomes = stats.winRate != null && stats.lossProbability != null
          ? (() => {
              const draw = Math.max(0, Math.min(1, 1 - stats.winRate! - stats.lossProbability!));
              const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
              return `<p class="stat-outcomes">Win <strong>${pct(stats.winRate)}</strong> · Draw <strong>${pct(draw)}</strong> · Loss <strong>${pct(stats.lossProbability)}</strong></p>`;
            })()
          : leaf === "explorer"
            ? `<p class="stat-outcomes">Recalculate to see wins, draws and losses.</p>`
            : `<p class="stat-outcomes">No win, draw and loss split: Stockfish gives an expected score only.</p>`;
        const leafNote = leaf === "explorer"
          ? ""
          : ` · ${LEAF_VALUE_LABELS[leaf]}${stats.scoreDepth ? `, depth ${stats.scoreDepth}` : ""}`;
        const stockfishNote = leaf === "explorer-stockfish"
          ? ` · ${stats.stockfishLeaves ?? 0} valued with Stockfish`
          : "";
        return `<div class="stat-detail__score">${(stats.winProbability * 100).toFixed(1)}%</div>
          ${outcomes}
          <p class="stat-card__meta">Calculated with ${explorerSummary(stats)}${leafNote} · ${stats.nodesEvaluated ?? 0} positions${stockfishNote} · ${formatDate(stats.winProbabilityCalculatedAt ?? "")}</p>`;
      })()
    : `<div class="stat-detail__score stat-card__score--empty">—</div>
       <p class="stat-card__meta">Not calculated yet.</p>`;

  const evalHtml = stats?.evalCp !== undefined
    ? `<div class="stat-detail__score">${formatExpectedEval(stats.evalCp, study.side)}</div>
       <p class="stat-card__meta">Calculated with ${stats.evalSettings ? `${explorerSummary(stats.evalSettings)} · ` : ""}${
         stats.evalDepth ? `Stockfish depth ${stats.evalDepth} · ` : ""
       }${formatDate(stats.evalCalculatedAt ?? "")}${
         stats.evalMisses
           ? `<br>${stats.evalMisses} end-of-prep position${stats.evalMisses === 1 ? "" : "s"} had no engine eval (counted as 0.00).`
           : ""
       }${stats.evalOrigin !== "local" ? "<br>Legacy server calculation; recalculate to verify." : ""}</p>`
    : `<div class="stat-detail__score stat-card__score--empty">—</div>
       <p class="stat-card__meta">Not calculated yet.</p>`;

  const cacheNote = cache.server
    ? "Stockfish runs in this browser; evaluated positions are saved on this device and on the server, and reused."
    : cache.persistent
      ? "Stockfish runs in this browser; evaluated positions are saved on this device and reused."
      : "Browser storage is unavailable; evaluations last only until this tab closes.";
  const lastRunNote = lastEvalRun
    ? `Last run: ${lastEvalRun.required} end-of-prep positions, ${lastEvalRun.computed} newly evaluated.`
    : "";

  main.innerHTML = `
    <div class="stat-page">
      <div class="stat-page__header">
        <h1>
          <button type="button" id="piece-badge" class="piece-badge-btn" aria-label="Badge: ${TIER_LABELS[tier]} ${PIECE_LABELS[piece]} — click for details">
            ${pieceBadgeHtml(tier, "", piece)}
          </button>
          ${escapeHtml(study.name)}
        </h1>
        <span class="stat-card__side">${sidePawn}${sideLabel}</span>
      </div>
      <p class="stat-page__sub">
        ${startPoint ? `Calculated from ${escapeHtml(startPoint)} onward · ` : ""}
        <a href="/study.html?id=${study.id}">Edit the study</a> ·
        <a href="/practice-session.html?id=${study.id}">Practice</a> ·
        <a href="/games.html?id=${study.id}">Games</a>
      </p>
      <div class="piece-legend" id="piece-legend" hidden>
        <p class="piece-legend__title">The colour: score tiers for ${sideName}, by expected score</p>
        ${TIERS.map(
          (t) => `<div class="piece-legend__row">${pieceBadgeHtml(t.tier, "sm", piece)}<span>${t.label} — ${tierThreshold(t.white, study.side)}% or higher</span></div>`,
        ).join("")}
        <div class="piece-legend__row">${pieceBadgeHtml("none", "sm", piece)}<span>No tier — under ${tierThreshold(TIERS[TIERS.length - 1].white, study.side)}%, below ${sideName}'s average</span></div>
        <p class="piece-legend__note">Bronze is about ${sideName}'s average score in the Explorer; ${study.side === "white" ? "Black's" : "White's"} thresholds are ${BLACK_TIER_OFFSET} points ${study.side === "white" ? "lower" : "higher"}.</p>
        <p class="piece-legend__title">The piece: by expected evaluation, in pawns from White's point of view</p>
        ${PIECES.map(
          (p, i) => `<div class="piece-legend__row">${pieceBadgeHtml(tier, "sm", p.piece)}<span>${p.label} — ${
            i === PIECES.length - 1
              ? `${study.side === "white" ? "under" : "above"} ${formatExpectedEval(PIECES[i - 1].from * 100, study.side)}`
              : `${formatExpectedEval(p.from * 100, study.side)} or ${study.side === "white" ? "higher" : "lower"}`
          }</span></div>`,
        ).join("")}
        <p class="piece-legend__note">The same for both sides, with the sign reversed for Black. Before the expected evaluation is calculated, the piece is the pawn.</p>
      </div>

      <section class="calc-settings">
        <div class="calc-settings__head">
          <div>
            <h2>Calculation settings</h2>
            <p class="calc-settings__summary" id="settings-summary"></p>
          </div>
          <button type="button" class="btn btn-secondary" id="settings-toggle" aria-expanded="${settingsOpen}" aria-controls="settings-body">
            ${settingsOpen ? "Save" : "Edit"}
          </button>
        </div>
        <div id="settings-body" class="calc-settings__body" ${settingsOpen ? "" : "hidden"}>
          <div class="calc-settings__group">
            <h3>Opening Explorer</h3>
            <p class="stat-card__meta">Which games weight the opponent's replies, for both results.</p>
            <div id="stat-explorer-settings">${explorerSettingsFormHtml(formSettings, formChoices)}</div>
          </div>
          <div class="calc-settings__group">
            <h3>End of preparation</h3>
            <p class="stat-card__meta">How the expected score values a line where your preparation ends. <a href="/doc/expected-score.html#leaf-values">How each works</a></p>
            <label class="eval-depth-control" for="leaf-value">
              <span>Value</span>
              <select id="leaf-value">
                ${(Object.keys(LEAF_VALUE_LABELS) as LeafValue[])
                  .map((leaf) => `<option value="${leaf}" ${(settings.leafValue ?? stats?.leafValue ?? "explorer") === leaf ? "selected" : ""}>${LEAF_VALUE_LABELS[leaf]}</option>`)
                  .join("")}
              </select>
            </label>
          </div>
          <div class="calc-settings__group">
            <h3>Stockfish</h3>
            <p class="stat-card__meta">How deep Stockfish searches each end-of-prep position, for the expected evaluation, and for the expected score when Stockfish values lines' ends.</p>
            <label class="eval-depth-control" for="eval-depth">
              <span>Depth</span>
              <select id="eval-depth">
                <option value="8">8 · Quick</option>
                <option value="12">12 · Balanced</option>
                <option value="16">16 · Thorough</option>
              </select>
            </label>
            <p class="stat-card__meta">Balanced or more to appear on the evaluation leaderboard.</p>
          </div>
        </div>
        <div class="calc-settings__actions">
          <button id="recalc-all" class="btn btn-primary" type="button" ${disabled}>Recalculate</button>
          <span class="stat-card__meta" id="recalc-status" aria-live="polite"></span>
        </div>
      </section>

      <section class="stat-result">
        <div class="stat-result__head">
          <h2><button class="stat-result__toggle" type="button" aria-expanded="false" aria-controls="score-explain" title="Show the caveat">Expected score<svg class="stat-result__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button></h2>
          <button id="score-btn" class="btn btn-secondary btn-small" type="button" ${disabled}>Recalculate</button>
        </div>
        <p class="stat-result__what">Wins plus half the draws, if you always play your prepared moves and opponents reply as in the Explorer.</p>
        <div class="stat-result__explain" id="score-explain" hidden>
          <p>Where your preparation ends, Explorer results are those of every player who reached the position, including those who knew how to go on; they may overstate your own score if you don't know the follow-up. Stockfish's evaluation, the other choice in the calculation settings, can differ widely from how players at your level actually score.</p>
          <a href="/doc/expected-score.html">More in the docs</a>
        </div>
        ${scoreHtml}
        <div id="score-stale"></div>
        <p class="stat-rank" id="score-rank"></p>
        ${progressHtml("score")}
      </section>

      <section class="stat-result">
        <div class="stat-result__head">
          <h2>Coverage by ${opponent}'s move number</h2>
        </div>
        <p class="stat-result__what">Share of games still following your lines after each ${opponent} reply.${startPoint ? ` Move numbers start from ${escapeHtml(startPoint)}.` : ""}</p>
        <div id="coverage-stale"></div>
        <div class="coverage-chart-wrap">
          ${
            displayedCoverage.length
              ? `<canvas id="coverage-chart"></canvas>`
              : `<p class="empty-state">No coverage data yet — recalculate the expected score to generate it.</p>`
          }
        </div>
      </section>

      <section class="stat-result">
        <div class="stat-result__head">
          <h2>Expected evaluation</h2>
          <button id="eval-btn" class="btn btn-secondary btn-small" type="button" ${disabled}>Recalculate</button>
        </div>
        <p class="stat-result__what">Stockfish's evaluation where your preparation ends, averaged over the opponent's replies as weighted by the Explorer. It is measured in pawns, from ${sideName}'s point of view. ${cacheNote}</p>
        ${evalHtml}
        <div id="eval-stale"></div>
        <p class="stat-rank" id="eval-rank"></p>
        ${progressHtml("eval")}
        ${lastRunNote ? `<p class="stat-card__meta">${lastRunNote}</p>` : ""}
      </section>

      <section class="stat-knowledge">
        <span>Practice knowledge</span>
        <strong>${knowledge !== null ? `${Math.round(knowledge * 100)}%` : "—"}</strong>
        <span class="stat-card__meta">${knowledge !== null ? "Average recall across all positions; decays over time." : "No practice positions yet."}</span>
        <a href="/practice-session.html?id=${study.id}">Practice</a>
      </section>
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

  const settingsBody = document.getElementById("settings-body") as HTMLElement;
  const settingsToggle = document.getElementById("settings-toggle") as HTMLButtonElement;
  // Edit opens the settings; Save saves them as the study's (the editor
  // then uses them too) and closes them, the results calculated with
  // others then marked out of date.
  settingsToggle.addEventListener("click", async () => {
    if (settingsBody.hidden) {
      settingsOpen = true;
      settingsBody.hidden = false;
      settingsToggle.textContent = "Save";
      settingsToggle.setAttribute("aria-expanded", "true");
      return;
    }
    settingsToggle.disabled = true;
    try {
      const saved = await saveSettings(readSettingsFromDom());
      settingsOpen = false;
      renderPage(main, saved, explorerDefaults, knowledge, cache);
    } catch {
      settingsToggle.disabled = false;
      (document.getElementById("recalc-status") as HTMLElement).textContent = "Could not save the settings. Please try again.";
    }
  });

  async function saveSettings(settings: ExplorerSettings): Promise<Study> {
    const res = await fetch(`/api/studies/${study.id}/explorer-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(settings),
    });
    if (!res.ok) throw new Error("Could not save the settings");
    return res.json();
  }

  const depthEl = document.getElementById("eval-depth") as HTMLSelectElement;
  // The depth of a run still going, while the page is redrawn between its
  // parts; else the one chosen on this page; else the study's, like its
  // Explorer settings.
  depthEl.value = String(pending?.depth ?? chosenDepth ?? studyDepth(study.explorerSettings));
  depthEl.addEventListener("change", () => {
    chosenDepth = Number(depthEl.value);
    try {
      localStorage.setItem(EVAL_DEPTH_STORAGE_KEY, depthEl.value);
    } catch {
      // Keep the selection for this page even when browser storage is blocked.
    }
  });

  bindExplorerSettingsForm(
    document.getElementById("stat-explorer-settings") as HTMLElement,
    formSettings,
    formChoices.lirepAvailable,
    () => refreshStatus(),
  );

  // The summary line and the out-of-date markers follow the settings as they
  // are edited; nothing recalculates until a Recalculate button is pressed.
  function refreshStatus(): void {
    const current = readSettingsFromDom();
    const depth = readDepthFromDom();
    const leaf = readLeafValueFromDom();
    (document.getElementById("settings-summary") as HTMLElement).textContent =
      `${explorerSummary(current)} · ${LEAF_VALUE_LABELS[leaf]} · Stockfish depth ${depth}`;
    const scoreReasons = scoreStaleness(study, current, leaf, depth);
    const evalReasons = evalStaleness(study, current, depth);
    (document.getElementById("score-stale") as HTMLElement).innerHTML = staleHtml(scoreReasons);
    (document.getElementById("coverage-stale") as HTMLElement).innerHTML = staleHtml(scoreReasons);
    (document.getElementById("eval-stale") as HTMLElement).innerHTML = staleHtml(evalReasons);
    const missing = [stats?.winProbability, stats?.evalCp].filter((v) => v === undefined).length;
    const outdated = (scoreReasons.length ? 1 : 0) + (evalReasons.length ? 1 : 0);
    (document.getElementById("recalc-status") as HTMLElement).textContent = !hasMoves
      ? "Add moves to the study first."
      : missing === 2
        ? "Calculates the expected score and the expected evaluation."
        : missing + outdated === 0
          ? "Both results are up to date."
          : `${missing + outdated === 2 ? "Both results need" : "One result needs"} recalculating.`;
  }
  main.querySelector(".calc-settings")!.addEventListener("change", refreshStatus);
  main.querySelector(".calc-settings")!.addEventListener("input", refreshStatus);
  refreshStatus();

  void leaderboardStatus(study).then(({ score, evaluation }) => {
    const scoreRank = document.getElementById("score-rank");
    const evalRank = document.getElementById("eval-rank");
    if (scoreRank) scoreRank.innerHTML = score;
    if (evalRank) evalRank.innerHTML = evaluation;
  });

  const buttons = ["recalc-all", "score-btn", "eval-btn"].map((id) => document.getElementById(id) as HTMLButtonElement);
  const setBusy = (busy: boolean) => buttons.forEach((b) => (b.disabled = busy || !hasMoves));

  function progressElements(id: "score" | "eval") {
    const progress = document.getElementById(`${id}-progress`) as HTMLElement;
    const fill = document.getElementById(`${id}-progress-fill`) as HTMLElement;
    const label = document.getElementById(`${id}-progress-label`) as HTMLElement;
    progress.hidden = false;
    progress.classList.remove("progress-bar--error", "progress-bar--indeterminate");
    label.classList.remove("progress-bar__label--error");
    fill.style.width = "0%";
    label.textContent = "";
    return { progress, fill, label };
  }

  function showError(id: "score" | "eval", err: unknown): void {
    const { progress, fill, label } = progressElements(id);
    label.textContent = err instanceof Error ? err.message : "Something went wrong.";
    label.classList.add("progress-bar__label--error");
    progress.classList.add("progress-bar--error");
    fill.style.width = "0%";
  }

  async function calculateScore(current: Study, settings: ExplorerSettings, leaf: LeafValue, depth: number): Promise<Study> {
    const { fill, label } = progressElements("score");
    const startNodeId = current.startNodeId !== null && current.startNodeId in current.tree.nodes
      ? current.startNodeId
      : current.tree.rootId;
    // The number of positions isn't known in advance; the tree's size is a
    // fair stand-in for the bar, capped at 100%.
    const estimate = Object.keys(current.tree.nodes).length;
    label.textContent = "Checking positions…";
    const explorerCache = new Map<string, ExplorerData>();
    // Explorer positions read, and Stockfish evaluations made, on one line
    // that only grows (the two used to replace each other, flickering).
    let positions = 0;
    let evaluated = 0;
    let stockfish = false;
    const progress = () => {
      fill.style.width = `${Math.min(100, Math.round(((positions + evaluated) / Math.max(1, estimate)) * 100))}%`;
      label.textContent = `${positions} position${positions === 1 ? "" : "s"} checked`
        + (stockfish ? ` · Stockfish, depth ${depth}: ${evaluated} evaluated` : "") + "…";
    };
    // Stockfish starts only if a line's end needs it; its evaluations are
    // shared with the expected evaluation's, in this browser's cache.
    let engine: Engine | null = null;
    const evaluate = async (fen: string): Promise<number | null> => {
      const known = await cache.get(fen, depth);
      if (known !== undefined) return known;
      engine ??= new Engine();
      if (!stockfish) {
        stockfish = true;
        progress();
      }
      const cp = await evaluatePosition(engine, new Chess(fen), depth);
      if (cp !== null) await cache.set(fen, depth, cp);
      evaluated += 1;
      progress();
      return cp;
    };
    let result;
    try {
      result = await calculateExpectedScore(current.tree, startNodeId, current.side, async (fen) => {
        const known = explorerCache.has(fen);
        const data = await fetchExplorerPosition(fen, settings, current.side, explorerCache);
        if (!known) {
          positions += 1;
          progress();
        }
        return data;
      }, leaf, evaluate);
    } finally {
      (engine as Engine | null)?.terminate();
    }
    label.textContent = "Saving…";
    const res = await fetch(`/api/studies/${current.id}/expected-score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        movesFingerprint: current.movesFingerprint,
        side: current.side,
        score: result.score,
        winRate: result.winRate,
        lossProbability: result.lossProbability,
        coverage: result.coverage,
        nodesEvaluated: result.nodesEvaluated,
        explorerCalls: result.explorerCalls,
        stockfishLeaves: result.stockfishLeaves,
        leafValue: leaf,
        leafGames: leaf === "explorer-stockfish" ? MIN_LEAF_GAMES : null,
        depth: leaf === "explorer" ? null : depth,
        explorerSettings: settings,
      }),
    });
    if (res.status === 409) throw new Error("Study changed. Reload the page and recalculate stats.");
    if (!res.ok) throw new Error("Could not save the expected score");
    return res.json();
  }

  async function calculateEvaluation(current: Study, settings: ExplorerSettings, depth: number): Promise<Study> {
    const { progress, fill, label } = progressElements("eval");
    progress.classList.add("progress-bar--indeterminate");
    label.textContent = "Finding end-of-prep positions…";
    const explorerCache = new Map<string, ExplorerData>();
    const startNodeId = current.startNodeId !== null && current.startNodeId in current.tree.nodes
      ? current.startNodeId
      : current.tree.rootId;
    let required = 0;
    let computed = 0;
    const positions = await calculateEvaluationsLocally(
      current.tree, startNodeId, current.side, settings, cache, explorerCache, depth,
      (_ready, total, work) => {
        required = total;
        progress.classList.remove("progress-bar--indeterminate");
        fill.style.width = work === 0 ? "100%" : "0%";
        label.textContent = work === 0 ? "All positions already evaluated on this device" : `0 / ${work} positions evaluated`;
      },
      (done, total) => {
        computed = done;
        fill.style.width = `${Math.round((done / total) * 100)}%`;
        label.textContent = `${done} / ${total} positions evaluated`;
      },
    );
    label.textContent = "Weighting Explorer replies…";
    const evalCp = await expectedEvaluation(current.tree, startNodeId, current.side, settings, positions, explorerCache);
    const evalMisses = [...positions.values()].filter((cp) => cp === null).length;
    const res = await fetch(`/api/studies/${current.id}/expected-eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        movesFingerprint: current.movesFingerprint, side: current.side,
        evalCp, evalMisses, depth, explorerSettings: settings, method: EVAL_METHOD,
      }),
    });
    if (res.status === 409) throw new Error("Study changed. Reload the page and recalculate stats.");
    if (!res.ok) throw new Error("Could not save expected evaluation");
    lastEvalRun = { required, computed };
    return res.json();
  }

  // Runs the requested calculations one after the other with the settings
  // as they were when the button was pressed. The page is redrawn after each
  // one, so that its result shows while the next runs; a failure stops the
  // run and stays on screen next to its card.
  async function run({ which, settings, depth, leaf }: PendingRun): Promise<void> {
    const [id, ...rest] = which;
    setBusy(true);
    onRateLimited = (resumeAt) => {
      const label = document.getElementById(`${id}-progress-label`) as HTMLElement;
      const time = new Date(resumeAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      label.textContent = `Lichess asked to slow down; resuming at ${time}…`;
    };
    let current: Study;
    try {
      // The settings it runs with become the study's, as Save does.
      await saveSettings(settings);
      current = id === "score"
        ? await calculateScore(study, settings, leaf, depth)
        : await calculateEvaluation(study, settings, depth);
    } catch (err) {
      showError(id, err);
      setBusy(false);
      return;
    } finally {
      onRateLimited = null;
    }
    renderPage(main, current, explorerDefaults, knowledge, cache, rest.length ? { which: rest, settings, depth, leaf } : undefined);
  }

  // Starts a run with the settings as they are now.
  const start = (which: PendingRun["which"]) =>
    void run({ which, settings: readSettingsFromDom(), depth: readDepthFromDom(), leaf: readLeafValueFromDom() });

  // The expected score's title opens its caveat.
  document.querySelectorAll<HTMLButtonElement>(".stat-result__toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const panel = document.getElementById(toggle.getAttribute("aria-controls") as string) as HTMLElement;
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });
  });

  document.getElementById("recalc-all")!.addEventListener("click", () => start(["score", "eval"]));
  document.getElementById("score-btn")!.addEventListener("click", () => start(["score"]));
  document.getElementById("eval-btn")!.addEventListener("click", () => start(["eval"]));

  // The rest of a run that started before this page was drawn.
  if (pending) {
    (document.getElementById("recalc-status") as HTMLElement).textContent = "Calculating the expected evaluation…";
    void run(pending);
  }
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
  // Legacy server-side evaluations were produced at the previous default depth.
  for (const [nodeId, cp] of Object.entries(study.evals?.byNode ?? {})) {
    if (cp === null || !Number.isFinite(cp) || Math.abs(cp) > MATE_SCORE_CP || !(Number(nodeId) in study.tree.nodes)) continue;
    const chess = new Chess();
    for (const san of sanPathTo(study.tree, Number(nodeId))) chess.move(san);
    if (await cache.get(chess.fen(), DEFAULT_SEARCH_DEPTH) === undefined) {
      await cache.set(chess.fen(), DEFAULT_SEARCH_DEPTH, cp);
    }
  }
  renderPage(main, study, explorerDefaults, knowledge, cache);
}

init();
