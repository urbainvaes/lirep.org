import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, type StudyTree } from "./tree";

interface StudyStats {
  winProbability: number;
  // Optional: stats computed before this field existed won't have it —
  // "Recalculate" fills it in.
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

const studiesById = new Map<number, Study>();

function renderSignedOut(grid: HTMLElement): void {
  grid.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to see your studies' stats.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
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

function statCard(study: Study): string {
  studiesById.set(study.id, study);

  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const sideDotClass = `side-dot side-dot--${study.side}`;
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;

  const scoreHtml = study.stats
    ? `<div class="stat-card__score">${(study.stats.winProbability * 100).toFixed(1)}% <span class="stat-card__medal">${medalFor(study.stats.winProbability)}</span></div>`
    : `<div class="stat-card__score stat-card__score--empty">—</div>`;

  const metaHtml = study.stats
    ? `<p class="stat-card__meta">
         ${statsSourceLabel(study.stats)} · ${study.stats.nodesEvaluated} positions evaluated<br />
         As of ${formatDate(study.stats.calculatedAt)}
       </p>`
    : `<p class="stat-card__meta">Not calculated yet.</p>`;

  return `
    <div class="stat-card" data-study-id="${study.id}" ${study.stats ? 'tabindex="0" role="button"' : ""}>
      <div class="stat-card__header">
        <h3>${escapeHtml(study.name)}</h3>
        <span class="stat-card__side"><span class="${sideDotClass}"></span>${sideLabel}</span>
      </div>
      ${scoreHtml}
      <p class="stat-card__label">Expected score, assuming perfect memorization</p>
      ${metaHtml}
      <button
        class="btn btn-secondary stat-card__recalc"
        type="button"
        data-study-id="${study.id}"
        ${hasMoves ? "" : "disabled"}
      >
        ${study.stats ? "Recalculate" : "Calculate"}
      </button>
    </div>
  `;
}

async function recalculate(studyId: number, btn: HTMLButtonElement, card: HTMLElement): Promise<void> {
  const grid = card.parentElement as HTMLElement;
  btn.disabled = true;
  btn.textContent = "Calculating…";

  try {
    const res = await fetch(`/api/studies/${studyId}/stats`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) {
      btn.textContent = "Failed — try again";
      btn.disabled = false;
      return;
    }
    const study: Study = await res.json();
    card.outerHTML = statCard(study);
    attachCardHandlers(grid);
  } catch {
    btn.textContent = "Failed — try again";
    btn.disabled = false;
  }
}

function openDetail(studyId: number): void {
  window.location.href = `/stat.html?id=${studyId}`;
}

function attachCardHandlers(grid: HTMLElement): void {
  grid.querySelectorAll<HTMLButtonElement>(".stat-card__recalc").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const card = btn.closest(".stat-card") as HTMLElement;
      const studyId = Number(btn.dataset.studyId);
      void recalculate(studyId, btn, card);
    };
  });

  grid.querySelectorAll<HTMLElement>(".stat-card").forEach((card) => {
    const studyId = Number(card.dataset.studyId);
    const study = studiesById.get(studyId);
    if (!study?.stats) return; // nothing to show yet
    card.addEventListener("click", () => openDetail(studyId));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(studyId);
      }
    });
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("stats-grid");
  if (!grid) return;

  if (!me.authenticated) {
    renderSignedOut(grid);
    return;
  }

  let studies: Study[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Network error / backend not running: show an empty grid below.
  }

  if (studies.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p>No studies yet. Create one in the Studies tab first.</p>
        <a class="btn btn-primary" href="/study.html">New study</a>
      </div>
    `;
    return;
  }

  grid.innerHTML = studies.map(statCard).join("");
  attachCardHandlers(grid);
}

init();
