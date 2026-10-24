import { escapeHtml } from "./layout";
import { sanPathTo, type StudyTree } from "./tree";
import { evalPiece, PIECE_LABELS, pieceBadgeHtml, scoreTier, TIER_LABELS } from "./scoreTiers";

export interface StudyCardData {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  startNodeId: number | null;
  stats?: { winProbability?: number; evalCp?: number } | null;
  archived?: boolean;
  gameCount?: number;
}

export function renderStudyGroups(
  studies: StudyCardData[],
  renderCard: (study: StudyCardData) => string,
  gridClass: "studies-grid" | "practice-grid",
  renderAddition?: (side: "white" | "black") => string,
): string {
  return `
    <div class="opening-groups">
      ${(["white", "black"] as const).map((side) => {
        const group = studies.filter((study) => study.side === side);
        const title = side === "white" ? "Openings for White" : "Openings for Black";
        const cards = group.map(renderCard).join("") + (renderAddition?.(side) ?? "");
        return `
          <section class="opening-group">
            <h2>${title}</h2>
            <div class="${gridClass}">
              ${cards || `<p class="opening-group__empty">No openings for ${side === "white" ? "White" : "Black"} yet.</p>`}
            </div>
          </section>
        `;
      }).join("")}
    </div>
  `;
}

export function renderNewStudyCard(side: "white" | "black" = "white"): string {
  return `
    <a class="study-card study-card--new" href="/study.html?side=${side}">
      <span class="study-card__plus">+</span>
      <span>New ${side === "white" ? "White" : "Black"} study</span>
    </a>
  `;
}

export function openingMovesHtml(study: StudyCardData): string {
  const startId = study.startNodeId !== null && study.tree.nodes[study.startNodeId]
    ? study.startNodeId
    : study.tree.rootId;
  const sans = sanPathTo(study.tree, startId);

  if (sans.length === 0) return '<span class="study-card__start">Starting position</span>';

  const rows: string[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    const fullMove = Math.floor(i / 2) + 1;
    const whiteMove = `<span class="tree-move ${study.side === "white" ? "tree-move--mine" : ""}">${escapeHtml(sans[i])}</span>`;
    const blackMove = sans[i + 1]
      ? `<span class="tree-move ${study.side === "black" ? "tree-move--mine" : ""}">${escapeHtml(sans[i + 1])}</span>`
      : "";
    rows.push(`<span class="study-card__move-line"><span class="tree-move-number">${fullMove}.</span> ${whiteMove}${blackMove ? ` ${blackMove}` : ""}</span>`);
  }

  return rows.join("");
}

// An active study's archive box: it moves the study to the archive.
function archiveButtonHtml(study: StudyCardData): string {
  return `<button class="study-card__icon-btn" type="button" data-archive-study="${study.id}" aria-label="Archive ${escapeHtml(study.name)}" title="Archive study">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/></svg>
      </button>`;
}

// An archived study's bin: it deletes the study for good.
function deleteButtonHtml(study: StudyCardData): string {
  return `<button class="study-card__delete" type="button" data-delete-study="${study.id}" aria-label="Delete ${escapeHtml(study.name)}" title="Delete study for good">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>
      </button>`;
}

function duplicateButtonHtml(study: StudyCardData): string {
  return `<button class="study-card__icon-btn" type="button" data-duplicate-study="${study.id}" aria-label="Duplicate ${escapeHtml(study.name)}" title="Duplicate study">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>`;
}

/** The name a copy is offered: "Alapin (copy)", or "(copy 2)" and so on
 * when that one is taken. */
function copyName(name: string, studies: StudyCardData[]): string {
  const taken = new Set(studies.map((s) => s.name));
  for (let n = 1; ; n++) {
    const candidate = `${name} (copy${n === 1 ? "" : ` ${n}`})`;
    if (!taken.has(candidate)) return candidate;
  }
}

