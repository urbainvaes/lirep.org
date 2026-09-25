import { escapeHtml } from "./layout";
import { sanPathTo, type StudyTree } from "./tree";

export interface StudyCardData {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  startNodeId: number | null;
  stats?: { winProbability?: number } | null;
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

function deleteButtonHtml(study: StudyCardData): string {
  return `<button class="study-card__delete" type="button" data-delete-study="${study.id}" aria-label="Delete ${escapeHtml(study.name)}" title="Delete study">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg>
      </button>`;
}

function renderStudyCardContent(study: StudyCardData): string {
  const score = study.stats?.winProbability;
  const scoreLabel = score === undefined ? "—" : `${(score * 100).toFixed(1)}%`;

  return `
    <div class="study-card__header">
      <h3>${escapeHtml(study.name)}</h3>
    </div>
    <div class="study-card__score"><span title="Win % + half of the draw % (a win counts 1, a draw 0.5), from real games in the Explorer, if you always play your prepared moves.">Expected score</span><strong>${scoreLabel}</strong></div>
    <div class="study-card__line">${openingMovesHtml(study)}</div>
  `;
}

export function renderStudyCardWithActions(study: StudyCardData): string {
  return `
    <article class="study-card study-card--summary">
      ${renderStudyCardContent(study)}
      <div class="study-card__actions">
        <a class="btn btn-secondary" href="/study.html?id=${study.id}">Edit</a>
        <a class="btn btn-secondary" href="/practice-session.html?id=${study.id}">Practice</a>
        <a class="btn btn-secondary" href="/stat.html?id=${study.id}">Stats</a>
        ${deleteButtonHtml(study)}
      </div>
    </article>
  `;
}

/** Handles clicks on a card's bin button: confirm, DELETE, then drop the study and re-render. */
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
    if (index < 0 || !window.confirm(`Delete "${studies[index].name}"? This cannot be undone.`)) return;
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
