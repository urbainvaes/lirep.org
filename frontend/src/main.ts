import { fetchMe, renderAuthArea } from "./layout";
import { studyFromFile } from "./studyFile";
import { bindStudyDelete, renderStudyCardWithActions, renderStudyGroups, renderNewStudyCard, type StudyCardData } from "./studyCard";

// A screenshot in the visitor's theme: both versions are in the page, and
// CSS shows the one matching <html data-theme>. Lazy, so the hidden one is
// never downloaded. The images are at twice these sizes, for sharp
// rendering and for the zoomed view (see bindZoom).
function screenshot(name: string, alt: string, width: number, height: number): string {
  const images = ["light", "dark"]
    .map(
      (theme) =>
        `<img class="landing__shot landing__shot--${theme}" src="/screenshots/${name}-${theme}.webp" alt="${alt}" width="${width}" height="${height}" loading="lazy" decoding="async" />`,
    )
    .join("");
  return `<button class="landing__zoom" type="button" aria-label="Enlarge: ${alt}" title="Click to enlarge">${images}</button>`;
}

// Clicking a screenshot shows it at full resolution over the page; Esc, a
// click anywhere or the close button dismisses it.
function bindZoom(root: HTMLElement): void {
  const dialog = document.createElement("dialog");
  dialog.className = "landing__lightbox";
  dialog.innerHTML = `<button class="landing__lightbox-close" type="button" aria-label="Close">×</button><img alt="" />`;
  document.body.append(dialog);
  const img = dialog.querySelector("img") as HTMLImageElement;
  dialog.addEventListener("click", () => dialog.close());
  root.querySelectorAll<HTMLButtonElement>(".landing__zoom").forEach((button) => {
    button.addEventListener("click", () => {
      const shown = [...button.querySelectorAll("img")].find((i) => i.offsetParent !== null) ?? button.querySelector("img");
      if (!shown) return;
      img.src = shown.currentSrc || shown.src;
      img.alt = shown.alt;
      dialog.showModal();
    });
  });
}

// What a signed-out visitor sees: what Lirep is for, then a way in.
function renderLanding(): string {
  return `
    <section class="landing">
      <div class="landing__hero">
        <h1>Build, drill and assess your repertoire</h1>
        <p class="landing__pitch">Lirep evaluates your repertoire against the moves real Lichess players choose, then helps you remember it.</p>
        <div class="landing__actions">
          <a class="btn btn-primary landing__cta" href="/auth/login">Sign in with Lichess</a>
          <a class="btn btn-primary landing__cta" href="/community.html">Browse community openings</a>
        </div>
        <p class="landing__note">Free and open source. No new account: you sign in with Lichess.</p>
      </div>
      <figure class="landing__hero-shot">
        ${screenshot("editor", "The study editor: a move tree with variations beside the board, and Stockfish's suggested moves drawn as arrows coloured by quality.", 1272, 778)}
        <figcaption>Build your lines in the study editor, with Stockfish and the Lichess Opening Explorer beside the board.</figcaption>
      </figure>
      <div class="landing__features">
        <article class="landing__feature">
          <div class="landing__feature-text">
            <h2>Know how good it is</h2>
            <p>See the expected score of your whole repertoire (calculated as the win probability plus half the draw probability),
            the share of games that stay in your preparation after a given number of moves,
            and the expected Stockfish evaluation when it ends.</p>
          </div>
          ${screenshot("stats", "A study's Stats page: a 55.4% expected score, and a chart of the share of games still in preparation after each move.", 874, 619)}
        </article>
        <article class="landing__feature">
          <div class="landing__feature-text">
            <h2>Remember it</h2>
            <p>Practice quizzes you on your own moves. Each position's knowledge fades over time, and comes back
              for review just before you would forget it.</p>
          </div>
          ${screenshot("practice", "A practice session: the board after a correctly played move, marked Correct.", 812, 536)}
        </article>
        <article class="landing__feature">
          <div class="landing__feature-text">
            <h2>Share and reuse</h2>
            <p>Publish your openings on the community page, and import someone else's
              in one click.</p>
          </div>
          ${screenshot("community", "The community leaderboards: shared openings for White and Black, ranked by expected score.", 1092, 500)}
        </article>
      </div>
    </section>
  `;
}

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
      const study = studyFromFile(await file.text());
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
    grid.innerHTML = renderLanding();
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
