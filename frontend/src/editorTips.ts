// The study editor's tips (tips.ts): its buttons, each with its own icon,
// copied from the page so that the tips stay in step with it, and what it
// does. A panel at the top of the moves' card, while tips are on.

import { setTips } from "./tips";

interface EditorTip {
  /** The controls explained, by id: their icons head the tip. */
  ids: string[];
  html: string;
}

const EDITOR_TIPS: EditorTip[] = [
  {
    ids: [],
    html: "<strong>Play moves on the board</strong> to add them: yours and the replies you expect. A different move from any point starts a variation; click a move in the list to go back there.",
  },
  {
    ids: [],
    html: "<strong>The figures after a reply</strong>, e.g. <span class=\"tree-move-stat\">25% · 55.2%</span>: how often the games reach it, and your expected score from there, with the Explorer's settings. The number in brackets after a folded line is how many moves it holds.",
  },
  {
    ids: ["fold-btn", "autofold-btn"],
    html: "<strong>Fold branches</strong> puts the moves at each branching in folds, opened by a click; <strong>Auto-fold</strong> closes a variation's fold when you move out of it.",
  },
  { ids: ["comment-btn"], html: "A <strong>comment</strong> on the selected position (Enter to finish)." },
  { ids: ["open-lichess-analysis"], html: "Opens the position on <strong>Lichess's analysis board</strong>." },
  {
    ids: ["start-point-btn"],
    html: "Makes the selected move the study's <strong>starting point</strong>: the stats and the practice start there. Click it there again to clear it.",
  },
  { ids: ["delete-btn"], html: "<strong>Deletes</strong> the selected move and everything after it (Delete)." },
  { ids: ["keyboard-help-btn"], html: "The <strong>keyboard shortcuts</strong>." },
  {
    ids: ["nav-start", "nav-back", "nav-forward", "nav-end"],
    html: "<strong>Step through the moves</strong>: the start, the previous move, the next one, the end of the line (also the arrow keys).",
  },
  { ids: ["flip-board-btn"], html: "<strong>Flips</strong> the board." },
  { ids: ["focus-btn"], html: "<strong>Focus mode</strong>: only the board, the moves and the tools fill the window (Space or Z)." },
  {
    ids: ["tab-explorer"],
    html: "The <strong>Opening Explorer</strong>: the moves played in this position, how often, and how they score, in the games the study's settings choose.",
  },
  { ids: ["tab-engine"], html: "<strong>Stockfish</strong>'s evaluation of the position and its best lines, in this browser." },
  {
    ids: ["tab-suggest"],
    html: "<strong>Suggests moves</strong> of yours to add: one at a time, each the one that raises the expected score most.",
  },
  {
    ids: ["tab-settings"],
    html: "The <strong>settings</strong>: which games the Explorer uses (database, ratings, time controls), how a line's end is valued, Stockfish's depth. Saved with the study.",
  },
  { ids: ["rename-btn"], html: "<strong>Renames</strong> the study." },
  {
    ids: ["study-stats-link", "study-practice-link", "study-games-link"],
    html: "The study's other pages: its <strong>Stats</strong> (expected score and evaluation), <strong>Practice</strong> (drills your moves), and its <strong>Games</strong>.",
  },
  {
    ids: ["study-menu"],
    html: "<strong>More</strong>: share the study with the community, export it to a file, or delete it.",
  },
];

/** A control's icon, as on the page: its picture (SVG), its icon-font
 * glyph (data-icon), or its text. */
function iconHtml(id: string): string {
  const element = document.getElementById(id);
  if (!element) return "";
  const target = element.matches("details") ? element.querySelector("summary") ?? element : element;
  const svg = target.querySelector("svg");
  if (svg) return `<span class="tips-icon">${svg.outerHTML}</span>`;
  const glyph = target.getAttribute("data-icon");
  if (glyph) return `<span class="tips-icon" data-icon="${glyph}"></span>`;
  const text = target.textContent?.trim() ?? "";
  return text ? `<span class="tips-icon tips-icon--text">${text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</span>` : "";
}

/** Fills the editor's tips panel (#editor-tips), and binds its "Hide tips". */
export function renderEditorTips(): void {
  const panel = document.getElementById("editor-tips");
  if (!panel) return;
  const rows = EDITOR_TIPS.map(({ ids, html }) => {
    const icons = ids.map(iconHtml).join("");
    return `<li class="editor-tips__row">${icons ? `<span class="editor-tips__icons">${icons}</span>` : ""}<span>${html}</span></li>`;
  }).join("");
  panel.innerHTML = `
    <div class="editor-tips__head">
      <p class="editor-tips__title">Tips</p>
      <button class="editor-tips__hide" type="button" title="Hide tips (the ? at the top shows them again)">Hide tips</button>
    </div>
    <ul class="editor-tips__list">${rows}</ul>
  `;
  panel.querySelector(".editor-tips__hide")?.addEventListener("click", () => setTips(false));
}
