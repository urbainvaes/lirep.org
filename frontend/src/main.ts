import { fetchMe, renderAuthArea } from "./layout";
import { renderStudyCardWithActions, renderStudyGroups, renderNewStudyCard, type StudyCardData } from "./studyCard";

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("home-studies-grid");
  if (!grid) return;

  if (!me.authenticated) {
    grid.innerHTML = `
      <div class="empty-state">
        <p>Sign in with your Lichess account to see your openings.</p>
        <a class="btn btn-primary" href="/auth/login">Sign in</a>
      </div>
    `;
    return;
  }

  let studies: StudyCardData[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Keep the new-study action available if loading fails.
  }

  grid.innerHTML = `
    ${renderStudyGroups(studies, renderStudyCardWithActions, "studies-grid", renderNewStudyCard)}
  `;
}

init();
