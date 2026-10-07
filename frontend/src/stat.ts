import { Chart } from "chart.js/auto";
import { Chess } from "chess.js";

import { DEFAULT_SEARCH_DEPTH, Engine, type EngineLine } from "./engine";
import { openEvaluationCache, type EvaluationCache } from "./evalCache";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerSummary,
  fetchExplorerDefaults,
  ratingOptionsHtml,
  speedCheckboxesHtml,
  type ExplorerData,
  type ExplorerDefaults,
  type ExplorerSettings,
  type ExplorerSpeed,
} from "./explorer";
import { calculateExpectedScore } from "./expectedScore";
import { fetchExplorerData } from "./explorerClient";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, sanPathTo, type StudyTree } from "./tree";

const EVAL_DEPTHS = [8, 12, DEFAULT_SEARCH_DEPTH] as const;
const EVAL_DEPTH_STORAGE_KEY = "stats-evaluation-depth";

function getSavedEvalDepth(): number {
  try {
    const depth = Number(localStorage.getItem(EVAL_DEPTH_STORAGE_KEY));
    return EVAL_DEPTHS.includes(depth as (typeof EVAL_DEPTHS)[number]) ? depth : DEFAULT_SEARCH_DEPTH;
  } catch {
    return DEFAULT_SEARCH_DEPTH;
  }
}

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
  winRate?: number;
  lossProbability?: number;
  coverage?: number[]; // coverage[i] = fraction of games still in-book after the opponent's (i+1)th move
  winProbabilityCalculatedAt?: string;
  winProbabilityMovesFingerprint?: string;
  nodesEvaluated?: number; // set together with winProbability, by the same job
  evalCp?: number; // expected Stockfish eval (centipawns, studied side's POV) at the end of prep
  evalMisses?: number; // positions without a usable local engine evaluation (counted as 0)
  evalCalculatedAt?: string;
  evalOrigin?: "local";
  evalDepth?: number | null; // Stockfish depth; missing on evaluations saved before it was recorded
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

// A forced mate is capped at this centipawn value so it can be averaged
// with ordinary evaluations.
const MATE_SCORE_CP = 100_000;

function formatEval(cp: number): string {
  if (Math.abs(cp) > MATE_SCORE_CP - 1000) return cp > 0 ? "Forced mate" : "Forced mate against";
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
}

