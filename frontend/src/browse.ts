import { applyBoardTheme } from "./board";
import { DEFAULT_EXPLORER_SETTINGS } from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { observeMiniBoards } from "./miniBoard";
import { bindTitleScroll, cardBoardSpec, splitStudyName, studySizeHtml, variationHtml } from "./studyCard";
import { studyFromFile, type ImportedStudy } from "./studyFile";
import { renderTreeViewer } from "./treeViewer";

// Browse (browse.html): standard openings, with their usual moves, to
// preview and import as studies. The list and the studies are static files
// (public/openings/, built from openings/*.pgn by
// tools/build_browse_openings.py); importing creates the study as the home
// page's Import does. A preview is browse.html?o=<slug>.

interface BrowseOpening {
  slug: string;
  file: string;
  name: string;
  side: "white" | "black";
  eco: string;
  group: string; // White's first move, "1.e4"
  start: string[];
  mainLine: string[]; // after the start
  moves: number;
  lines: number;
  description: string;
}

const OPENINGS_URL = "/openings/";

async function loadIndex(): Promise<BrowseOpening[]> {
  const res = await fetch(`${OPENINGS_URL}index.json`);
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()).openings;
}

async function loadStudy(opening: BrowseOpening): Promise<ImportedStudy> {
  const res = await fetch(OPENINGS_URL + opening.file);
  if (!res.ok) throw new Error(String(res.status));
  return studyFromFile(await res.text());
}

/** Creates the study in your studies; returns its id. */
async function importOpening(opening: BrowseOpening): Promise<number> {
  const { games: _games, ...study } = await loadStudy(opening);
  const res = await fetch("/api/studies", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(study),
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()).id;
}

const signInHref = () => `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;

/** The Import button (signed in) or a sign-in link, and where its outcome is said. */
function importHtml(opening: BrowseOpening, signedIn: boolean): string {
  return signedIn
    ? `<button class="btn btn-secondary" type="button" data-import="${opening.slug}">Import</button>`
    : `<a class="btn btn-secondary" href="${signInHref()}">Sign in to import</a>`;
}

function bindImports(root: HTMLElement, openings: BrowseOpening[], message: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>("[data-import]").forEach((button) => {
    const opening = openings.find((o) => o.slug === button.dataset.import)!;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const id = await importOpening(opening);
        button.textContent = "Imported";
        message.hidden = false;
        message.innerHTML = `Imported “${escapeHtml(opening.name)}” into your studies. <a href="/study.html?id=${id}">Open it</a>`;
      } catch {
        button.disabled = false;
        message.hidden = false;
        message.textContent = "Could not import this opening. Please try again.";
      }
    });
  });
}

function cardHtml(opening: BrowseOpening, signedIn: boolean): string {
  const caption = opening.start.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(" ");
  const href = `/browse.html?o=${encodeURIComponent(opening.slug)}`;
  return `
    <article class="study-card study-card--summary">
      <div class="study-card__header">
        <h3 title="${escapeHtml(opening.name)}"><span class="study-card__title-text"><a class="study-card__title-link" href="${href}">${escapeHtml(splitStudyName(opening.name).opening)}</a></span>${variationHtml(opening.name)}</h3>
      </div>
      <p class="study-card__meta browse-description">${escapeHtml(opening.description)}</p>
      <div class="study-card__line study-card__line--board">
        <div class="study-card__board" data-mini-board data-side="${opening.side}" data-start="${escapeHtml(opening.start.join(" "))}" data-main="${escapeHtml(opening.mainLine.join(" "))}"></div>
        <span class="study-card__caption" title="${escapeHtml(caption)}">${escapeHtml(caption)}</span>
      </div>
      <p class="study-card__meta"><span title="ECO codes">${escapeHtml(opening.eco)}</span> · ${studySizeHtml({ moves: opening.moves, lines: opening.lines })}</p>
      <div class="study-card__footer">
        <a class="btn btn-secondary" href="${href}">Preview</a>
        ${importHtml(opening, signedIn)}
      </div>
    </article>
  `;
}

function sideHtml(openings: BrowseOpening[], side: "white" | "black", signedIn: boolean): string {
  const mine = openings.filter((o) => o.side === side);
  const groups = [...new Set(mine.map((o) => o.group))];
  return `
    <section class="profile-section">
      <div class="profile-section__heading"><h2>Openings for ${side === "white" ? "White" : "Black"}</h2></div>
      <div class="opening-groups">
        ${groups
          .map(
            (group) => `
          <section class="opening-group">
            <h4>${side === "white" ? escapeHtml(group) : `Against ${escapeHtml(group)}`}</h4>
            <div class="studies-grid">${mine.filter((o) => o.group === group).map((o) => cardHtml(o, signedIn)).join("")}</div>
          </section>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderList(main: HTMLElement, openings: BrowseOpening[], signedIn: boolean): void {
  main.innerHTML = `
    <p class="doc-intro">
      Standard openings, with their main line and usual variations, ready to import as a study and practise.
      Each starts at the opening's own position; import one, then add your own moves, or let the editor
      suggest more.
    </p>
    <div id="browse-message" class="community-message" role="status" aria-live="polite" hidden></div>
    ${sideHtml(openings, "white", signedIn)}
    ${sideHtml(openings, "black", signedIn)}
  `;
  bindImports(main, openings, main.querySelector<HTMLElement>("#browse-message")!);
  bindTitleScroll(main);
  observeMiniBoards(main, cardBoardSpec);
}

async function renderPreview(main: HTMLElement, opening: BrowseOpening, signedIn: boolean): Promise<void> {
  const study = await loadStudy(opening);
  const footer = renderTreeViewer(
    main,
    {
      tree: study.tree,
      side: study.side,
      startNodeId: study.startNodeId,
      explorerSettings: { ...DEFAULT_EXPLORER_SETTINGS, ...study.explorerSettings },
      title: opening.name,
      bylineHtml: `${escapeHtml(opening.eco)} · <a class="community-owner" href="/browse.html">All openings</a>`,
      intro: "Click a move to jump there. This opening is read-only: import it to change it.",
    },
    signedIn,
  );
  footer.innerHTML = signedIn
    ? `<span id="import-message" class="opening-import-message" role="status" aria-live="polite"></span>
       <button id="import-btn" class="study-head__link" type="button">Import to my studies</button>`
    : `<a class="study-head__link" href="${signInHref()}">Sign in to import</a>`;
  const button = footer.querySelector<HTMLButtonElement>("#import-btn");
  const message = footer.querySelector<HTMLElement>("#import-message");
  button?.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const id = await importOpening(opening);
      button.textContent = "Imported";
      message!.innerHTML = `Added to your studies. <a href="/study.html?id=${id}">Open it</a>`;
    } catch {
      button.disabled = false;
      message!.textContent = "Could not import this opening. Please try again.";
    }
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);
  const main = document.getElementById("browse-main");
  if (!main) return;
  try {
    const [openings] = await Promise.all([loadIndex(), applyBoardTheme()]);
    const slug = new URLSearchParams(location.search).get("o");
    if (slug === null) return renderList(main, openings, me.authenticated);
    const opening = openings.find((o) => o.slug === slug);
    if (!opening) {
      main.innerHTML = `<div class="empty-state"><p>There is no such opening.</p><a class="btn btn-secondary" href="/browse.html">All openings</a></div>`;
      return;
    }
    document.title = `${opening.name} · lirep.org`;
    await renderPreview(main, opening, me.authenticated);
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load the openings. Please try again in a moment.</p></div>`;
  }
}

init();
