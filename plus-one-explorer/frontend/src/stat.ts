import { Chart } from "chart.js/auto";

import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, type StudyTree } from "./tree";

interface StudyStats {
  winProbability: number;
  coverage?: number[]; // coverage[i] = fraction of games still in-book after move i+1
  calculatedAt: string;
  database: "lichess" | "masters";
  minRating: number | null;
  nodesEvaluated: number;
  explorerCalls: number;
}

interface Study {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  stats: StudyStats | null;
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
function medalFor(winProbability: number): string {
  const pct = winProbability * 100;
  if (pct >= 60) return "🥇";
  if (pct >= 55) return "🥈";
  if (pct >= 50) return "🥉";
  return "";
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
function renderCoverageChart(canvas: HTMLCanvasElement, coverage: number[], nodeCounts: number[]): void {
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
            title: (items) => `Move ${items[0].label}`,
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
          title: { display: true, text: "Move number", color: textDim },
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

function renderPage(main: HTMLElement, study: Study): void {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sideDotClass = `side-dot side-dot--${study.side}`;
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;
  const stats = study.stats;

  const scoreHtml = stats
    ? `<div class="stat-detail__score">${(stats.winProbability * 100).toFixed(1)}% <span class="stat-card__medal">${medalFor(stats.winProbability)}</span></div>
       <p class="stat-card__label">Expected score, assuming perfect memorization</p>
       <p class="stat-card__meta">${statsSourceLabel(stats)} · ${stats.nodesEvaluated} positions evaluated · as of ${formatDate(stats.calculatedAt)}</p>`
    : `<div class="stat-detail__score stat-card__score--empty">—</div>
       <p class="stat-card__meta">Not calculated yet.</p>`;

  main.innerHTML = `
    <a class="btn btn-secondary" href="/stats.html">&larr; Back to Stats</a>
    <div class="stat-page">
      <div class="stat-page__header">
        <h1>${escapeHtml(study.name)}</h1>
        <span class="stat-card__side"><span class="${sideDotClass}"></span>${sideLabel}</span>
      </div>
      ${scoreHtml}
      <button id="recalc-btn" class="btn btn-primary" type="button" ${hasMoves ? "" : "disabled"}>
        ${stats ? "Recalculate" : "Calculate"}
      </button>

      <h2 class="stat-detail__chart-title">Coverage by move number</h2>
      <p class="tree-hint">
        What fraction of real games (by move frequency, at this study's Opening Explorer settings)
        are still following a line inside this study after each move.
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
    renderCoverageChart(canvas, stats.coverage, nodeCountsByMove(study.tree));
  }

  document.getElementById("recalc-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Calculating…";
    try {
      const res = await fetch(`/api/studies/${study.id}/stats`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) {
        btn.textContent = "Failed — try again";
        btn.disabled = false;
        return;
      }
      const updated: Study = await res.json();
      renderPage(main, updated);
    } catch {
      btn.textContent = "Failed — try again";
      btn.disabled = false;
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
  const study = studyId ? await loadStudy(studyId) : null;
  if (!study) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  renderPage(main, study);
}

init();
