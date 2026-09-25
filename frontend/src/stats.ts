import { fetchMe, renderAuthArea } from "./layout";
import { renderStudyCard, type StudyCardData } from "./studyCard";

function renderSignedOut(grid: HTMLElement): void {
  grid.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to see your studies' stats.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
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

  let studies: StudyCardData[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Network error / backend not running: show the empty state below.
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

  grid.innerHTML = studies
    .map((study) => renderStudyCard(study, `/stat.html?id=${study.id}`))
    .join("");
}

init();
