import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";

import Sortable from "sortablejs";

import { applyBoardTheme, createBoard } from "./board";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { gameDetails, gameTitle, parseGame, splitPgnGames, type ParsedGame } from "./pgnGames";
import { lichessAnalysisUrl } from "./tree";

// A study's Games page (games.html?id=…): games added from PGN, in sections
// the player names and orders, each with a comment, and a board to replay
// them. See doc/studies.html#games.

interface Game {
  id: number;
  section: string;
  pgn: string;
  comment: string;
}

interface GamesData {
  sections: string[];
  games: Game[];
}

interface StudyInfo {
  id: number;
  name: string;
  side: "white" | "black";
}

const NEW_SECTION = "__new__";
const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

async function api(url: string, method = "GET", body?: unknown): Promise<Response> {
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const detail = await res.json().then((b) => b.detail, () => null);
    throw new Error(typeof detail === "string" ? detail : `Request failed (${res.status}).`);
  }
  return res;
}

function render(main: HTMLElement, study: StudyInfo, initial: GamesData): void {
  let data = initial;
  let selectedId: number | null = data.games[0]?.id ?? null;
  let parsed: ParsedGame | null = null;
  let ply = 0;
  let board: Api | null = null;
  let orientation: "white" | "black" = study.side;
  let commentTimer: number | null = null;

  main.innerHTML = `
    <div class="games-page">
      <div class="games-page__header">
        <div>
          <h1 class="page-title">${escapeHtml(study.name)} · Games</h1>
          <p class="games-page__sub">
            <a href="/study.html?id=${study.id}">Edit the study</a> ·
            <a href="/stat.html?id=${study.id}">Stats</a> ·
            <a href="/practice-session.html?id=${study.id}">Practice</a>
          </p>
        </div>
        <button id="add-games-btn" class="btn btn-primary" type="button" aria-expanded="false" aria-controls="add-games">Add games</button>
      </div>
      <form id="add-games" class="games-add" hidden>
        <textarea id="add-games-pgn" rows="8" placeholder="Paste one or more games in PGN" aria-label="Games in PGN" spellcheck="false"></textarea>
        <div class="games-add__row">
          <label>Section
            <select id="add-games-section"></select>
          </label>
          <input id="add-games-new-section" type="text" maxlength="60" placeholder="New section name" aria-label="New section name" hidden />
          <button class="btn btn-primary" type="submit">Add</button>
          <span id="add-games-status" class="games-status" role="status" aria-live="polite"></span>
        </div>
      </form>
      <div class="games-layout">
        <aside class="games-list" id="games-list" aria-label="Games"></aside>
        <section class="games-view" id="games-view" aria-label="Selected game"></section>
      </div>
    </div>
  `;

  const listEl = document.getElementById("games-list") as HTMLElement;
  const viewEl = document.getElementById("games-view") as HTMLElement;
  const addForm = document.getElementById("add-games") as HTMLFormElement;
  const addBtn = document.getElementById("add-games-btn") as HTMLButtonElement;
  const sectionSelect = document.getElementById("add-games-section") as HTMLSelectElement;
  const newSectionInput = document.getElementById("add-games-new-section") as HTMLInputElement;
  const addStatus = document.getElementById("add-games-status") as HTMLElement;

  // ---- Sections and order: every change sends the whole layout.

  function layout(): { name: string; gameIds: number[] }[] {
    return data.sections.map((name) => ({ name, gameIds: data.games.filter((g) => g.section === name).map((g) => g.id) }));
  }

  async function saveLayout(next: { name: string; gameIds: number[] }[]): Promise<void> {
    try {
      const res = await api(`/api/studies/${study.id}/games-layout`, "PUT", { sections: next });
      data = await res.json();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not save the change.");
    }
    renderList();
    renderView();
  }

  function moveItem<T>(items: T[], index: number, delta: number): T[] {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  function renderSectionOptions(): void {
    const preferred = sectionSelect.value;
    sectionSelect.innerHTML =
      data.sections.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("") +
      `<option value="${NEW_SECTION}">New section…</option>`;
    sectionSelect.value = data.sections.includes(preferred) ? preferred : data.sections[0] ?? NEW_SECTION;
    newSectionInput.hidden = sectionSelect.value !== NEW_SECTION;
  }

  const GRIP = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;

  function renderList(): void {
    renderSectionOptions();
    if (!data.sections.length) {
      listEl.innerHTML = `<div class="empty-state profile-empty"><p>No games yet. Add games by pasting their PGN.</p></div>`;
      return;
    }
    listEl.innerHTML =
      layout()
        .map(
          (section, si) => `
        <div class="games-section" data-section-index="${si}">
          <div class="games-section__head">
            <button class="games-grip" type="button" data-grip-section="${si}" title="Drag to reorder (or ↑/↓)" aria-label="Move section ${escapeHtml(section.name)}">${GRIP}</button>
            <h2>${escapeHtml(section.name)}</h2>
            <span class="games-section__count">${section.gameIds.length}</span>
            <span class="games-tools">
              <button type="button" data-section-rename="${si}" title="Rename section" aria-label="Rename section">✎</button>
              ${section.gameIds.length ? "" : `<button type="button" data-section-remove="${si}" title="Remove empty section" aria-label="Remove empty section">×</button>`}
            </span>
          </div>
          <ol class="games-section__list">${section.gameIds
            .map((id) => {
              const game = data.games.find((g) => g.id === id) as Game;
              let headers: Record<string, string> = {};
              try {
                headers = parseGame(game.pgn).headers;
              } catch {
                // Shown as "? – ?"; the viewer reports the problem.
              }
              const details = gameDetails(headers);
              return `
            <li class="games-row${id === selectedId ? " games-row--selected" : ""}" data-game-id="${id}">
              <button class="games-grip" type="button" data-grip-game="${id}" title="Drag to reorder or to another section (or ↑/↓)" aria-label="Move game ${escapeHtml(gameTitle(headers))}">${GRIP}</button>
              <button class="games-row__main" type="button" data-select="${id}" ${id === selectedId ? 'aria-current="true"' : ""}>
                <strong>${escapeHtml(gameTitle(headers))}</strong>
                ${details ? `<span>${escapeHtml(details)}</span>` : ""}
              </button>
            </li>`;
            })
            .join("")}</ol>
          ${section.gameIds.length ? "" : `<p class="games-section__empty">No games in this section. Drag games here.</p>`}
        </div>`,
        )
        .join("") + `<button id="new-section-btn" class="btn btn-secondary btn-small" type="button">New section</button>`;

    listEl.querySelectorAll<HTMLButtonElement>("[data-select]").forEach((btn) =>
      btn.addEventListener("click", () => {
        selectedId = Number(btn.dataset.select);
        ply = 0;
        renderList();
        renderView();
      }),
    );
    const on = (attr: string, handler: (value: string) => void) =>
      listEl.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((btn) =>
        btn.addEventListener("click", () => handler(btn.getAttribute(attr) as string)),
      );
    on("data-section-rename", (v) => {
      const next = layout();
      const name = window.prompt("Section name", next[Number(v)].name)?.trim();
      if (!name || name === next[Number(v)].name) return;
      next[Number(v)] = { ...next[Number(v)], name };
      void saveLayout(next);
    });
    on("data-section-remove", (v) => void saveLayout(layout().filter((_, i) => i !== Number(v))));
    document.getElementById("new-section-btn")?.addEventListener("click", () => {
      const name = window.prompt("Name of the new section")?.trim();
      if (!name) return;
      if (data.sections.includes(name)) {
        window.alert("There is already a section with that name.");
        return;
      }
      void saveLayout([...layout(), { name, gameIds: [] }]);
    });

    listEl.querySelectorAll<HTMLButtonElement>(".games-grip").forEach((grip) => {
      const kind = grip.dataset.gripGame !== undefined ? "game" : "section";
      grip.addEventListener("keydown", (event) => moveWithKeys(event, grip, kind));
    });
    makeSortable();
  }

  // ---- Dragging, with SortableJS: a grip moves its game (within its
  // section or into another, empty ones included) or its section. Sortable
  // rearranges the DOM; it is then read back as the new layout.

  let sortables: Sortable[] = [];

  function layoutFromDom(): { name: string; gameIds: number[] }[] {
    return [...listEl.querySelectorAll<HTMLElement>(".games-section")].map((section) => ({
      name: data.sections[Number(section.dataset.sectionIndex)],
      gameIds: [...section.querySelectorAll<HTMLElement>("[data-game-id]")].map((row) => Number(row.dataset.gameId)),
    }));
  }

  function makeSortable(): void {
    sortables.forEach((sortable) => sortable.destroy());
    const options = {
      animation: 150,
      // Mouse and touch events rather than the browser's own drag and drop:
      // the same behaviour everywhere.
      forceFallback: true,
      ghostClass: "games-ghost",
      onEnd: () => {
        const next = layoutFromDom();
        if (JSON.stringify(next) !== JSON.stringify(layout())) void saveLayout(next);
      },
    };
    sortables = [
      Sortable.create(listEl, { ...options, handle: "[data-grip-section]", draggable: ".games-section" }),
      ...[...listEl.querySelectorAll<HTMLElement>(".games-section__list")].map((list) =>
        Sortable.create(list, { ...options, handle: "[data-grip-game]", group: "games", emptyInsertThreshold: 24 }),
      ),
    ];
  }

  // The same moves from the keyboard: ↑/↓ on a focused grip. A game at the
  // top or bottom of its section moves into the neighbouring section.
  function moveWithKeys(event: KeyboardEvent, grip: HTMLElement, kind: "game" | "section"): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === "ArrowUp" ? -1 : 1;
    const next = layout();
    if (kind === "section") {
      const index = Number(grip.dataset.gripSection);
      if (index + delta < 0 || index + delta >= next.length) return;
      void saveLayout(moveItem(next, index, delta)).then(() =>
        listEl.querySelector<HTMLElement>(`[data-grip-section="${index + delta}"]`)?.focus(),
      );
      return;
    }
    const id = Number(grip.dataset.gripGame);
    const si = next.findIndex((s) => s.gameIds.includes(id));
    const gi = next[si].gameIds.indexOf(id);
    if (gi + delta >= 0 && gi + delta < next[si].gameIds.length) {
      next[si] = { ...next[si], gameIds: moveItem(next[si].gameIds, gi, delta) };
    } else if (si + delta >= 0 && si + delta < next.length) {
      next[si] = { ...next[si], gameIds: next[si].gameIds.filter((g) => g !== id) };
      const target = next[si + delta];
      next[si + delta] = { ...target, gameIds: delta < 0 ? [...target.gameIds, id] : [id, ...target.gameIds] };
    } else {
      return;
    }
    void saveLayout(next).then(() => listEl.querySelector<HTMLElement>(`[data-grip-game="${id}"]`)?.focus());
  }

  // ---- The selected game: board, moves, comment, section, delete.

  function showPly(): void {
    if (!board || !parsed) return;
    const move = ply > 0 ? parsed.moves[ply - 1] : null;
    board.set({
      fen: move ? move.fen : parsed.startFen,
      lastMove: move ? [move.from as Key, move.to as Key] : undefined,
      movable: { color: undefined, dests: new Map() },
    });
    viewEl.querySelectorAll(".games-move--current").forEach((el) => el.classList.remove("games-move--current"));
    const current = viewEl.querySelector<HTMLElement>(`[data-ply="${ply}"]`);
    current?.classList.add("games-move--current");
    current?.scrollIntoView({ block: "nearest" });
    // Lichess analysis at this move: the whole game from the standard start
    // (so it can be stepped through there too), or the position itself.
    (document.getElementById("game-lichess") as HTMLAnchorElement).href =
      parsed.startFen === STANDARD_START
        ? lichessAnalysisUrl(parsed.moves.map((m) => m.san), ply)
        : `https://lichess.org/analysis/standard/${(move ? move.fen : parsed.startFen).replace(/ /g, "_")}`;
    for (const [id, disabled] of [
      ["game-start", ply === 0],
      ["game-back", ply === 0],
      ["game-forward", ply === parsed.moves.length],
      ["game-end", ply === parsed.moves.length],
    ] as const) {
      (document.getElementById(id) as HTMLButtonElement).disabled = disabled;
    }
  }

  function goTo(next: number): void {
    if (!parsed) return;
    ply = Math.max(0, Math.min(parsed.moves.length, next));
    showPly();
  }

  function renderView(): void {
    const game = data.games.find((g) => g.id === selectedId) ?? null;
    board?.destroy();
    board = null;
    parsed = null;
    if (!game) {
      viewEl.innerHTML = data.games.length ? `<p class="games-status">Choose a game.</p>` : "";
      return;
    }
    let error: string | null = null;
    try {
      parsed = parseGame(game.pgn);
    } catch (err) {
      error = err instanceof Error ? err.message : "Unreadable PGN.";
    }
    const headers = parsed?.headers ?? {};
    const details = gameDetails(headers);
    const moveNumber = (i: number) => {
      // The number of the i-th move (0-based) from the game's start position.
      const [, turn, , , , full] = (parsed as ParsedGame).startFen.split(" ");
      const offset = turn === "b" ? 1 : 0;
      return { number: Number(full) + Math.floor((i + offset) / 2), white: (i + offset) % 2 === 0 };
    };
    const movesHtml = parsed
      ? (parsed.startComment ? `<span class="games-comment">${escapeHtml(parsed.startComment)}</span> ` : "") +
        parsed.moves
          .map((m, i) => {
            const { number, white } = moveNumber(i);
            const prefix = white ? `<span class="games-move__number">${number}.</span>` : i === 0 ? `<span class="games-move__number">${number}…</span>` : "";
            return `${prefix}<button class="games-move" type="button" data-ply="${i + 1}">${escapeHtml(m.san)}</button>${
              m.comment ? ` <span class="games-comment">${escapeHtml(m.comment)}</span> ` : ""
            }`;
          })
          .join(" ")
      : "";

    viewEl.innerHTML = `
      <div class="games-view__head">
        <h2>${escapeHtml(gameTitle(headers))}</h2>
        ${details ? `<p class="games-status">${escapeHtml(details)}</p>` : ""}
      </div>
      ${
        error
          ? `<p class="games-error">This game's PGN can't be read: ${escapeHtml(error)}</p>`
          : `<div class="games-play">
             <div class="games-play__board">
             <div class="games-board-wrap"><div id="games-board" class="study-board"></div></div>
             <div class="board-nav" role="group" aria-label="Move navigation">
               <button id="game-start" class="board-nav__btn" type="button" title="Start (↑)" aria-label="Start"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
               <button id="game-back" class="board-nav__btn" type="button" title="Previous move (←)" aria-label="Previous move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17 5v14L6 12z"/></svg></button>
               <button id="game-forward" class="board-nav__btn" type="button" title="Next move (→)" aria-label="Next move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg></button>
               <button id="game-end" class="board-nav__btn" type="button" title="End (↓)" aria-label="End"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
               <button id="game-flip" class="board-nav__btn board-flip-btn" type="button" data-icon="&#xe07b;" title="Flip board (f)" aria-label="Flip board"></button>
               <a id="game-lichess" class="board-nav__btn games-lichess" data-icon="&#xe05f;" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer" title="Open in Lichess analysis at this move" aria-label="Open in Lichess analysis at this move"></a>
             </div>
             </div>
             <div class="games-moves">${movesHtml || `<span class="games-status">No moves.</span>`}</div>
             </div>`
      }
      <label class="games-comment-editor">Your comment
        <textarea id="game-comment" rows="3" maxlength="10000" placeholder="What to remember from this game">${escapeHtml(game.comment)}</textarea>
      </label>
      <div class="games-view__actions">
        <label>Section
          <select id="game-section">${data.sections
            .map((name) => `<option value="${escapeHtml(name)}" ${name === game.section ? "selected" : ""}>${escapeHtml(name)}</option>`)
            .join("")}</select>
        </label>
        <span id="game-comment-status" class="games-status" role="status" aria-live="polite"></span>
        <button id="game-delete" class="btn btn-danger btn-small" type="button">Delete game</button>
      </div>
    `;

    if (parsed) {
      board = createBoard(document.getElementById("games-board") as HTMLElement, () => {}, orientation);
      viewEl.querySelectorAll<HTMLButtonElement>("[data-ply]").forEach((btn) =>
        btn.addEventListener("click", () => goTo(Number(btn.dataset.ply))),
      );
      document.getElementById("game-start")!.addEventListener("click", () => goTo(0));
      document.getElementById("game-back")!.addEventListener("click", () => goTo(ply - 1));
      document.getElementById("game-forward")!.addEventListener("click", () => goTo(ply + 1));
      document.getElementById("game-end")!.addEventListener("click", () => goTo(Infinity));
      document.getElementById("game-flip")!.addEventListener("click", flip);
      showPly();
    }

    const commentEl = document.getElementById("game-comment") as HTMLTextAreaElement;
    const commentStatus = document.getElementById("game-comment-status") as HTMLElement;
    const saveComment = async () => {
      commentTimer = null;
      try {
        await api(`/api/studies/${study.id}/games/${game.id}/comment`, "PUT", { comment: commentEl.value });
        game.comment = commentEl.value;
        commentStatus.textContent = "Saved";
      } catch (err) {
        commentStatus.textContent = err instanceof Error ? err.message : "Could not save the comment.";
      }
    };
    commentEl.addEventListener("input", () => {
      commentStatus.textContent = "";
      if (commentTimer !== null) window.clearTimeout(commentTimer);
      commentTimer = window.setTimeout(() => void saveComment(), 600);
    });
    commentEl.addEventListener("blur", () => {
      if (commentTimer !== null) {
        window.clearTimeout(commentTimer);
        void saveComment();
      }
    });

    document.getElementById("game-section")!.addEventListener("change", (event) => {
      const target = (event.target as HTMLSelectElement).value;
      const next = layout().map((s) => ({ ...s, gameIds: s.gameIds.filter((id) => id !== game.id) }));
      next.find((s) => s.name === target)?.gameIds.push(game.id);
      void saveLayout(next);
    });
    document.getElementById("game-delete")!.addEventListener("click", async () => {
      if (!window.confirm(`Delete ${gameTitle(headers)}? This cannot be undone.`)) return;
      try {
        await api(`/api/studies/${study.id}/games/${game.id}`, "DELETE");
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Could not delete the game.");
        return;
      }
      const index = data.games.findIndex((g) => g.id === game.id);
      data = { ...data, games: data.games.filter((g) => g.id !== game.id) };
      selectedId = data.games[Math.min(index, data.games.length - 1)]?.id ?? null;
      ply = 0;
      renderList();
      renderView();
    });
  }

  function flip(): void {
    orientation = orientation === "white" ? "black" : "white";
    board?.set({ orientation });
  }

  // ---- Adding games from PGN.

  addBtn.addEventListener("click", () => {
    addForm.hidden = !addForm.hidden;
    addBtn.setAttribute("aria-expanded", String(!addForm.hidden));
    if (!addForm.hidden) (document.getElementById("add-games-pgn") as HTMLTextAreaElement).focus();
  });
  sectionSelect.addEventListener("change", () => {
    newSectionInput.hidden = sectionSelect.value !== NEW_SECTION;
    if (!newSectionInput.hidden) newSectionInput.focus();
  });
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const textEl = document.getElementById("add-games-pgn") as HTMLTextAreaElement;
    const section = sectionSelect.value === NEW_SECTION ? newSectionInput.value.trim() : sectionSelect.value;
    addStatus.classList.remove("games-status--error");
    if (!section) {
      addStatus.textContent = "Name the new section.";
      addStatus.classList.add("games-status--error");
      return;
    }
    const pgns = splitPgnGames(textEl.value);
    const valid: string[] = [];
    const problems: string[] = [];
    pgns.forEach((pgn, i) => {
      try {
        parseGame(pgn);
        valid.push(pgn);
      } catch (err) {
        problems.push(`game ${i + 1}: ${err instanceof Error ? err.message : "unreadable"}`);
      }
    });
    if (!valid.length) {
      addStatus.textContent = pgns.length ? `No game could be read (${problems.join("; ")}).` : "Paste some PGN first.";
      addStatus.classList.add("games-status--error");
      return;
    }
    try {
      const res = await api(`/api/studies/${study.id}/games`, "POST", { section, games: valid.map((pgn) => ({ pgn })) });
      const { ids } = await res.json();
      data = await (await api(`/api/studies/${study.id}/games`)).json();
      selectedId = ids[0];
      ply = 0;
      textEl.value = "";
      newSectionInput.value = "";
      sectionSelect.value = section;
      addStatus.textContent =
        `Added ${valid.length} game${valid.length === 1 ? "" : "s"}.` + (problems.length ? ` Skipped ${problems.join("; ")}.` : "");
      if (problems.length) addStatus.classList.add("games-status--error");
      renderList();
      renderView();
    } catch (err) {
      addStatus.textContent = err instanceof Error ? err.message : "Could not add the games.";
      addStatus.classList.add("games-status--error");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (["INPUT", "SELECT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) return;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => goTo(ply - 1),
      ArrowRight: () => goTo(ply + 1),
      ArrowUp: () => goTo(0),
      ArrowDown: () => goTo(Infinity),
      f: flip,
      F: flip,
    };
    if (keys[e.key] && parsed) {
      e.preventDefault();
      keys[e.key]();
    }
  });

  renderList();
  renderView();
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);
  const main = document.getElementById("games-main");
  if (!main) return;
  if (!me.authenticated) {
    main.innerHTML = `<div class="empty-state"><p>Sign in with your Lichess account to see your studies' games.</p><a class="btn btn-primary" href="/auth/login">Sign in</a></div>`;
    return;
  }
  const id = Number(new URLSearchParams(window.location.search).get("id"));
  try {
    const [studyRes, gamesRes] = await Promise.all([
      fetch(`/api/studies/${id}`, { credentials: "same-origin" }),
      fetch(`/api/studies/${id}/games`, { credentials: "same-origin" }),
      applyBoardTheme(),
    ]);
    if (studyRes.status === 404 || !id) {
      main.innerHTML = `<div class="empty-state"><p>Study not found.</p><a class="btn btn-secondary" href="/">Your studies</a></div>`;
      return;
    }
    if (!studyRes.ok || !gamesRes.ok) throw new Error("request failed");
    const study: StudyInfo = await studyRes.json();
    document.title = `${study.name} · Games · lirep.org`;
    render(main, study, await gamesRes.json());
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load the games. Please try again in a moment.</p></div>`;
  }
}

init();
