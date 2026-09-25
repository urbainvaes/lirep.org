import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, type StudyTree } from "./tree";

interface StudyStats {
  winProbability: number;
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

function statCard(study: Study): string {
  const sideLabel = study.side === "white" ? "Playing White" : "Playing Black";
  const hasMoves = mainLineSans(study.tree).length > 0 || Object.keys(study.tree.nodes).length > 1;

  const scoreHtml = study.stats
    ? `<div class="stat-card__score">${(study.stats.winProbability * 100).toFixed(1)}%</div>`
    : `<div class="stat-card__score stat-card__score--empty">—</div>`;

  const metaHtml = study.stats
    ? `<p class="stat-card__meta">
         ${statsSourceLabel(study.stats)} · ${study.stats.nodesEvaluated} positions evaluated<br />
         As of ${formatDate(study.stats.calculatedAt)}
       </p>`
    : `<p class="stat-card__meta">Not calculated yet.</p>`;

  return `
    <div class="stat-card" data-study-id="${study.id}">
      <div class="stat-card__header">
        <h3>${escapeHtml(study.name)}</h3>
        <span class="stat-card__side">${sideLabel}</span>
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

function attachCardHandlers(grid: HTMLElement): void {
  grid.querySelectorAll<HTMLButtonElement>(".stat-card__recalc").forEach((btn) => {
    btn.onclick = () => {
      const card = btn.closest(".stat-card") as HTMLElement;
      const studyId = Number(btn.dataset.studyId);
      void recalculate(studyId, btn, card);
    };
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
