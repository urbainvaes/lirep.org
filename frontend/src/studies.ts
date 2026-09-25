import { fetchMe, renderAuthArea } from "./layout";
import { renderStudyCard, type StudyCardData } from "./studyCard";

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

  const cards = studies.map((study) => renderStudyCard(study, `/study.html?id=${study.id}`)).join("");
  grid.innerHTML = `
    ${cards}
    <a class="study-card study-card--new" href="/study.html">
      <span class="study-card__plus">+</span>
      <span>New study</span>
    </a>
  `;
}

init();
