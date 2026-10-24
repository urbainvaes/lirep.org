import { bindZoom, renderLanding } from "./landing";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { studyFromFile } from "./studyFile";
import { bindStudyArchive, bindStudyDelete, bindStudyDuplicate, bindTitleScroll, renderStudyCardWithActions, setArchived, renderStudyGroups, renderNewStudyCard, type StudyCardData } from "./studyCard";

// Import a Lirep study file (see studyFile.ts) as a new study, then open it.
const SHOW_ARCHIVED_KEY = "home-show-archived";

function savedShowArchived(): boolean {
  try {
    return localStorage.getItem(SHOW_ARCHIVED_KEY) === "1";
  } catch {
    return false;
  }
}

// The archived studies, after the others: their own section when shown,
// by side as above (a side with none is left out), then the switch that
// shows them (only when there are some), just above Import, so it stays in
// place when switched.
function archivedHtml(archived: StudyCardData[], shown: boolean): string {
  if (!archived.length) return "";
  const sides = (["white", "black"] as const)
    .map((side) => ({ side, cards: archived.filter((study) => study.side === side) }))
    .filter(({ cards }) => cards.length)
    .map(
      ({ side, cards }) => `
            <div class="opening-group__side">
              <h4>Openings for ${side === "white" ? "White" : "Black"}</h4>
              <div class="studies-grid">${cards.map(renderStudyCardWithActions).join("")}</div>
            </div>`,
    )
    .join("");
  return `
    ${
      shown
        ? `<section class="opening-group opening-group--archived">
            <h2>Archived</h2>
            <p class="opening-group__note">Kept, but off the Practice and Community pages. Restore one to bring it back; the bin deletes it for good.</p>
            ${sides}
          </section>`
        : ""
    }
    <div class="archived-bar">
      <button id="show-archived" class="study-switch" type="button" role="switch" aria-checked="${shown}"><span class="study-switch__track" aria-hidden="true"></span>Show archived (${archived.length})</button>
    </div>
  `;
}

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

  let showArchived = savedShowArchived();
  const render = (): void => {
    const active = studies.filter((study) => !study.archived);
    const archived = studies.filter((study) => study.archived);
    grid.innerHTML =
      renderStudyGroups(active, renderStudyCardWithActions, "studies-grid", renderNewStudyCard) +
      archivedHtml(archived, showArchived) +
      importStudyHtml() +
      `<p id="archive-note" class="archive-note" role="status" aria-live="polite" hidden></p>`;
    bindStudyImport(grid);
  };
  render();
  grid.addEventListener("click", (event) => {
    if (!(event.target as Element).closest("#show-archived")) return;
    showArchived = !showArchived;
    try {
      localStorage.setItem(SHOW_ARCHIVED_KEY, showArchived ? "1" : "0");
    } catch {
      // Remembered for this visit only.
    }
    render();
  });
  // Archiving says so for a few seconds, with Undo: a card that vanishes
  // could otherwise look deleted.
  let noteTimer: number | null = null;
  bindStudyArchive(grid, studies, render, (study) => {
    const note = document.getElementById("archive-note") as HTMLElement;
    note.innerHTML = `Archived “${escapeHtml(study.name)}”. <button class="archive-note__undo" type="button">Undo</button>`;
    note.hidden = false;
    (note.querySelector("button") as HTMLButtonElement).addEventListener("click", async () => {
      if (await setArchived(study, false)) render();
    });
    if (noteTimer !== null) window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      const current = document.getElementById("archive-note");
      if (current) current.hidden = true;
    }, 8000);
  });
  bindStudyDelete(grid, studies, render);
  bindTitleScroll(grid);
  bindStudyDuplicate(grid, studies, render);
}

init();