function renderStudyCardContent(study: StudyCardData, headerExtra = ""): string {
  const score = study.stats?.winProbability;
  const scoreLabel = score === undefined ? "—" : `${(score * 100).toFixed(1)}%`;

  return `
    <div class="study-card__header">
      <h3>${escapeHtml(study.name)}</h3>
      ${headerExtra}
    </div>
    <div class="study-card__score"><span title="Win % + half of the draw % (a win counts 1, a draw 0.5), from real games in the Explorer, if you always play your prepared moves.">Expected score</span><strong>${scoreLabel}</strong></div>
    <div class="study-card__line">${openingMovesHtml(study)}</div>
  `;
}

// Only when the study has games: a badge by the name (the Games page's book
// icon and the count), linking to the Games page.
function gamesBadgeHtml(study: StudyCardData): string {
  if (!study.gameCount) return "";
  const label = `${study.gameCount} game${study.gameCount === 1 ? "" : "s"}`;
  return `<a class="study-card__games" href="/games.html?id=${study.id}" title="${label}: open the Games page" aria-label="${label}">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>${study.gameCount}
    </a>`;
}

// The study's badge, as on its Stats page, linking there, at the top right
// of the card: the piece of its expected evaluation (the king when not
// calculated yet), in its tier's colour (grey when not calculated yet).
function trophyLinkHtml(study: StudyCardData): string {
  const score = study.stats?.winProbability;
  const evalCp = study.stats?.evalCp;
  const tier = scoreTier(score, study.side);
  const piece = evalPiece(evalCp);
  const scoreText = score === undefined
    ? "expected score not calculated yet"
    : `${TIER_LABELS[tier]} · expected score ${(score * 100).toFixed(1)}%`;
  const evalText = evalCp === undefined
    ? "expected evaluation not calculated yet"
    : `${PIECE_LABELS[piece]} · expected evaluation ${evalCp >= 0 ? "+" : "−"}${Math.abs(evalCp / 100).toFixed(2)}`;
  const title = `${scoreText}; ${evalText} — click to see the stats`;
  return `<a class="study-card__trophy" href="/stat.html?id=${study.id}" title="${title}" aria-label="${title}">${pieceBadgeHtml(tier, "sm", piece)}</a>`;
}

/** A home-page card. An archived study's card has Restore in place of
 * Practice, and the bin; an active one's, the archive box. */
export function renderStudyCardWithActions(study: StudyCardData): string {
  return `
    <article class="study-card study-card--summary${study.archived ? " study-card--archived" : ""}">
      ${renderStudyCardContent(study, `<span class="study-card__header-end">${gamesBadgeHtml(study)}${trophyLinkHtml(study)}</span>`)}
      <div class="study-card__actions">
        <a class="btn btn-secondary" href="/study.html?id=${study.id}">Edit</a>
        ${
          study.archived
            ? `<button class="btn btn-secondary" type="button" data-restore-study="${study.id}" title="Back to your openings">Restore</button>`
            : `<a class="btn btn-secondary" href="/practice-session.html?id=${study.id}">Practice</a>`
        }
        <span class="study-card__icons">${duplicateButtonHtml(study)}${study.archived ? deleteButtonHtml(study) : archiveButtonHtml(study)}</span>
      </div>
      <form class="study-card__duplicate" data-duplicate-form="${study.id}" hidden>
        <input class="study-card__duplicate-name" type="text" required maxlength="200" aria-label="Name of the copy" />
        <button class="btn btn-primary" type="submit">Duplicate</button>
        <button class="btn btn-secondary" type="button" data-duplicate-cancel>Cancel</button>
      </form>
    </article>
  `;
}

/** Handles a card's duplicate button: it swaps the card's buttons for a
 * name (its own plus "(copy)", selected), and Duplicate makes a private
 * copy (see store.duplicate_study), shown first among the side's studies. */
