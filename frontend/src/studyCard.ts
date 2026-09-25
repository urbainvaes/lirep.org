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

function openingMovesHtml(study: StudyCardData): string {
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

export function renderStudyCard(study: StudyCardData, href: string): string {
  const side = study.side === "white" ? "white" : "black";
  const score = study.stats?.winProbability;
  const scoreLabel = score === undefined ? "—" : `${(score * 100).toFixed(1)}%`;

  return `
    <a class="study-card study-card--summary" href="${href}">
      <div class="study-card__header">
        <h3>${escapeHtml(study.name)}</h3>
        <span class="study-card__side">${side === "white" ? "♙ White" : "♟ Black"}</span>
      </div>
      <div class="study-card__score"><span>Expected score</span><strong>${scoreLabel}</strong></div>
      <div class="study-card__line">${openingMovesHtml(study)}</div>
    </a>
  `;
}
