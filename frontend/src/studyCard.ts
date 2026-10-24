import Sortable from "sortablejs";
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
  return openingLineHtml(sanPathTo(study.tree, startId), study.side);
}

/** The moves to a study's starting point, a full move per line, the
 * studied side's in its colour. */
export function openingLineHtml(sans: string[], side: "white" | "black"): string {
  if (sans.length === 0) return '<span class="study-card__start">Starting position</span>';

  const rows: string[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    const fullMove = Math.floor(i / 2) + 1;
    const whiteMove = `<span class="tree-move ${side === "white" ? "tree-move--mine" : ""}">${escapeHtml(sans[i])}</span>`;
    const blackMove = sans[i + 1]
      ? `<span class="tree-move ${side === "black" ? "tree-move--mine" : ""}">${escapeHtml(sans[i + 1])}</span>`
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

/** A study tree's size: its moves, and its lines (the moves that end one). */
export function countMovesAndLines(tree: StudyTree): { moves: number; lines: number } {
  const nodes = Object.values(tree.nodes);
  return {
    moves: nodes.length - 1,
    lines: nodes.filter((node) => node.id !== tree.rootId && node.children.length === 0).length,
  };
}

const EXPECTED_SCORE_TITLE =
  "Expected score: win % + half of the draw % (a win counts 1, a draw 0.5), from real games in the Explorer, if you always play your prepared moves.";
const EXPECTED_EVAL_TITLE =
  "Expected evaluation: Stockfish's average evaluation at the end of your prep, in pawns for your side, with opponents replying as in the Explorer.";

// Pawns for the studied side, with forced mates (capped near 100,000 cp)
// spelled out, as on the Stats page.
export function formatEval(cp: number): string {
  if (Math.abs(cp) > 99_000) return cp > 0 ? "Forced mate" : "Forced mate against";
  return `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;
}

/** "Expected result: 57.4% / +0.31", a dash for what isn't calculated yet;
 * on a leaderboard, the value it ranks by in bold. */
function expectedResultHtml(
  stats: { winProbability?: number | null; evalCp?: number | null },
  ranked?: "score" | "eval",
): string {
  const score = stats.winProbability ?? undefined;
  const evalCp = stats.evalCp ?? undefined;
  // Not calculated yet: a grey dash.
  const value = (text: string | undefined, title: string, isRanked: boolean) => {
    const variant = text === undefined
      ? " study-card__result--missing"
      : ranked === undefined ? "" : isRanked ? " study-card__result--ranked" : " study-card__result--unranked";
    return `<span class="study-card__result${variant}" title="${escapeHtml(title)}">${text ?? "—"}</span>`;
  };
  return `<div class="study-card__score"><span>Expected result</span><span class="study-card__results">${value(
    score === undefined ? undefined : `${(score * 100).toFixed(1)}%`,
    EXPECTED_SCORE_TITLE,
    ranked === "score",
  )}<span class="study-card__results-sep">/</span>${value(
    evalCp === undefined ? undefined : formatEval(evalCp),
    EXPECTED_EVAL_TITLE,
    ranked === "eval",
  )}</span></div>`;
}

/** A card's body, the same on the home page and the leaderboards: the
 * header (`titleHtml`, then `headerEnd` at its right), the expected result,
 * the tree's size and the opening line. */
export function studyCardBodyHtml(card: {
  titleHtml: string;
  /** The title as plain text, for its tooltip when it's cut. */
  titleText: string;
  headerEnd: string;
  stats: { winProbability?: number | null; evalCp?: number | null };
  /** On a leaderboard: the value it ranks by. */
  ranked?: "score" | "eval";
  moves: number;
  lines: number;
  /** The tree's size in a section of its own under the opening line (the
   * home page), rather than under the expected result (the leaderboards). */
  sizeBelowLine?: boolean;
  /** After the size: the study's games, as a link to its Games page. */
  games?: { count: number; href: string };
  startLine: string[];
  side: "white" | "black";
}): string {
  const size = `${card.moves} ${card.moves === 1 ? "move" : "moves"} · ${card.lines} ${card.lines === 1 ? "line" : "lines"}`
    + (card.games?.count
      ? ` · <a class="study-card__games" href="${card.games.href}" title="Open the Games page">${card.games.count} ${card.games.count === 1 ? "game" : "games"}</a>`
      : "");
  return `
    <div class="study-card__header">
      <h3 title="${escapeHtml(card.titleText)}"><span class="study-card__title-text">${card.titleHtml}</span></h3>
      ${card.headerEnd}
    </div>
    ${expectedResultHtml(card.stats, card.ranked)}
    ${card.sizeBelowLine ? "" : `<p class="study-card__meta">${size}</p>`}
    <div class="study-card__line">${openingLineHtml(card.startLine, card.side)}</div>
    ${card.sizeBelowLine ? `<p class="study-card__meta study-card__section">${size}</p>` : ""}
  `;
}

function renderStudyCardContent(study: StudyCardData, headerEnd: string): string {
  const startId = study.startNodeId !== null && study.tree.nodes[study.startNodeId] ? study.startNodeId : study.tree.rootId;
  return studyCardBodyHtml({
    titleHtml: escapeHtml(study.name),
    titleText: study.name,
    headerEnd,
    stats: study.stats ?? {},
    ...countMovesAndLines(study.tree),
    sizeBelowLine: true,
    games: study.gameCount ? { count: study.gameCount, href: `/games.html?id=${study.id}` } : undefined,
    startLine: sanPathTo(study.tree, startId),
    side: study.side,
  });
}

/** A card's title stays on one line, cut with an ellipsis when too long;
 * hovering the card scrolls it to show the end, and leaving it scrolls
 * back. Bound once per page, on `root`, for every card in it. */
export function bindTitleScroll(root: HTMLElement): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const titleOf = (event: MouseEvent): HTMLElement | null => {
    const card = (event.target as Element).closest(".study-card");
    // Moves within the card don't count as entering or leaving it.
    if (!card || card.contains(event.relatedTarget as Node | null)) return null;
    return card.querySelector<HTMLElement>(".study-card__title-text");
  };
  root.addEventListener("mouseover", (event) => {
    const text = titleOf(event);
    if (!text) return;
    const overflow = text.scrollWidth - text.clientWidth;
    if (overflow <= 0) return;
    // About 40 pixels a second, so long names don't rush past.
    text.style.setProperty("--title-shift", `${-overflow - 4}px`);
    text.style.setProperty("--title-time", `${Math.max(0.6, overflow / 40)}s`);
    text.classList.add("study-card__title-text--scrolled");
  });
  root.addEventListener("mouseout", (event) => {
    titleOf(event)?.classList.remove("study-card__title-text--scrolled");
  });
}

// The study's badge, as on its Stats page, at the top right of the card:
// the piece of its expected evaluation (the pawn when not calculated yet),
// in its tier's colour (grey when not calculated yet). With `statsId`, it
// links to that study's Stats page.
export function studyBadgeHtml(
  stats: { winProbability?: number | null; evalCp?: number | null },
  side: "white" | "black",
  statsId?: number,
): string {
  const score = stats.winProbability ?? undefined;
  const evalCp = stats.evalCp ?? undefined;
  const tier = scoreTier(score, side);
  const piece = evalPiece(evalCp);
  const scoreText = score === undefined
    ? "expected score not calculated yet"
    : `${TIER_LABELS[tier]} · expected score ${(score * 100).toFixed(1)}%`;
  const evalText = evalCp === undefined
    ? "expected evaluation not calculated yet"
    : `${PIECE_LABELS[piece]} · expected evaluation ${evalCp >= 0 ? "+" : "−"}${Math.abs(evalCp / 100).toFixed(2)}`;
  const badge = pieceBadgeHtml(tier, "sm", piece);
  if (statsId === undefined) {
    const title = `${scoreText}; ${evalText}`;
    return `<span class="study-card__trophy" title="${title}" aria-label="${title}">${badge}</span>`;
  }
  const title = `${scoreText}; ${evalText} — click to see the stats`;
  return `<a class="study-card__trophy" href="/stat.html?id=${statsId}" title="${title}" aria-label="${title}">${badge}</a>`;
}

/** A home-page card. An archived study's card has Restore in place of
 * Practice, and the bin; an active one's, the archive box. */
export function renderStudyCardWithActions(study: StudyCardData): string {
  return `
    <article class="study-card study-card--summary${study.archived ? " study-card--archived" : ""}" data-study-id="${study.id}">
      ${renderStudyCardContent(study, `<span class="study-card__header-end">${studyBadgeHtml(study.stats ?? {}, study.side, study.id)}</span>`)}
      <div class="study-card__actions">
        <a class="btn btn-secondary" href="/study.html?id=${study.id}">Edit</a>
        ${
          study.archived
            ? `<button class="btn btn-secondary" type="button" data-restore-study="${study.id}" title="Back to your openings">Restore</button>`
            : `<span class="btn-split">
                <a class="btn btn-secondary btn-split__main" href="/practice-session.html?id=${study.id}">Practice</a>
                <a class="btn btn-secondary btn-split__side" href="/practice-session.html?id=${study.id}&amp;mode=bullet" title="Bullet: your preparation against the clock" aria-label="Bullet practice on ${escapeHtml(study.name)}"><span data-icon="&#xe032;" aria-hidden="true"></span></a>
              </span>`
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

/** Lets the home page's cards be dragged to reorder them, within their
 * grid (a side, or the archive), as the games on a study's Games page.
 * Returns the function that sets it up again after each render; the order
 * is saved for all the owner's studies (see store.set_study_order). */
export function bindStudyReorder(root: HTMLElement, studies: StudyCardData[], rerender: () => void): () => void {
  // After a drop the card is usually under the pointer, and the browser
  // turns the press and release into a click on whatever is there (Edit,
  // Practice…): clicks right after a drag are ignored.
  let justDragged = false;
  root.addEventListener(
    "click",
    (event) => {
      if (!justDragged) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  async function save(): Promise<void> {
    // The cards' order on the page, then the studies not shown (the archive
    // while hidden) in their order.
    const shown = [...root.querySelectorAll<HTMLElement>("[data-study-id]")].map((card) => Number(card.dataset.studyId));
    const byId = new Map(studies.map((study) => [study.id, study]));
    const previous = [...studies];
    const next = [
      ...shown.map((id) => byId.get(id)).filter((study): study is StudyCardData => study !== undefined),
      ...studies.filter((study) => !shown.includes(study.id)),
    ];
    if (next.every((study, i) => study === previous[i])) return;
    studies.splice(0, studies.length, ...next);
    try {
      const res = await fetch("/api/studies/order", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: next.map((study) => study.id) }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      studies.splice(0, studies.length, ...previous);
      rerender();
      window.alert("Could not save the new order. Please try again.");
    }
  }

  let sortables: Sortable[] = [];
  return () => {
    sortables.forEach((sortable) => sortable.destroy());
    sortables = [...root.querySelectorAll<HTMLElement>(".studies-grid")].map((grid) => {
      grid.classList.add("studies-grid--sortable");
      return Sortable.create(grid, {
        animation: 150,
        // A short movement threshold keeps a click a click.
        forceFallback: true,
        fallbackTolerance: 5,
        ghostClass: "studies-ghost",
        draggable: "[data-study-id]",
        // The copy's name, while duplicating, stays a text field.
        filter: "input",
        preventOnFilter: false,
        // The New study card stays last.
        onMove: (event) => !(event.related.classList.contains("study-card--new") && event.willInsertAfter),
        onStart: () => {
          justDragged = true;
        },
        onEnd: () => {
          window.setTimeout(() => (justDragged = false), 50);
          void save();
        },
      });
    });
  };
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
