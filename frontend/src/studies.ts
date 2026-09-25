import { fetchMe, renderAuthArea, renderSignedOut } from "./layout";
import { renderNewStudyCard, renderStudyCard, renderStudyGroups, type StudyCardData } from "./studyCard";

type StudySummary = StudyCardData;

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
