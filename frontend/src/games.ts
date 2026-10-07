import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import Sortable from "sortablejs";

import { applyBoardTheme } from "./board";
import type { ExplorerSettings } from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { gameDetails, gameTitle, parseGame, splitPgnGames, type ParsedGame } from "./pgnGames";
import { createEmptyTree, lichessAnalysisUrl, type StudyTree } from "./tree";
import { renderTreeViewer } from "./treeViewer";

// A study's games (games.html?id=…): cards in sections the player names and
// orders, each with a small board showing the game's final position, which
// replays the game while the pointer is over it. Clicking a card opens the
// game (games.html?id=…&game=…) in the read-only tree viewer, with the
// player's comment on it. See doc/studies.html#games.

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
  explorerSettings: ExplorerSettings;
}

type Layout = { name: string; gameIds: number[] }[];

const NEW_SECTION = "__new__";
const STANDARD_START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
// The replay on hover: a move every PLAYBACK_MS.
const PLAYBACK_MS = 220;

// Where a card opens its game: Lichess (the default) or Lirep's viewer
// (remembered in this browser).
type OpenIn = "lirep" | "lichess";
const OPEN_IN_STORAGE_KEY = "games-open-in";

function getOpenIn(): OpenIn {
  try {
    return localStorage.getItem(OPEN_IN_STORAGE_KEY) === "lirep" ? "lirep" : "lichess";
  } catch {
    return "lichess";
  }
}

function saveOpenIn(value: OpenIn): void {
  try {
    localStorage.setItem(OPEN_IN_STORAGE_KEY, value);
  } catch {
    // The choice just isn't remembered.
  }
}

// A Lichess game link: lichess.org/<8-character id>, possibly followed by
// the 4 extra characters of a player's link, /white or /black, or #move.
const LICHESS_GAME_URL = /^\s*(?:https?:\/\/)?(?:www\.)?lichess\.org\/(?:game\/export\/)?([a-zA-Z0-9]{8})(?:[a-zA-Z0-9]{4})?(?:\/(?:white|black))?\/?(?:[#?]\S*)?\s*$/;

/** A game's PGN from Lichess's public export (no clock times or engine
 * evaluations, which would show up as comments). */
async function fetchLichessGame(id: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://lichess.org/game/export/${id}?clocks=false&evals=false`, {
      headers: { Accept: "application/x-chess-pgn" },
    });
  } catch {
    // Lichess's "not found" answer can't be read from another site, so a
    // missing game looks like a network error here.
    throw new Error(`Lichess game ${id} couldn't be fetched (no such game, or Lichess unreachable)`);
  }
  if (res.status === 404) throw new Error(`Lichess game ${id} not found`);
  if (!res.ok) throw new Error(`Lichess didn't return game ${id} (${res.status})`);
  return (await res.text()).trim();
}

/** Where the game is on Lichess: its own page when it was played there
 * (from the PGN's Site header), otherwise Lichess's analysis board with the
 * moves (or the position, for a game from a custom start). */
function lichessHref(p: ParsedGame, side: "white" | "black"): string {
  const site = p.headers.Site?.match(/^https:\/\/lichess\.org\/([a-zA-Z0-9]{8})$/);
  if (site) return `https://lichess.org/${site[1]}${side === "black" ? "/black" : ""}`;
  if (p.startFen === STANDARD_START) return lichessAnalysisUrl(p.moves.map((m) => m.san), 0);
  return `https://lichess.org/analysis/standard/${p.startFen.replace(/ /g, "_")}`;
}

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

function parsedOrNull(pgn: string): ParsedGame | null {
  try {
    return parseGame(pgn);
  } catch {
    return null;
  }
}

function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items];
  const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// ---- The list of games, as cards.

