// The study editor's tips (tips.ts): its buttons, each with its own icon,
// copied from the page so that the tips stay in step with it, and what it
// does. A panel above the board, while tips are on and until "Hide this tip
// now": the editor under it is greyed out, and the page scrolls past it.

import { bindTip, tipFooterHtml } from "./tips";

interface EditorTip {
  /** The controls explained, by id: their icons head the tip. */
  ids: string[];
  html: string;
}

const EDITOR_TIPS: EditorTip[] = [
  {
    ids: [],
    html: "<strong>Play moves on the board</strong> to add them: yours and the replies you expect. Click a move in the list to go back there.",
  },
  {
    ids: [],
    html: "<strong>One move of yours after each opponent's move</strong>: the opponent's replies can branch into as many variations as you like, but where you are to move the study keeps a single answer. Playing another one there leaves the prep: <em>Back to prep</em> returns, <em>Replace prep</em> puts it in place of your move (and what follows).",
  },
  {
    ids: [],
    html: "<strong>The expected score</strong>, next to the first move (<span class=\"tree-move-stat\">Expected score: 53.2%</span>): your average result, a win counting 1 and a draw ½ (the win % plus half the draw %), in the Explorer's games, if you always play your prepared moves and the opponents reply as often as in those games. Where your prep ends, a line counts with the Explorer's results there (or Stockfish's evaluation, as the settings choose). The higher, the better your prep scores.",
  },
  {
    ids: [],
    html: "<strong>The figures after a reply</strong>, e.g. <span class=\"tree-move-stat\">25% · 55.2%</span>: how often the games reach it, and your expected score from there, with the Explorer's settings. The number in brackets after a folded line is how many moves it holds.",
  },
  { ids: ["comment-btn"], html: "A <strong>comment</strong> on the selected position (Enter to finish)." },
  { ids: ["open-lichess-analysis"], html: "Opens the position on <strong>Lichess's analysis board</strong>." },
  {
    ids: ["start-point-btn"],
    html: "Makes the selected move the study's <strong>starting point</strong>: the stats and the practice start there. Click it again to clear it.",
  },
  { ids: ["delete-btn"], html: "<strong>Deletes</strong> the selected move and everything after it (Delete)." },
  { ids: ["keyboard-help-btn"], html: "The <strong>keyboard shortcuts</strong>." },
  {
    ids: ["nav-prev-line", "nav-back", "nav-forward", "nav-next-line"],
    html: "<strong>Step through the moves</strong>: the previous line, the previous move, the next one, the next line (also ↑ ← → ↓; Shift+↑ and Shift+↓ go to the start and to the end of the line).",
  },
  { ids: ["flip-board-btn"], html: "<strong>Flips</strong> the board." },
  { ids: ["focus-btn"], html: "<strong>Focus mode</strong>: only the board, the moves and the tools fill the window (Space or Z)." },
  {
    ids: ["tab-suggest"],
    html: "<strong>Suggests moves</strong> of yours to add, with an optimization algorithm (a greedy one): at each step it looks at the opponent's replies your study leaves unanswered, tries your most played answers to each (sound ones only, if you ask), and adds the one that raises the expected score most; then again, until it has added the number of moves you chose or reached the score you aimed for. <a href=\"/doc/suggested-moves.html\" target=\"_blank\" rel=\"noopener\">How it works</a>.",
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
  // The button as it usually looks: not the start-point button's ✕, shown
  // only when the selected move is the starting point (to clear it).
  const text = [...target.childNodes]
    .filter((node) => !(node instanceof HTMLElement) || !node.matches(".study-start-btn__cross"))
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
  return text ? `<span class="tips-icon tips-icon--text">${text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</span>` : "";
}

/** Fills the editor's tips panel (#editor-tips), and binds its buttons. */
export function renderEditorTips(): void {
  const panel = document.getElementById("editor-tips");
  if (!panel) return;
  const rows = EDITOR_TIPS.map(({ ids, html }) => {
    const icons = ids.map(iconHtml).join("");
    return `<li class="editor-tips__row">${icons ? `<span class="editor-tips__icons">${icons}</span>` : ""}<span>${html}</span></li>`;
  }).join("");
  panel.innerHTML = `
    <h2 class="tips-card__title">Study editor</h2>
    <ul class="editor-tips__list">${rows}</ul>
    ${tipFooterHtml()}
  `;
  bindTip(panel, "editor");
}
