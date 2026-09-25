import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, type StudyTree } from "./tree";

// winProbability and evalCp are computed by two independent backend jobs
// (see stat.ts's "Update win probability" / "Update expected evaluation"),
// so either can exist without the other — hence both optional, each with
// its own calculatedAt.
interface StudyStats {
  winProbability?: number;
  coverage?: number[]; // coverage[i] = fraction of games still in-book after move i+1
  winProbabilityCalculatedAt?: string;
  nodesEvaluated?: number;
  evalCp?: number; // expected Stockfish eval (centipawns, studied side's POV) at the end of prep
  evalMisses?: number; // how many of those leaf positions had no cached cloud eval (counted as 0)
  evalCalculatedAt?: string;
  database: "lichess" | "masters";
  minRating: number | null;
  explorerCalls?: number;
}

// A forced mate is capped at this "centipawn" value server-side (see
// backend/app/stats.py) so it can be averaged with ordinary evals.
const MATE_SCORE_CP = 100_000;

function formatEval(cp: number): string {
  if (Math.abs(cp) > MATE_SCORE_CP - 1000) return cp > 0 ? "Forced mate" : "Forced mate against";
  const pawns = cp / 100;
  return `${pawns > 0 ? "+" : ""}${pawns.toFixed(2)}`;
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

  const scoreHtml =
    study.stats?.winProbability !== undefined
      ? `<div class="stat-card__score">${(study.stats.winProbability * 100).toFixed(1)}% <span class="stat-card__medal">${medalFor(study.stats.winProbability)}</span></div>`
      : `<div class="stat-card__score stat-card__score--empty">—</div>`;

  const evalHtml =
    study.stats?.evalCp !== undefined
      ? `<p class="stat-card__eval">Eval at end of prep: <strong>${formatEval(study.stats.evalCp)}</strong></p>`
      : "";

  const metaHtml =
    study.stats?.winProbability !== undefined
      ? `<p class="stat-card__meta">
           ${statsSourceLabel(study.stats)} · ${study.stats.nodesEvaluated ?? 0} positions evaluated<br />
           As of ${formatDate(study.stats.winProbabilityCalculatedAt ?? "")}
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
      ${evalHtml}
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

interface JobStatus<T> {
  status: "running" | "done" | "error";
  done: number;
  total: number | null;
  result: T | null;
  error: string | null;
}

async function pollJob<T>(jobId: string, onProgress: (done: number) => void): Promise<T> {
  for (;;) {
    const res = await fetch(`/api/jobs/${jobId}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error("job status fetch failed");
    const job: JobStatus<T> = await res.json();
    onProgress(job.done);
    if (job.status === "done") return job.result as T;
    if (job.status === "error") throw new Error(job.error ?? "job failed");
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

// Calculating stats is now two independent background jobs (win probability
// and expected evaluation — see the Stats detail page, which exposes them as
// separate buttons since either can run without the other). The list card
// has no room for that nuance, so "Recalculate" here just runs both, one
// after the other, and reports whichever one is currently in flight.
async function recalculate(studyId: number, btn: HTMLButtonElement, card: HTMLElement): Promise<void> {
  const grid = card.parentElement as HTMLElement;
  btn.disabled = true;

  async function runJob(url: string, label: string): Promise<Study> {
    const startRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({}),
    });
    if (!startRes.ok) throw new Error("failed to start job");
    const { jobId } = await startRes.json();
    return pollJob<Study>(jobId, (done) => {
      btn.textContent = `${label}… (${done})`;
    });
  }

  let latest: Study | null = null;
  try {
    latest = await runJob(`/api/studies/${studyId}/win-probability`, "Win probability");
    latest = await runJob(`/api/studies/${studyId}/expected-eval`, "Expected eval");
    card.outerHTML = statCard(latest);
    attachCardHandlers(grid);
  } catch (err) {
    if (latest) {
      // One half succeeded before the other failed — show that rather than
      // discarding it, since it's already saved on the backend regardless.
      card.outerHTML = statCard(latest);
      attachCardHandlers(grid);
    } else {
      btn.textContent = "Failed — try again";
      btn.title = err instanceof Error ? err.message : "";
      btn.disabled = false;
    }
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