function renderList(main: HTMLElement, study: StudyInfo, initial: GamesData): void {
  let data = initial;
  const parsed = new Map<number, ParsedGame | null>();
  const parsedGame = (game: Game) => {
    if (!parsed.has(game.id)) parsed.set(game.id, parsedOrNull(game.pgn));
    return parsed.get(game.id) ?? null;
  };

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
        <div class="games-page__actions">
          <div class="source-switch" role="group" aria-label="Open games in">
            <span class="source-switch__label">Open games in</span>
            <button type="button" data-open-in="lirep" aria-pressed="false">Lirep</button>
            <button type="button" data-open-in="lichess" aria-pressed="false">Lichess</button>
          </div>
          <button id="add-games-btn" class="btn btn-primary" type="button" aria-expanded="false" aria-controls="add-games">Add games</button>
        </div>
      </div>
      <form id="add-games" class="games-add" hidden>
        <textarea id="add-games-pgn" rows="8" placeholder="Paste games in PGN, or Lichess game links (one per line)" aria-label="Games in PGN, or Lichess game links" spellcheck="false"></textarea>
        <div class="games-add__row">
          <label>Section
            <select id="add-games-section"></select>
          </label>
          <input id="add-games-new-section" type="text" maxlength="60" placeholder="New section name" aria-label="New section name" hidden />
          <button class="btn btn-primary" type="submit">Add</button>
          <span id="add-games-status" class="games-status" role="status" aria-live="polite"></span>
        </div>
      </form>
      <div id="games-loose" class="games-grid games-grid--loose" aria-label="Games without a section"></div>
      <div id="games-sections" class="games-sections"></div>
    </div>
  `;

  const sectionsEl = document.getElementById("games-sections") as HTMLElement;
  const looseEl = document.getElementById("games-loose") as HTMLElement;
  const pageEl = main.querySelector(".games-page") as HTMLElement;
  const addForm = document.getElementById("add-games") as HTMLFormElement;
  const addBtn = document.getElementById("add-games-btn") as HTMLButtonElement;
  const sectionSelect = document.getElementById("add-games-section") as HTMLSelectElement;
  const newSectionInput = document.getElementById("add-games-new-section") as HTMLInputElement;
  const addStatus = document.getElementById("add-games-status") as HTMLElement;
  let openIn = getOpenIn();

  function applyOpenIn(): void {
    main.querySelectorAll<HTMLButtonElement>("[data-open-in]").forEach((btn) =>
      btn.setAttribute("aria-pressed", String(btn.dataset.openIn === openIn)),
    );
  }
  main.querySelectorAll<HTMLButtonElement>("[data-open-in]").forEach((btn) =>
    btn.addEventListener("click", () => {
      openIn = btn.dataset.openIn as OpenIn;
      saveOpenIn(openIn);
      applyOpenIn();
      render();
    }),
  );
  applyOpenIn();

  // The named sections, in order, with their games; the games without a
  // section (section "") are kept apart, shown above the sections.
  function layout(): Layout {
    return data.sections.map((name) => ({ name, gameIds: data.games.filter((g) => g.section === name).map((g) => g.id) }));
  }

  function looseIds(): number[] {
    return data.games.filter((g) => g.section === "").map((g) => g.id);
  }

  async function saveLayout(next: Layout, loose: number[] = looseIds()): Promise<void> {
    try {
      const res = await api(`/api/studies/${study.id}/games-layout`, "PUT", {
        sections: [{ name: "", gameIds: loose }, ...next],
      });
      data = await res.json();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Could not save the change.");
    }
    render();
  }

  function renderSectionOptions(): void {
    const preferred = sectionSelect.value;
    sectionSelect.innerHTML =
      `<option value="">None</option>` +
      data.sections.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("") +
      `<option value="${NEW_SECTION}">New section…</option>`;
    sectionSelect.value = data.sections.includes(preferred) || preferred === NEW_SECTION ? preferred : "";
    newSectionInput.hidden = sectionSelect.value !== NEW_SECTION;
  }

  const GRIP = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>`;

  function cardHtml(game: Game): string {
    const p = parsedGame(game);
    const headers = p?.headers ?? {};
    const onLichess = openIn === "lichess" && p !== null;
    const href = onLichess ? lichessHref(p, study.side) : `/games.html?id=${study.id}&game=${game.id}`;
    // One player above the board and one below, on their own side of it,
    // each with their rating and score when the PGN has them.
    const known = (v: string | undefined) => (v && !/^\?*$/.test(v) ? v : null);
    const result = known(headers.Result);
    const score = (color: "white" | "black") =>
      result === "1/2-1/2" ? "½" : result === "1-0" ? (color === "white" ? "1" : "0") : result === "0-1" ? (color === "white" ? "0" : "1") : "";
    const player = (color: "white" | "black") => {
      const name = known(color === "white" ? headers.White : headers.Black) ?? "?";
      const elo = known(color === "white" ? headers.WhiteElo : headers.BlackElo);
      return `<span class="games-card__player">
          <span class="games-card__name">${escapeHtml(name)}</span>
          ${elo ? `<span class="games-card__elo">${escapeHtml(elo)}</span>` : ""}
          <span class="games-card__score">${score(color)}</span>
        </span>`;
    };
    const top = study.side === "white" ? "black" : "white";
    const bottom = study.side;
    return `
      <div class="games-card" data-game-id="${game.id}">
        <a class="games-card__link" href="${escapeHtml(href)}" draggable="false"
           ${onLichess ? 'target="_blank" rel="noopener noreferrer"' : ""}
           title="${escapeHtml(gameTitle(headers))}: open${onLichess ? " on Lichess" : ""} (drag to reorder, or Alt+←/→)">
          ${player(top)}
          <div class="games-card__board" data-board="${game.id}"></div>
          ${player(bottom)}
          <span class="games-card__details">${p ? escapeHtml([known(headers.Event), known(headers.Date?.slice(0, 4))].filter(Boolean).join(" · ")) || "&nbsp;" : "Unreadable PGN"}</span>
        </a>
        <button class="games-card__delete" type="button" data-delete-game="${game.id}" title="Delete this game" aria-label="Delete ${escapeHtml(gameTitle(headers))}">×</button>
      </div>`;
  }

  // ---- Small boards: created when a card scrolls into view, final position
  // at rest, the game replayed while the pointer is over the card.
  let boards: Api[] = [];
  let observer: IntersectionObserver | null = null;

  function mountBoard(el: HTMLElement): void {
    const game = data.games.find((g) => g.id === Number(el.dataset.board));
    const p = game ? parsedGame(game) : null;
    if (!game || !p) return;
    const last = p.moves[p.moves.length - 1];
    const finalState = () => ({
      fen: last ? last.fen : p.startFen,
      lastMove: last ? ([last.from, last.to] as Key[]) : undefined,
    });
    const board = Chessground(el, {
      viewOnly: true,
      coordinates: false,
      orientation: study.side,
      animation: { duration: 120 },
      ...finalState(),
    });
    boards.push(board);

    const card = el.closest(".games-card") as HTMLElement;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    card.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || !p.moves.length) return;
      stop();
      let ply = 0;
      board.set({ fen: p.startFen, lastMove: undefined });
      timer = window.setInterval(() => {
        const move = p.moves[ply++];
        board.set({ fen: move.fen, lastMove: [move.from as Key, move.to as Key] });
        if (ply >= p.moves.length) stop();
      }, PLAYBACK_MS);
    });
    card.addEventListener("pointerleave", () => {
      stop();
      board.set(finalState());
    });
  }

  let sortables: Sortable[] = [];
  // After a drop the card is usually under the pointer, and the browser
  // turns the press and release into a click that would open the game:
  // clicks right after a drag are ignored.
  let justDragged = false;
  pageEl.addEventListener(
    "click",
    (event) => {
      if (!justDragged) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  const idsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-game-id]")].map((card) => Number(card.dataset.gameId));

  function layoutFromDom(): Layout {
    return [...sectionsEl.querySelectorAll<HTMLElement>(".games-section")].map((section) => ({
      name: data.sections[Number(section.dataset.sectionIndex)],
      gameIds: idsIn(section),
    }));
  }

  function render(): void {
    renderSectionOptions();
    boards.forEach((b) => b.destroy());
    boards = [];
    observer?.disconnect();
    sortables.forEach((s) => s.destroy());
    sortables = [];

    looseEl.innerHTML = looseIds().map((id) => cardHtml(data.games.find((g) => g.id === id) as Game)).join("");
    if (!data.sections.length && !data.games.length) {
      sectionsEl.innerHTML = `<div class="empty-state profile-empty"><p>No games yet. Add games by pasting their PGN or Lichess links.</p></div>`;
      return;
    }
    sectionsEl.innerHTML =
      layout()
        .map(
          (section, si) => `
        <section class="games-section" data-section-index="${si}">
          <div class="games-section__head">
            <button class="games-grip" type="button" data-grip-section="${si}" title="Drag to reorder (or ↑/↓)" aria-label="Move section ${escapeHtml(section.name)}">${GRIP}</button>
            <h2>${escapeHtml(section.name)}</h2>
            <span class="games-section__count">${section.gameIds.length}</span>
            <span class="games-tools">
              <button type="button" data-section-rename="${si}" title="Rename section" aria-label="Rename section">✎</button>
              ${section.gameIds.length ? "" : `<button type="button" data-section-remove="${si}" title="Remove empty section" aria-label="Remove empty section">×</button>`}
            </span>
          </div>
          <div class="games-grid">${section.gameIds.map((id) => cardHtml(data.games.find((g) => g.id === id) as Game)).join("")}</div>
          ${section.gameIds.length ? "" : `<p class="games-section__empty">No games in this section. Drag games here.</p>`}
        </section>`,
        )
        .join("") + `<button id="new-section-btn" class="btn btn-secondary btn-small" type="button">New section</button>`;

    observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer?.unobserve(entry.target);
          mountBoard(entry.target as HTMLElement);
        }),
      { rootMargin: "200px" },
    );
    pageEl.querySelectorAll<HTMLElement>("[data-board]").forEach((el) => observer!.observe(el));

    const on = (attr: string, handler: (value: string) => void) =>
      pageEl.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((btn) =>
        btn.addEventListener("click", () => handler(btn.getAttribute(attr) as string)),
      );
    on("data-section-rename", (v) => {
      const next = layout();
      const name = window.prompt("Section name", next[Number(v)].name)?.trim();
      if (!name || name === next[Number(v)].name) return;
      if (data.sections.includes(name)) {
        window.alert("There is already a section with that name.");
        return;
      }
      next[Number(v)] = { ...next[Number(v)], name };
      void saveLayout(next);
    });
    on("data-section-remove", (v) => void saveLayout(layout().filter((_, i) => i !== Number(v))));
    on("data-delete-game", async (v) => {
      const game = data.games.find((g) => g.id === Number(v));
      if (!game) return;
      const title = gameTitle(parsedGame(game)?.headers ?? {});
      if (!window.confirm(`Delete ${title}? This cannot be undone.`)) return;
      try {
        await api(`/api/studies/${study.id}/games/${game.id}`, "DELETE");
      } catch (err) {
        window.alert(err instanceof Error ? err.message : "Could not delete the game.");
        return;
      }
      data = { ...data, games: data.games.filter((g) => g.id !== game.id) };
      render();
    });
    document.getElementById("new-section-btn")?.addEventListener("click", () => {
      const name = window.prompt("Name of the new section")?.trim();
      if (!name) return;
      if (data.sections.includes(name)) {
        window.alert("There is already a section with that name.");
        return;
      }
      void saveLayout([...layout(), { name, gameIds: [] }]);
    });

    // Dragging (SortableJS): a card within its section or into another;
    // a section by its grip. A short movement threshold keeps a click a click.
    const options = {
      animation: 150,
      forceFallback: true,
      fallbackTolerance: 5,
      ghostClass: "games-ghost",
      onStart: () => {
        justDragged = true;
        pageEl.classList.add("games-page--dragging");
      },
      onEnd: () => {
        window.setTimeout(() => (justDragged = false), 50);
        pageEl.classList.remove("games-page--dragging");
        const next = layoutFromDom();
        const loose = idsIn(looseEl);
        if (JSON.stringify([loose, next]) !== JSON.stringify([looseIds(), layout()])) void saveLayout(next, loose);
      },
    };
    sortables = [
      Sortable.create(sectionsEl, { ...options, handle: "[data-grip-section]", draggable: ".games-section" }),
      ...[...pageEl.querySelectorAll<HTMLElement>(".games-grid")].map((grid) =>
        Sortable.create(grid, {
          ...options,
          draggable: ".games-card",
          group: "games",
          emptyInsertThreshold: 40,
          // The delete button stays a button, not a drag handle.
          filter: ".games-card__delete",
          preventOnFilter: false,
        }),
      ),
    ];

    // The same from the keyboard: ↑/↓ on a section's grip, Alt+←/→ on a card
    // (a card at the edge of its section moves into the next one).
    sectionsEl.querySelectorAll<HTMLButtonElement>("[data-grip-section]").forEach((grip) =>
      grip.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const index = Number(grip.dataset.gripSection);
        const delta = event.key === "ArrowUp" ? -1 : 1;
        if (index + delta < 0 || index + delta >= data.sections.length) return;
        void saveLayout(moveItem(layout(), index, delta)).then(() =>
          sectionsEl.querySelector<HTMLElement>(`[data-grip-section="${index + delta}"]`)?.focus(),
        );
      }),
    );
    pageEl.querySelectorAll<HTMLElement>(".games-card").forEach((card) =>
      card.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        const id = Number(card.dataset.gameId);
        const delta = event.key === "ArrowLeft" ? -1 : 1;
        // The games without a section count as the first group.
        const next: Layout = [{ name: "", gameIds: looseIds() }, ...layout()];
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
        void saveLayout(next.slice(1), next[0].gameIds).then(() =>
          pageEl.querySelector<HTMLElement>(`[data-game-id="${id}"] a`)?.focus(),
        );
      }),
    );
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
    if (sectionSelect.value === NEW_SECTION && !section) {
      addStatus.textContent = "Name the new section.";
      addStatus.classList.add("games-status--error");
      return;
    }
    // Lichess links (a line each) are fetched; the rest is read as PGN.
    const lines = textEl.value.split(/\r?\n/);
    const ids = lines.map((line) => line.match(LICHESS_GAME_URL)?.[1]).filter((id): id is string => Boolean(id));
    const pgnText = lines.filter((line) => !LICHESS_GAME_URL.test(line)).join("\n");
    const valid: string[] = [];
    const problems: string[] = [];
    for (const [i, id] of ids.entries()) {
      addStatus.textContent = `Fetching game ${i + 1} of ${ids.length} from Lichess…`;
      try {
        const pgn = await fetchLichessGame(id);
        parseGame(pgn);
        valid.push(pgn);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : `Lichess game ${id} unreadable`);
      }
    }
    const pgns = splitPgnGames(pgnText);
    pgns.forEach((pgn, i) => {
      try {
        parseGame(pgn);
        valid.push(pgn);
      } catch (err) {
        problems.push(`game ${i + 1}: ${err instanceof Error ? err.message : "unreadable"}`);
      }
    });
    const pastedCount = ids.length + pgns.length;
    if (!valid.length) {
      addStatus.textContent = pastedCount
        ? `No game could be read (${problems.join("; ")}).`
        : "Paste some PGN or Lichess game links first.";
      addStatus.classList.add("games-status--error");
      return;
    }
    try {
      await api(`/api/studies/${study.id}/games`, "POST", { section, games: valid.map((pgn) => ({ pgn })) });
      data = await (await api(`/api/studies/${study.id}/games`)).json();
      textEl.value = "";
      newSectionInput.value = "";
      sectionSelect.value = section;
      addStatus.textContent =
        `Added ${valid.length} game${valid.length === 1 ? "" : "s"}.` + (problems.length ? ` Skipped ${problems.join("; ")}.` : "");
      if (problems.length) addStatus.classList.add("games-status--error");
      render();
    } catch (err) {
      addStatus.textContent = err instanceof Error ? err.message : "Could not add the games.";
      addStatus.classList.add("games-status--error");
    }
  });

  render();
}