export function bindStudyDuplicate(
  grid: HTMLElement,
  studies: StudyCardData[],
  rerender: () => void,
): void {
  const card = (el: Element) => el.closest<HTMLElement>(".study-card") as HTMLElement;
  const show = (cardEl: HTMLElement, open: boolean) => {
    (cardEl.querySelector(".study-card__actions") as HTMLElement).hidden = open;
    (cardEl.querySelector("[data-duplicate-form]") as HTMLElement).hidden = !open;
  };
  grid.addEventListener("click", (event) => {
    const target = event.target as Element;
    const button = target.closest<HTMLButtonElement>("[data-duplicate-study]");
    if (button) {
      event.preventDefault();
      const study = studies.find((s) => s.id === Number(button.dataset.duplicateStudy));
      if (!study) return;
      const cardEl = card(button);
      const input = cardEl.querySelector(".study-card__duplicate-name") as HTMLInputElement;
      input.value = copyName(study.name, studies);
      show(cardEl, true);
      input.focus();
      input.select();
      return;
    }
    if (target.closest("[data-duplicate-cancel]")) show(card(target), false);
  });
  grid.addEventListener("keydown", (event) => {
    const target = event.target as Element;
    if (event.key === "Escape" && target.closest("[data-duplicate-form]")) show(card(target), false);
  });
  grid.addEventListener("submit", async (event) => {
    const form = (event.target as Element).closest<HTMLFormElement>("[data-duplicate-form]");
    if (!form) return;
    event.preventDefault();
    const id = Number(form.dataset.duplicateForm);
    const original = studies.find((s) => s.id === id);
    const name = (form.querySelector(".study-card__duplicate-name") as HTMLInputElement).value.trim();
    if (!original || !name) return;
    const submit = form.querySelector<HTMLButtonElement>("[type=submit]")!;
    submit.disabled = true;
    try {
      const res = await fetch(`/api/studies/${id}/duplicate`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Duplicate failed");
      const copy = (await res.json()) as StudyCardData;
      studies.unshift({ ...copy, gameCount: original.gameCount });
      rerender();
    } catch {
      submit.disabled = false;
      window.alert("Could not duplicate the study. Please try again.");
    }
  });
}

/** Archives or restores a study; false if the server refused. */
export async function setArchived(study: StudyCardData, archived: boolean): Promise<boolean> {
  try {
    const res = await fetch(`/api/studies/${study.id}/archived`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    });
    if (!res.ok) return false;
    study.archived = archived;
    return true;
  } catch {
    return false;
  }
}

/** Handles a card's archive box and Restore button: `onArchived` is told
 * of a study just archived (for its Undo). */
export function bindStudyArchive(
  grid: HTMLElement,
  studies: StudyCardData[],
  rerender: () => void,
  onArchived: (study: StudyCardData) => void,
): void {
  grid.addEventListener("click", async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-archive-study], [data-restore-study]");
    if (!button) return;
    event.preventDefault();
    const archive = button.dataset.archiveStudy !== undefined;
    const study = studies.find((s) => s.id === Number(button.dataset.archiveStudy ?? button.dataset.restoreStudy));
    if (!study) return;
    button.disabled = true;
    if (!(await setArchived(study, archive))) {
      button.disabled = false;
      window.alert(`Could not ${archive ? "archive" : "restore"} the study. Please try again.`);
      return;
    }
    rerender();
    if (archive) onArchived(study);
  });
}

/** Handles clicks on an archived card's bin: confirm, DELETE, then drop the study and re-render. */
export function bindStudyDelete(
  grid: HTMLElement,
  studies: StudyCardData[],
  rerender: () => void,
): void {
  grid.addEventListener("click", async (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-delete-study]");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const id = Number(button.dataset.deleteStudy);
    const index = studies.findIndex((study) => study.id === id);
    if (index < 0 || !window.confirm(`Delete "${studies[index].name}" for good? This cannot be undone.`)) return;
    button.disabled = true;
    try {
      const res = await fetch(`/api/studies/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error("Delete failed");
      studies.splice(index, 1);
      rerender();
    } catch {
      button.disabled = false;
      window.alert("Could not delete the study. Please try again.");
    }
  });
}
