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
  gridClass: "studies-grid" | "stats-grid" | "practice-grid",
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

export function renderAlapinStudyCard(): string {
  return `
    <a class="study-card study-card--new" href="/study.html?template=alapin">
      <span class="study-card__plus">+</span>
      <span>Alapin (White)</span>
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

function renderStudyCardContent(study: StudyCardData): string {
  const side = study.side === "white" ? "white" : "black";
  const score = study.stats?.winProbability;
  const scoreLabel = score === undefined ? "—" : `${(score * 100).toFixed(1)}%`;

  return `
    <div class="study-card__header">
      <h3>${escapeHtml(study.name)}</h3>
      <span class="study-card__side">${side === "white" ? "♙ White" : "♟ Black"}</span>
    </div>
    <div class="study-card__score"><span>Expected score</span><strong>${scoreLabel}</strong></div>
    <div class="study-card__line">${openingMovesHtml(study)}</div>
  `;
}

export function renderStudyCard(study: StudyCardData, href: string): string {
  return `<a class="study-card study-card--summary" href="${href}">${renderStudyCardContent(study)}</a>`;
}

export function renderStudyCardWithActions(study: StudyCardData): string {
  return `
    <article class="study-card study-card--summary">
      ${renderStudyCardContent(study)}
      <div class="study-card__actions">
        <a class="btn btn-secondary" href="/study.html?id=${study.id}">Edit</a>
        <a class="btn btn-secondary" href="/practice-session.html?id=${study.id}">Practice</a>
        <a class="btn btn-secondary" href="/stat.html?id=${study.id}">Stats</a>
      </div>
    </article>
  `;
}
