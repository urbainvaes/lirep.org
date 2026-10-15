import { bindZoom, renderLanding } from "./landing";
import { fetchMe, renderAuthArea } from "./layout";
import { studyFromFile } from "./studyFile";
import { bindStudyDelete, renderStudyCardWithActions, renderStudyGroups, renderNewStudyCard, type StudyCardData } from "./studyCard";

// Import a Lirep study file (see studyFile.ts) as a new study, then open it.
function importStudyHtml(): string {
  return `
    <div class="study-import">
      <label class="btn btn-secondary study-import__btn">
        Import a study from a file
        <input id="study-import-file" type="file" accept=".json,application/json" hidden />
      </label>
      <span id="study-import-status" class="study-import__status" role="status" aria-live="polite"></span>
    </div>
  `;
}

function bindStudyImport(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>("#study-import-file");
  const status = root.querySelector<HTMLElement>("#study-import-status");
  if (!input || !status) return;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.value = ""; // the same file can be chosen again after fixing it
    if (!file) return;
    status.classList.remove("study-import__status--error");
    status.textContent = "Importing…";
    try {
      const { games, ...study } = studyFromFile(await file.text());
      const res = await fetch("/api/studies", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(study),
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error("Your session has expired. Please sign in again.");
        const detail = await res.json().then((body) => body.detail, () => null);
        throw new Error(typeof detail === "string" ? `The server refused this study: ${detail}.` : "The server refused this study.");
      }
      const created = await res.json();
      // The games, section by section in the file's order (a section is
      // created where its first game appears).
      const sections = [...new Set(games.map((g) => g.section))];
      for (const section of sections) {
        const gamesRes = await fetch(`/api/studies/${created.id}/games`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section, games: games.filter((g) => g.section === section).map(({ pgn, comment }) => ({ pgn, comment: comment ?? "" })) }),
        });
        if (!gamesRes.ok) throw new Error(`The study was created, but its games in "${section}" could not be added.`);
      }
      window.location.href = `/study.html?id=${created.id}`;
    } catch (err) {
      status.classList.add("study-import__status--error");
      status.textContent = err instanceof Error ? err.message : "Could not import this file.";
    }
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("home-studies-grid");
  if (!grid) return;

  if (!me.authenticated) {
    grid.innerHTML = renderLanding(false);
    bindZoom(grid);
    return;
  }

  let studies: StudyCardData[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Keep the new-study action available if loading fails.
  }

  const render = (): void => {
    grid.innerHTML =
      renderStudyGroups(studies, renderStudyCardWithActions, "studies-grid", renderNewStudyCard) + importStudyHtml();
    bindStudyImport(grid);
  };
  render();
  bindStudyDelete(grid, studies, render);
}

init();
