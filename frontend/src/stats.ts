import { fetchMe, renderAuthArea, renderSignedOut } from "./layout";
import { renderStudyCard, renderStudyGroups, type StudyCardData } from "./studyCard";

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

  grid.innerHTML = renderStudyGroups(
    studies,
    (study) => renderStudyCard(study, `/stat.html?id=${study.id}`),
    "stats-grid",
  );
}

init();