// ---- One game, in the read-only tree viewer: its moves as a single line,
// the PGN's comments on them, and the player's comment on the game.

function gameTree(p: ParsedGame): StudyTree {
  const tree = createEmptyTree();
  let parent = tree.rootId;
  if (p.startComment) tree.nodes[parent].comment = p.startComment;
  for (const move of p.moves) {
    const id = tree.nextId++;
    tree.nodes[id] = { id, san: move.san, parentId: parent, children: [], ...(move.comment ? { comment: move.comment } : {}) };
    tree.nodes[parent].children.push(id);
    parent = id;
  }
  return tree;
}

function renderGame(main: HTMLElement, study: StudyInfo, data: GamesData, game: Game, signedIn: boolean): void {
  const back = `/games.html?id=${study.id}`;
  const p = parsedOrNull(game.pgn);
  const headers = p?.headers ?? {};
  if (!p || p.startFen !== STANDARD_START) {
    main.innerHTML = `
      <div class="empty-state">
        <p>${p ? "This game starts from a custom position, which the game viewer doesn't support yet." : "This game's PGN can't be read."}</p>
        <a class="btn btn-secondary" href="${back}">Back to the games</a>
      </div>`;
    return;
  }
  document.title = `${gameTitle(headers)} · ${study.name} · lirep.org`;

  const links = renderTreeViewer(
    main,
    {
      tree: gameTree(p),
      side: study.side,
      startNodeId: null,
      explorerSettings: study.explorerSettings,
      title: gameTitle(headers),
      bylineHtml: [
        escapeHtml(gameDetails(headers)),
        `<a class="community-owner" href="${back}">${game.section ? `${escapeHtml(game.section)} · ` : ""}${escapeHtml(study.name)}</a>`,
      ]
        .filter(Boolean)
        .join(" · "),
      intro: "Click a move to jump there. The game is read-only; your comment on it is saved as you type.",
      extraCardHtml: `
        <div class="study-card games-comment-card">
          <label class="games-comment-editor">Your comment
            <textarea id="game-comment" rows="3" maxlength="10000" placeholder="What to remember from this game">${escapeHtml(game.comment)}</textarea>
          </label>
          <div class="games-view__actions">
            <label>Section
              <select id="game-section">${["", ...data.sections]
                .map((name) => `<option value="${escapeHtml(name)}" ${name === game.section ? "selected" : ""}>${name ? escapeHtml(name) : "None"}</option>`)
                .join("")}</select>
            </label>
            <span id="game-comment-status" class="games-status" role="status" aria-live="polite"></span>
            <button id="game-delete" class="btn btn-danger btn-small" type="button">Delete game</button>
          </div>
        </div>`,
    },
    signedIn,
  );
  links.innerHTML = `<a class="study-head__link" href="${back}">← All games</a>`;

  const commentEl = document.getElementById("game-comment") as HTMLTextAreaElement;
  const commentStatus = document.getElementById("game-comment-status") as HTMLElement;
  let commentTimer: number | null = null;
  const saveComment = async () => {
    commentTimer = null;
    try {
      await api(`/api/studies/${study.id}/games/${game.id}/comment`, "PUT", { comment: commentEl.value });
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
    if (commentTimer === null) return;
    window.clearTimeout(commentTimer);
    void saveComment();
  });

  document.getElementById("game-section")!.addEventListener("change", async (event) => {
    const target = (event.target as HTMLSelectElement).value;
    const next: Layout = ["", ...data.sections].map((name) => ({
      name,
      gameIds: data.games.filter((g) => g.section === name && g.id !== game.id).map((g) => g.id),
    }));
    next.find((s) => s.name === target)?.gameIds.push(game.id);
    try {
      await api(`/api/studies/${study.id}/games-layout`, "PUT", { sections: next });
      game.section = target;
      commentStatus.textContent = target ? `Moved to ${target}` : "Moved out of its section";
    } catch (err) {
      commentStatus.textContent = err instanceof Error ? err.message : "Could not move the game.";
    }
  });
  document.getElementById("game-delete")!.addEventListener("click", async () => {
    if (!window.confirm(`Delete ${gameTitle(headers)}? This cannot be undone.`)) return;
    try {
      await api(`/api/studies/${study.id}/games/${game.id}`, "DELETE");
      window.location.href = back;
    } catch (err) {
      commentStatus.textContent = err instanceof Error ? err.message : "Could not delete the game.";
    }
  });
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
  const params = new URLSearchParams(window.location.search);
  const id = Number(params.get("id"));
  const gameId = Number(params.get("game"));
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
    const data: GamesData = await gamesRes.json();
    if (gameId) {
      const game = data.games.find((g) => g.id === gameId);
      if (!game) {
        main.innerHTML = `<div class="empty-state"><p>This game doesn't exist (or was deleted).</p><a class="btn btn-secondary" href="/games.html?id=${id}">Back to the games</a></div>`;
        return;
      }
      renderGame(main, study, data, game, me.authenticated);
    } else {
      document.title = `${study.name} · Games · lirep.org`;
      renderList(main, study, data);
    }
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load the games. Please try again in a moment.</p></div>`;
  }
}

init();
