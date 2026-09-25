import { fetchMe, renderAuthArea } from "./layout";
import { renderNewStudyCard, renderStudyCard, renderStudyGroups, type StudyCardData } from "./studyCard";

type StudySummary = StudyCardData;

function renderSignedOut(grid: HTMLElement): void {
  grid.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to create studies.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("studies-grid");
  if (!grid) return;

  if (!me.authenticated) {
    renderSignedOut(grid);
    return;
  }

  let studies: StudySummary[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Network error / backend not running: show an empty grid below.
  }

  grid.innerHTML = `
    ${renderStudyGroups(studies, (study) => renderStudyCard(study, `/study.html?id=${study.id}`), "studies-grid")}
    <div class="study-create-grid">${renderNewStudyCard()}</div>
  `;
}

init();