// Actual game-over positions on the board — checkmate gets a flat mate cap
// (no distance), matching the backend's own terminal-position handling.
// chess.js's isDraw() also covers stalemate, insufficient material,
// threefold repetition, and the 50-move rule, so all of those are handled
// here too rather than falling through to the engine.
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
async function evaluatePosition(engine: Engine, chess: Chess, depth: number): Promise<number | null> {
  const terminal = terminalCp(chess);
  if (terminal !== null) return terminal;
  const analysis = await engine.analyze(chess.fen(), depth);
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

    const data = await fetchExplorerPosition(chess.fen(), settings, side, explorerCache);
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

// Evaluate only the frontier positions the expected score needs, persisting
// each result in the browser as it completes so interrupted runs can resume.
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
  const required = await findRequiredEvaluations(tree, startNodeId, side, settings, explorerCache);
  const evaluated = new Map<string, number | null>();
  const pending: string[] = [];
  for (const fen of required) {
    const cp = await cache.get(fen, depth);
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

    const data = await fetchExplorerPosition(chess.fen(), settings, side, explorerCache);
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

function scoreTier(expectedScore: number | undefined): ScoreTier {
  if (expectedScore === undefined) return "none";
  const pct = expectedScore * 100;
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

function readSettingsFromDom(): ExplorerSettings {
  const source = (document.getElementById("stat-source") as HTMLSelectElement).value as ExplorerSettings["source"];
  const database = (document.getElementById("stat-database") as HTMLSelectElement).value as ExplorerSettings["database"];
  const minRatingEl = document.getElementById("stat-min-rating") as HTMLSelectElement;
  const minRating = Number(minRatingEl.value);
  const player = (document.getElementById("stat-player") as HTMLInputElement).value.trim() || null;
  const speeds = Array.from(
    document.querySelectorAll<HTMLInputElement>("#stat-speeds input:checked"),
  ).map((cb) => cb.value as ExplorerSpeed);
  return { enabled: true, source: database === "player" ? "lichess" : source, database, player, minRating, speeds };
}

function readDepthFromDom(): number {
  return Number((document.getElementById("eval-depth") as HTMLSelectElement).value);
}

// Why a result no longer matches the current settings or moves; empty when
// it is up to date. Results saved before fingerprints (or the depth) were
// recorded are not flagged for what wasn't recorded.
function scoreStaleness(study: Study, current: ExplorerSettings): string[] {
  const stats = study.stats;
  if (stats?.winProbability === undefined) return [];
  const reasons: string[] = [];
  if (!sameExplorerSettings(stats, current)) reasons.push("Explorer settings changed");
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
  const evalSource = stats?.evalSettings?.source ?? "lichess";
  const [byScore, byEval] = await Promise.all([
    fetchBoard(`/api/community/openings?source=${scoreSource}`),
    fetchBoard(`/api/community/openings-by-eval?source=${evalSource}`),
  ]);

  const status = (entries: LeaderboardEntry[], settings: CalculationSettings | undefined, depth?: number | null): string => {
    const where = settings?.source === "lirep" ? `${link} (2016 sample)` : link;
    const rank = entries.find((e) => e.id === study.id)?.rank;
    if (rank) return `Ranked #${rank} for ${sideName} on the ${where}.`;
    if (settings?.database === "player") return `Not ranked: calculated from one player's games.`;
    if (depth !== undefined && !depth) return `Not ranked: Stockfish depth unknown. Recalculate to rank it.`;
    if (depth !== undefined && depth! < 12) return `Not ranked: depth ${depth}. Recalculate at Balanced (12) or more.`;
    return `Not in the top 10 for ${sideName} on the ${where}.`;
  };
  return {
    score: stats?.winProbability !== undefined ? status(byScore, stats) : "",
    evaluation: stats?.evalCp !== undefined ? status(byEval, stats.evalSettings, stats.evalDepth ?? null) : "",
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
let lastEvalRun: { required: number; computed: number } | null = null;

function renderPage(
  main: HTMLElement,
  study: Study,
  explorerDefaults: ExplorerDefaults | null,
  knowledge: number | null,
  cache: EvaluationCache,
): void {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sidePawn = `<span class="side-pawn side-pawn--${study.side}">${study.side === "white" ? "♙" : "♟"}</span>`;
  const sideName = study.side === "white" ? "White" : "Black";
  const opponent = study.side === "white" ? "Black" : "White";
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;
  const stats = study.stats;
  const displayedCoverage = trimCoverageTail(stats?.coverage);
  const settings = study.explorerSettings ?? { ...DEFAULT_EXPLORER_SETTINGS };
  const ratingBuckets = explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  const defaultMinRating = explorerDefaults?.defaultMinRating ?? 1400;
  const allSpeeds = explorerDefaults?.speeds ?? (["bullet", "blitz", "rapid", "classical"] as ExplorerSpeed[]);
  const tier = scoreTier(stats?.winProbability);
  const startPoint = describeStartPoint(study.tree, study.startNodeId);
  const disabled = hasMoves ? "" : "disabled";

  const scoreHtml = stats?.winProbability !== undefined
    ? (() => {
        const outcomes = stats.winRate !== undefined && stats.lossProbability !== undefined
          ? (() => {
              const draw = Math.max(0, Math.min(1, 1 - stats.winRate! - stats.lossProbability!));
              const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
              return `<p class="stat-outcomes">Win <strong>${pct(stats.winRate)}</strong> · Draw <strong>${pct(draw)}</strong> · Loss <strong>${pct(stats.lossProbability)}</strong></p>`;
            })()
          : `<p class="stat-outcomes">Recalculate to see wins, draws and losses.</p>`;
        return `<div class="stat-detail__score">${(stats.winProbability * 100).toFixed(1)}%</div>
          ${outcomes}
          <p class="stat-card__meta">Calculated with ${explorerSummary(stats)} · ${stats.nodesEvaluated ?? 0} positions · ${formatDate(stats.winProbabilityCalculatedAt ?? "")}</p>`;
      })()
    : `<div class="stat-detail__score stat-card__score--empty">—</div>
       <p class="stat-card__meta">Not calculated yet.</p>`;

  const evalHtml = stats?.evalCp !== undefined
    ? `<div class="stat-detail__score">${formatEval(stats.evalCp)}</div>
       <p class="stat-outcomes">In pawns, from ${sideName}'s point of view.</p>
       <p class="stat-card__meta">Calculated with ${stats.evalSettings ? `${explorerSummary(stats.evalSettings)} · ` : ""}${
         stats.evalDepth ? `Stockfish depth ${stats.evalDepth} · ` : ""
       }${formatDate(stats.evalCalculatedAt ?? "")}${
         stats.evalMisses
           ? `<br>${stats.evalMisses} end-of-prep position${stats.evalMisses === 1 ? "" : "s"} had no engine eval (counted as 0.00).`
           : ""
       }${stats.evalOrigin !== "local" ? "<br>Legacy server calculation; recalculate to verify." : ""}</p>`
    : `<div class="stat-detail__score stat-card__score--empty">—</div>
       <p class="stat-card__meta">Not calculated yet.</p>`;

  const cacheNote = cache.persistent
    ? "Stockfish runs in this browser; evaluated positions are saved on this device and reused."
    : "Browser storage is unavailable; evaluations last only until this tab closes.";
  const lastRunNote = lastEvalRun
    ? ` Last run: ${lastEvalRun.required} end-of-prep positions, ${lastEvalRun.computed} newly evaluated.`
    : "";

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
      <p class="stat-page__sub">
        ${startPoint ? `Calculated from ${escapeHtml(startPoint)} onward · ` : ""}
        <a href="/study.html?id=${study.id}">Edit the study</a> ·
        <a href="/practice-session.html?id=${study.id}">Practice</a>
      </p>
      <div class="piece-legend" id="piece-legend" hidden>
        <p class="piece-legend__title">Score tiers, by expected score</p>
        <div class="piece-legend__row">${pieceBadgeHtml("gold", "sm")}<span>Gold — 60% or higher</span></div>
        <div class="piece-legend__row">${pieceBadgeHtml("silver", "sm")}<span>Silver — 55% or higher</span></div>
        <div class="piece-legend__row">${pieceBadgeHtml("bronze", "sm")}<span>Bronze — 50% or higher</span></div>
        <div class="piece-legend__row">${pieceBadgeHtml("none", "sm")}<span>Below 50% — behind on average</span></div>
      </div>

      <section class="calc-settings">
        <div class="calc-settings__head">
          <div>
            <h2>Calculation settings</h2>
            <p class="calc-settings__summary" id="settings-summary"></p>
          </div>
          <button type="button" class="btn btn-secondary" id="settings-toggle" aria-expanded="${settingsOpen}" aria-controls="settings-body">
            ${settingsOpen ? "Done" : "Edit"}
          </button>
        </div>
        <div id="settings-body" class="calc-settings__body" ${settingsOpen ? "" : "hidden"}>
          <div class="calc-settings__group">
            <h3>Opening Explorer</h3>
            <p class="stat-card__meta">Which games weight the opponent's replies, for both results.</p>
            <div class="explorer-settings-panel">
              <div class="analysis-header__settings">
                <select id="stat-source" aria-label="Explorer data source">
                  <option value="lirep" ${settings.source === "lirep" ? "selected" : ""} ${explorerDefaults?.lirepAvailable ? "" : "disabled"}>Lirep</option>
                  <option value="lichess" ${settings.source === "lichess" ? "selected" : ""}>Lichess</option>
                </select>
                <select id="stat-database" aria-label="Lichess database" ${settings.source === "lirep" ? "disabled" : ""}>
                  <option value="lichess" ${settings.database === "lichess" ? "selected" : ""}>Players</option>
                  <option value="masters" ${settings.database === "masters" ? "selected" : ""} ${settings.source === "lirep" ? "disabled" : ""}>Masters</option>
                  <option value="player" ${settings.database === "player" ? "selected" : ""}>Player</option>
                </select>
                <select id="stat-min-rating" aria-label="Minimum rating" ${settings.database === "lichess" ? "" : "disabled"}>
                  ${ratingOptionsHtml(ratingBuckets, settings.minRating, defaultMinRating)}
                </select>
                <input id="stat-player" class="explorer-player" type="text" placeholder="Lichess username"
                  aria-label="Player whose games to use" value="${escapeHtml(settings.player ?? "")}"
                  ${settings.database === "player" ? "" : "hidden"} />
              </div>
              <div class="speed-checkboxes" id="stat-speeds">
                ${speedCheckboxesHtml(allSpeeds, settings.speeds, settings.database === "masters")}
              </div>
            </div>
          </div>
          <div class="calc-settings__group">
            <h3>Stockfish</h3>
            <p class="stat-card__meta">How deep Stockfish searches each end-of-prep position, for the expected evaluation.</p>
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
          <p>After play leaves your repertoire, Explorer results include how those players continued, sometimes with preparation you may not have. They may overstate your own score if you don't know the follow-up. This isn't a flaw in using empirical results; it's a limitation of treating the pool's average outcomes as a proxy for your own unprepared play.</p>
          <a href="/doc/stats.html#expected-score">More in the docs</a>
        </div>
        ${scoreHtml}
        <div id="score-stale"></div>
        <p class="stat-rank" id="score-rank"></p>
        ${progressHtml("score")}
        <h3 class="stat-result__subtitle">Coverage by ${opponent}'s move number</h3>
        <p class="tree-hint">Share of games still following your lines after each ${opponent} reply.${startPoint ? ` Move numbers start from ${escapeHtml(startPoint)}.` : ""}</p>
        <div class="coverage-chart-wrap">
          ${
            displayedCoverage.length
              ? `<canvas id="coverage-chart"></canvas>`
              : `<p class="empty-state">No coverage data yet — recalculate to generate it.</p>`
          }
        </div>
      </section>

      <section class="stat-result">
        <div class="stat-result__head">
          <h2>Expected evaluation</h2>
          <button id="eval-btn" class="btn btn-secondary btn-small" type="button" ${disabled}>Recalculate</button>
        </div>
        <p class="stat-result__what">Stockfish's evaluation where your preparation ends, averaged over the opponent's replies as weighted by the Explorer.</p>
        ${evalHtml}
        <div id="eval-stale"></div>
        <p class="stat-rank" id="eval-rank"></p>
        ${progressHtml("eval")}
        <p class="stat-card__meta">${cacheNote}${lastRunNote}</p>
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
  settingsToggle.addEventListener("click", () => {
    settingsOpen = settingsBody.hidden;
    settingsBody.hidden = !settingsOpen;
    settingsToggle.textContent = settingsOpen ? "Done" : "Edit";
    settingsToggle.setAttribute("aria-expanded", String(settingsOpen));
  });

  const depthEl = document.getElementById("eval-depth") as HTMLSelectElement;
  // The depth the expected evaluation was last calculated at, like the Explorer
  // settings; this browser's last choice for a study never calculated.
  const studyDepth = stats?.evalDepth;
  depthEl.value = String(
    studyDepth && EVAL_DEPTHS.includes(studyDepth as (typeof EVAL_DEPTHS)[number]) ? studyDepth : getSavedEvalDepth(),
  );
  depthEl.addEventListener("change", () => {
    try {
      localStorage.setItem(EVAL_DEPTH_STORAGE_KEY, depthEl.value);
    } catch {
      // Keep the selection for this page even when browser storage is blocked.
    }
  });

  const databaseEl = document.getElementById("stat-database") as HTMLSelectElement;
  const sourceEl = document.getElementById("stat-source") as HTMLSelectElement;
  const minRatingEl = document.getElementById("stat-min-rating") as HTMLSelectElement;
  const speedsEl = document.getElementById("stat-speeds") as HTMLElement;
  const playerEl = document.getElementById("stat-player") as HTMLInputElement;

  function updateExplorerControls(): void {
    const playerSelected = databaseEl.value === "player";
    databaseEl.disabled = sourceEl.value === "lirep" && !playerSelected;
    databaseEl.querySelector<HTMLOptionElement>('option[value="masters"]')!.disabled = sourceEl.value === "lirep";
    sourceEl.querySelector<HTMLOptionElement>('option[value="lirep"]')!.disabled =
      playerSelected || !explorerDefaults?.lirepAvailable;
    if (playerSelected) sourceEl.value = "lichess"; // one player's games exist only on Lichess
    minRatingEl.disabled = databaseEl.value !== "lichess";
    playerEl.hidden = !playerSelected;
    speedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = databaseEl.value === "masters";
    });
  }

  sourceEl.addEventListener("change", () => {
    if (sourceEl.value === "lirep" && databaseEl.value === "masters") databaseEl.value = "lichess";
    updateExplorerControls();
  });

  databaseEl.addEventListener("change", () => {
    updateExplorerControls();
    if (databaseEl.value === "player" && !playerEl.value.trim()) {
      void fetchMe().then((me) => {
        if (me.username && !playerEl.value.trim()) playerEl.value = me.username;
        refreshStatus();
      });
    }
  });

  speedsEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.type !== "checkbox") return;
    const checkedCount = speedsEl.querySelectorAll<HTMLInputElement>("input:checked").length;
    if (!target.checked && checkedCount === 0) target.checked = true; // keep at least one speed selected
  });

  // The summary line and the out-of-date markers follow the settings as they
  // are edited; nothing recalculates until a Recalculate button is pressed.
  function refreshStatus(): void {
    const current = readSettingsFromDom();
    const depth = readDepthFromDom();
    (document.getElementById("settings-summary") as HTMLElement).textContent =
      `${explorerSummary(current)} · Stockfish depth ${depth}`;
    const scoreReasons = scoreStaleness(study, current);
    const evalReasons = evalStaleness(study, current, depth);
    (document.getElementById("score-stale") as HTMLElement).innerHTML = staleHtml(scoreReasons);
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

  async function calculateScore(current: Study, settings: ExplorerSettings): Promise<Study> {
    const { fill, label } = progressElements("score");
    const startNodeId = current.startNodeId !== null && current.startNodeId in current.tree.nodes
      ? current.startNodeId
      : current.tree.rootId;
    // The number of positions isn't known in advance; the tree's size is a
    // fair stand-in for the bar, capped at 100%.
    const estimate = Object.keys(current.tree.nodes).length;
    label.textContent = "Checking positions…";
    const explorerCache = new Map<string, ExplorerData>();
    const result = await calculateExpectedScore(current.tree, startNodeId, current.side, async (fen) => {
      const known = explorerCache.has(fen);
      const data = await fetchExplorerPosition(fen, settings, current.side, explorerCache);
      if (!known) {
        const positions = explorerCache.size;
        fill.style.width = `${Math.min(100, Math.round((positions / Math.max(1, estimate)) * 100))}%`;
        label.textContent = `${positions} position${positions === 1 ? "" : "s"} checked…`;
      }
      return data;
    });
    label.textContent = "Saving…";
    const res = await fetch(`/api/studies/${current.id}/expected-score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ...result, explorerSettings: settings }),
    });
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
      body: JSON.stringify({ evalCp, evalMisses, depth, explorerSettings: settings }),
    });
    if (!res.ok) throw new Error("Could not save expected evaluation");
    lastEvalRun = { required, computed };
    return res.json();
  }

  // Runs the requested calculations one after the other with the settings
  // as they are now, then re-renders once; a failure stops the run and stays
  // on screen next to its card.
  async function run(which: ("score" | "eval")[]): Promise<void> {
    const settings = readSettingsFromDom();
    const depth = readDepthFromDom();
    let current = study;
    setBusy(true);
    for (const id of which) {
      onRateLimited = (resumeAt) => {
        const label = document.getElementById(`${id}-progress-label`) as HTMLElement;
        const time = new Date(resumeAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        label.textContent = `Lichess asked to slow down; resuming at ${time}…`;
      };
      try {
        current = id === "score" ? await calculateScore(current, settings) : await calculateEvaluation(current, settings, depth);
      } catch (err) {
        showError(id, err);
        setBusy(false);
        return;
      } finally {
        onRateLimited = null;
      }
    }
    renderPage(main, current, explorerDefaults, knowledge, cache);
  }

  // The expected score's title opens its caveat.
  document.querySelectorAll<HTMLButtonElement>(".stat-result__toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const panel = document.getElementById(toggle.getAttribute("aria-controls") as string) as HTMLElement;
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });
  });

  document.getElementById("recalc-all")!.addEventListener("click", () => void run(["score", "eval"]));
  document.getElementById("score-btn")!.addEventListener("click", () => void run(["score"]));
  document.getElementById("eval-btn")!.addEventListener("click", () => void run(["eval"]));
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
