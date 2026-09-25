import { formatMoves } from "./board";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { mainLineSans, type StudyTree } from "./tree";

interface StudySummary {
  id: number;
  name: string;
  tree: StudyTree;
}

function renderSignedOut(grid: HTMLElement): void {
  grid.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to create studies.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

function studyCard(study: StudySummary): string {
  const mainLine = mainLineSans(study.tree);
  const preview = mainLine.slice(0, 6);
  const line = preview.length ? escapeHtml(formatMoves(preview)) + (mainLine.length > 6 ? "…" : "") : "No moves yet";

  const nodeCount = Object.keys(study.tree.nodes).length - 1; // exclude the root
  const hasVariations = nodeCount > mainLine.length;
  const moveCount = `${mainLine.length} ${mainLine.length === 1 ? "move" : "moves"}${hasVariations ? " + variations" : ""}`;

  return `
    <a class="study-card" href="/study.html?id=${study.id}">
      <h3>${escapeHtml(study.name)}</h3>
      <p class="study-card__line">${line}</p>
      <p class="study-card__meta">${moveCount}</p>
    </a>
  `;
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("studies-grid");
  if (!grid) return;

  if (!me.authenticated) {
    renderSignedOut(grid);
    return;
  }

  let studies: StudySummary[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Network error / backend not running: show an empty grid below.
  }

  const cards = studies.map(studyCard).join("");
  grid.innerHTML = `
    ${cards}
    <a class="study-card study-card--new" href="/study.html">
      <span class="study-card__plus">+</span>
      <span>New study</span>
    </a>
  `;
}

init();
