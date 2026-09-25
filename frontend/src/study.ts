import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyLichessBoardTheme, computeDests, createBoard, playMoveSound, toColor } from "./board";
import { Engine, formatScore, RANK_BRUSHES, uciMoveToKeys, type EngineAnalysis } from "./engine";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerUrl,
  fetchExplorerDefaults,
  ratingOptionsHtml,
  renderExplorer,
  renderExplorerError,
  renderExplorerLoading,
  speedCheckboxesHtml,
  type ExplorerData,
  type ExplorerDefaults,
  type ExplorerSettings,
  type ExplorerSpeed,
} from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { addMove, createEmptyTree, deleteSubtree, lastMoveAt, pathTo, positionAt, renderTree, sanPathTo, type StudyTree } from "./tree";

interface StudyStats {
  winProbability: number;
  calculatedAt: string;
  database: "lichess" | "masters";
  minRating: number | null;
  nodesEvaluated: number;
  explorerCalls: number;
}

interface Study {
  id: number;
  name: string;
  tree: StudyTree;
  explorerSettings: ExplorerSettings;
  side: "white" | "black";
  stats: StudyStats | null;
  shared?: boolean;
  // null (the default) means calculations start at the tree's real root —
  // see starting-point.md.
  startNodeId: number | null;
}

function getStudyId(): number | null {
  const id = new URLSearchParams(window.location.search).get("id");
  return id ? Number(id) : null;
}

function getNewStudySide(): "white" | "black" {
  const params = new URLSearchParams(window.location.search);
  return params.get("side") === "black" ? "black" : "white";
}

async function loadStudy(id: number): Promise<Study | null> {
  const res = await fetch(`/api/studies/${id}`, { credentials: "same-origin" });
  return res.ok ? res.json() : null;
}

async function saveStudy(
  id: number | null,
  name: string,
  tree: StudyTree,
  explorerSettings: ExplorerSettings,
  side: "white" | "black",
  startNodeId: number | null,
): Promise<Study | null> {
  const res = await fetch(id ? `/api/studies/${id}` : "/api/studies", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name, tree, explorerSettings, side, startNodeId }),
  });
  return res.ok ? res.json() : null;
}

async function applyBoardTheme(): Promise<void> {
  try {
    const res = await fetch("/api/board-theme", { credentials: "same-origin" });
    if (!res.ok) return;
    const { theme, pieceSet } = await res.json();
    applyLichessBoardTheme(theme, pieceSet);
  } catch {
    // Network error / backend not running: chessground's bundled default look stays.
  }
}

function renderSignedOut(main: HTMLElement): void {
  main.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to create or edit studies.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

// null when there's nothing to say (no starting point set, or it's just the
// real root) — see starting-point.md.
function describeStartPoint(tree: StudyTree, startNodeId: number | null): string | null {
  if (startNodeId === null || startNodeId === tree.rootId) return null;
  const node = tree.nodes[startNodeId];
  if (!node || node.san === null) return null;
  const ply = sanPathTo(tree, startNodeId).length;
  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  return `Starts after ${moveNumber}.${isWhite ? "" : ".."}${node.san}`;
}

// Legend dot colors for the move list, matching the green (best) -> red
// (worst) gradient of the RANK_BRUSHES arrow colors on the board.
const RANK_LEGEND_COLORS = ["#15781B", "#6fae54", "#e68f00", "#b56a5a", "#882020"];

function uciToSan(chess: Chess, uci: string): string {
  const clone = new Chess(chess.fen());
  const move = clone.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  return move ? move.san : uci;
}

function renderEditor(
  main: HTMLElement,
  existing: Study | null,
  explorerDefaults: ExplorerDefaults | null,
  newStudySide: "white" | "black",
): void {
  const ratingBuckets = explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
  // Falls back to a fixed bucket, not DEFAULT_EXPLORER_SETTINGS.minRating
  // (null), even when /api/explorer-defaults failed to load — a null here
  // would silently persist on the first autosave and then make every future
  // Explorer query for this study use explorer.py's own generic 1500-based
  // default forever, regardless of what this fallback actually resolves to.
  const defaultMinRating = explorerDefaults?.defaultMinRating ?? 1400;
  const settings: ExplorerSettings = existing?.explorerSettings ?? {
    ...DEFAULT_EXPLORER_SETTINGS,
    source: explorerDefaults?.defaultSource ?? DEFAULT_EXPLORER_SETTINGS.source,
    // A brand-new study starts pinned to the signed-in player's own rating
    // bracket, resolved once here rather than tracked as a standing "auto"
    // mode — see ratingOptionsHtml.
    minRating: defaultMinRating,
  };
  const allSpeeds = explorerDefaults?.speeds ?? (["bullet", "blitz", "rapid", "classical"] as ExplorerSpeed[]);

  main.innerHTML = `
    <div class="study-editor">
      <div class="study-name-row">
        <input
          id="study-name"
          class="study-name-input"
          type="text"
          placeholder="Name this study"
          value="${existing ? escapeHtml(existing.name) : ""}"
        />
        ${
          existing
            ? `<span class="study-color-badge">${existing.side === "white" ? "Playing White" : "Playing Black"}</span>`
            : `<select id="study-color" class="study-color-select" title="Which side is this repertoire for? This can't be changed after saving.">
                  <option value="white" ${newStudySide === "white" ? "selected" : ""}>Playing White</option>
                  <option value="black" ${newStudySide === "black" ? "selected" : ""}>Playing Black</option>
                </select>`
        }
        <button id="flip-board-btn" class="board-flip-btn" type="button" data-icon="" title="Flip board" aria-label="Flip board"></button>
        <span id="study-start-badge" class="study-start-badge" hidden></span>
      </div>
      <div class="study-grid">
        <div class="study-card study-card--board">
          <div id="board" class="study-board"></div>
        </div>

        <div class="study-card study-card--moves">
          <div id="tree-view" class="tree-view"></div>
          <div class="study-comment-editor">
            <textarea id="study-comment" rows="3" aria-label="Comment on selected position"></textarea>
          </div>
          <p id="move-conflict" class="move-conflict" hidden></p>
          <div class="study-actions">
            <a id="open-lichess-analysis" class="btn btn-secondary study-icon-btn" data-icon="" aria-label="Open position in Lichess analysis" title="Open position in Lichess analysis" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer"></a>
            <button id="start-btn" class="btn btn-secondary" type="button">Go to start</button>
            <button id="delete-btn" class="btn btn-secondary study-icon-btn" type="button" data-icon="" aria-label="Delete this move" title="Delete this move and everything after it (Delete)"></button>
            <button id="start-point-btn" class="btn btn-secondary" type="button">Set as starting point</button>
            <button id="keyboard-help-btn" class="btn btn-secondary study-keyboard-help-btn" type="button" aria-label="Show keyboard shortcuts" aria-expanded="false" aria-controls="keyboard-help">?</button>
          </div>
          <div id="keyboard-help" class="study-keyboard-help" role="region" aria-label="Keyboard shortcuts" tabindex="-1" hidden>
            <p class="study-keyboard-help__title">Keyboard shortcuts</p>
            <p class="study-keyboard-help__intro">Click a move to jump there. Play a different move from any point to start a variation.</p>
            <ul>
              <li><kbd>←</kbd> / <kbd>→</kbd> Previous / next move</li>
              <li><kbd>↑</kbd> / <kbd>↓</kbd> Start / end of line</li>
              <li><kbd>Delete</kbd> Delete selected move and its branches</li>
              <li><kbd>F</kbd> Flip the board</li>
              <li><kbd>?</kbd> Show / hide these shortcuts</li>
            </ul>
          </div>
        </div>

        <div class="study-card study-card--explorer">
          <div class="analysis-header">
            <label class="explorer-toggle">
              <input type="checkbox" id="explorer-enabled" aria-label="Opening Explorer" ${settings.enabled ? "checked" : ""} />
              <span class="analysis-label" data-icon="" aria-hidden="true">Opening Explorer</span>
            </label>
            <div class="analysis-header__settings">
              <select id="explorer-source" aria-label="Explorer data source" ${settings.enabled ? "" : "disabled"}>
                <option value="lirep" ${settings.source === "lirep" ? "selected" : ""} ${explorerDefaults?.lirepAvailable ? "" : "disabled"}>Lirep</option>
                <option value="lichess" ${settings.source === "lichess" ? "selected" : ""}>Lichess</option>
              </select>
              <select id="explorer-database" aria-label="Lichess database" ${settings.enabled && settings.source === "lichess" ? "" : "disabled"}>
                <option value="lichess" ${settings.database === "lichess" ? "selected" : ""}>Players</option>
                <option value="masters" ${settings.database === "masters" ? "selected" : ""} ${settings.source === "lirep" ? "disabled" : ""}>Masters</option>
                <option value="player" ${settings.database === "player" ? "selected" : ""}>Player</option>
              </select>
              <input id="explorer-player" class="explorer-player" type="text" placeholder="Lichess username"
                aria-label="Player whose games to show" value="${escapeHtml(settings.player ?? "")}"
                ${settings.enabled && settings.database === "player" ? "" : "hidden"} />
              <select
                id="explorer-min-rating"
                ${settings.enabled && settings.database === "lichess" ? "" : "disabled"}
              >
                ${ratingOptionsHtml(ratingBuckets, settings.minRating, defaultMinRating)}
              </select>
            </div>
          </div>
          <div class="speed-checkboxes" id="explorer-speeds">
            ${speedCheckboxesHtml(allSpeeds, settings.speeds, !settings.enabled || settings.database === "masters")}
          </div>
          <div id="explorer-panel" class="explorer-panel" ${settings.enabled ? "" : "hidden"}></div>
        </div>

        <div class="study-card study-card--engine">
          <div class="analysis-header">
            <label class="explorer-toggle">
              <input type="checkbox" id="engine-enabled" aria-label="Stockfish" />
              <span class="analysis-label" data-icon="" aria-hidden="true">Stockfish</span>
            </label>
            <span id="engine-status" class="engine-eval"></span>
          </div>
          <div id="engine-panel" class="engine-panel" hidden></div>
        </div>
      </div>

        <div class="study-footer">
          <p id="study-save-status" class="study-save-status" role="status" aria-live="polite">
            ${existing ? "Changes save automatically." : "Name this study to start auto-saving."}
          </p>
          <label id="study-share" class="study-share" ${existing ? "" : "hidden"}
            title="Shared studies appear on the Community page (name, your username, expected score), and other people can import a copy. Studies are shared by default; untick to keep this one private.">
            <input type="checkbox" id="study-shared" ${existing?.shared ? "checked" : ""} />
            Share with the community
          </label>
          <button id="delete-study-btn" class="btn btn-danger" type="button" ${existing ? "" : "hidden"}>Delete study</button>
        </div>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const treeViewEl = document.getElementById("tree-view") as HTMLElement;
  const commentInputEl = document.getElementById("study-comment") as HTMLTextAreaElement;
  const keyboardHelpButton = document.getElementById("keyboard-help-btn") as HTMLButtonElement;
  const keyboardHelpPanel = document.getElementById("keyboard-help") as HTMLElement;
  const explorerPanelEl = document.getElementById("explorer-panel") as HTMLElement;
  const explorerEnabledEl = document.getElementById("explorer-enabled") as HTMLInputElement;
  const explorerSourceEl = document.getElementById("explorer-source") as HTMLSelectElement;
  const explorerDatabaseEl = document.getElementById("explorer-database") as HTMLSelectElement;
  const explorerPlayerEl = document.getElementById("explorer-player") as HTMLInputElement;
  const explorerMinRatingEl = document.getElementById("explorer-min-rating") as HTMLSelectElement;
  const explorerSpeedsEl = document.getElementById("explorer-speeds") as HTMLElement;
  const engineEnabledEl = document.getElementById("engine-enabled") as HTMLInputElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const nameInput = document.getElementById("study-name") as HTMLInputElement;
  const colorSelect = document.getElementById("study-color") as HTMLSelectElement | null;
  const saveStatusEl = document.getElementById("study-save-status") as HTMLElement;
  const deleteStudyBtn = document.getElementById("delete-study-btn") as HTMLButtonElement;
  const shareWrapEl = document.getElementById("study-share") as HTMLElement;
  const sharedInput = document.getElementById("study-shared") as HTMLInputElement;
  const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;
  const flipBoardBtn = document.getElementById("flip-board-btn") as HTMLButtonElement;
  const moveConflictEl = document.getElementById("move-conflict") as HTMLElement;
  const lichessAnalysisLink = document.getElementById("open-lichess-analysis") as HTMLAnchorElement;

  const tree: StudyTree = existing?.tree ?? createEmptyTree();
  let studyId = existing?.id ?? null;
  let savedName = existing?.name ?? "";
  let saveTimer: number | null = null;
  let saveInProgress = false;
  let saveAgain = false;
  let deleting = false;
  let editVersion = 0;
  let savedVersion = 0;
  let navigating = false;
  let currentId = tree.rootId;
  // null means "no override — calculations start at the tree's real root",
  // the default. See starting-point.md.
  let startNodeId: number | null = existing?.startNodeId ?? null;
  let board: Api;
  let explorerRequestId = 0;
  let engine: Engine | null = null;
  let engineAnalysisId = 0;
  let boardOrientation = currentSide();
  let boardOrientationManuallySet = false;

  // Remembers, per node, which child was last navigated into from it — so
  // arrow-key "forward"/"end of line" continue along whichever branch you're
  // currently viewing (e.g. a variation you clicked into) rather than always
  // jumping back to the tree's main line, matching Lichess's own behavior.
  const lastChild: Record<number, number> = {};

  function currentSide(): "white" | "black" {
    return colorSelect ? (colorSelect.value as "white" | "black") : (existing?.side ?? "white");
  }

  function updateCommentEditor(): void {
    const node = tree.nodes[currentId];
    commentInputEl.value = node.comment ?? "";
  }

  function setSaveStatus(message: string, failed = false): void {
    saveStatusEl.textContent = message;
    saveStatusEl.classList.toggle("study-save-status--error", failed);
  }

  /** A blocked-navigation attempt (clicking a nav link with no name set yet —
   * see the click interceptor below) is otherwise only visible via the small,
   * neutral-colored status line, easy to miss entirely. This draws the eye
   * straight to the field that actually needs filling in. */
  function flagMissingName(): void {
    setSaveStatus("Enter a name before leaving this page.", true);
    nameInput.classList.remove("study-name-input--attention");
    // Force a reflow so re-triggering the animation on a second blocked
    // click (while the class never actually left, e.g. two rapid clicks)
    // restarts it instead of being a no-op.
    void nameInput.offsetWidth;
    nameInput.classList.add("study-name-input--attention");
    nameInput.focus();
  }

  function scheduleAutoSave(delay = 250): void {
    if (deleting) return;
    editVersion++;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    if (!nameInput.value.trim()) {
      setSaveStatus(
        studyId === null
          ? "Enter a name to start auto-saving."
          : "A name is required; other edits will save with the current name.",
      );
      if (studyId === null) return;
    }
    if (nameInput.value.trim()) {
      nameInput.classList.remove("study-name-input--attention");
      setSaveStatus("Unsaved changes…");
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void persistStudy();
    }, delay);
  }

  async function persistStudy(): Promise<void> {
    if (deleting) return;
    if (saveInProgress) {
      saveAgain = true;
      return;
    }
    const name = nameInput.value.trim() || savedName;
    if (!name) {
      setSaveStatus("Enter a name to start auto-saving.");
      return;
    }

    saveInProgress = true;
    saveAgain = false;
    const savingVersion = editVersion;
    const creating = studyId === null;
    setSaveStatus("Saving…");
    try {
      const saved = await saveStudy(studyId, name, tree, settings, currentSide(), startNodeId);
      if (!saved) throw new Error("Save failed");

      studyId = saved.id;
      savedName = saved.name;
      savedVersion = savingVersion;
      if (creating) {
        const url = new URL(window.location.href);
        url.searchParams.set("id", String(saved.id));
        url.searchParams.delete("side");
        window.history.replaceState(null, "", url);
        if (colorSelect) {
          colorSelect.value = saved.side;
          if (!boardOrientationManuallySet) {
            boardOrientation = saved.side;
            board.set({ orientation: boardOrientation });
          }
          colorSelect.disabled = true;
          colorSelect.title = "The playing side is fixed once the study is created.";
        }
        deleteStudyBtn.hidden = false;
        shareWrapEl.hidden = false;
        sharedInput.checked = saved.shared ?? true;
      }
      if (!deleting) {
        if (!nameInput.value.trim()) {
          setSaveStatus("Saved with the current name; enter a name to rename this study.");
        } else {
          setSaveStatus(editVersion === savingVersion && !saveAgain ? "All changes saved." : "Saving latest changes…");
        }
      }
    } catch {
      if (!deleting) setSaveStatus("Could not save. Your edits are still here; change something or reconnect to retry.", true);
    } finally {
      saveInProgress = false;
      if (saveAgain) {
        saveAgain = false;
        if (!deleting) {
          if (saveTimer !== null) window.clearTimeout(saveTimer);
          saveTimer = null;
          void persistStudy();
        }
      }
    }
  }

  async function deleteStudy(): Promise<void> {
    if (studyId === null || !window.confirm(`Delete "${savedName}"? This cannot be undone.`)) return;
    deleting = true;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = null;
    saveAgain = false;
    deleteStudyBtn.disabled = true;
    setSaveStatus("Deleting study…");

    while (saveInProgress) await new Promise((resolve) => window.setTimeout(resolve, 20));

    try {
      const res = await fetch(`/api/studies/${studyId}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error("Delete failed");
      window.location.href = "/";
    } catch {
      deleting = false;
      deleteStudyBtn.disabled = false;
      setSaveStatus("Could not delete the study. Please try again.", true);
      scheduleAutoSave(0);
    }
  }

  // Enforces "only one reply for the studied side at any position" (the
  // opponent can still branch freely). Returns the SAN of the move already
  // recorded there if `san` would violate that, or null if the move is fine
  // (a fresh position, the opponent's move, or replaying the existing move).
  function conflictingMove(nodeId: number, san: string, moveColor: "w" | "b"): string | null {
    const isStudiedSide = (moveColor === "w") === (currentSide() === "white");
    if (!isStudiedSide) return null;
    const node = tree.nodes[nodeId];
    if (node.children.length === 0) return null;
    if (node.children.some((childId) => tree.nodes[childId].san === san)) return null;
    return tree.nodes[node.children[0]].san;
  }

  function reportConflict(existingSan: string): void {
    moveConflictEl.textContent = `You already have a move here (${existingSan}). Delete it first to replace it.`;
    moveConflictEl.hidden = false;
  }

  function playSan(san: string): void {
    const chess = positionAt(tree, currentId);
    const move = chess.move(san);
    if (!move) return;
    const conflict = conflictingMove(currentId, move.san, move.color);
    if (conflict) {
      goTo(currentId);
      reportConflict(conflict);
      return;
    }
    playMoveSound(move, chess);
    goTo(addMove(tree, currentId, move.san));
    scheduleAutoSave();
  }

  function onMove(orig: Key, dest: Key): void {
    const chess = positionAt(tree, currentId);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    const conflict = conflictingMove(currentId, move.san, move.color);
    if (conflict) {
      goTo(currentId); // snap the piece back — chessground already moved it visually
      reportConflict(conflict);
      return;
    }
    playMoveSound(move, chess);
    goTo(addMove(tree, currentId, move.san));
    scheduleAutoSave();
  }

  async function updateExplorer(fen: string): Promise<void> {
    if (!settings.enabled) {
      explorerPanelEl.hidden = true;
      return;
    }
    explorerPanelEl.hidden = false;

    const requestId = ++explorerRequestId;
    renderExplorerLoading(explorerPanelEl);
    try {
      const res = await fetch(explorerUrl(fen, settings, currentSide()), { credentials: "same-origin" });
      if (requestId !== explorerRequestId) return;
      if (!res.ok) {
        renderExplorerError(explorerPanelEl);
        return;
      }
      const data: ExplorerData = await res.json();
      if (requestId !== explorerRequestId) return;
      renderExplorer(explorerPanelEl, data, playSan);
    } catch {
      if (requestId === explorerRequestId) renderExplorerError(explorerPanelEl);
    }
  }

  function playUci(uci: string): void {
    const chess = positionAt(tree, currentId);
    const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
    if (!move) return;
    const conflict = conflictingMove(currentId, move.san, move.color);
    if (conflict) {
      goTo(currentId);
      reportConflict(conflict);
      return;
    }
    playMoveSound(move, chess);
    goTo(addMove(tree, currentId, move.san));
    scheduleAutoSave();
  }

  async function updateEngine(chess: Chess): Promise<void> {
    const analysisId = ++engineAnalysisId;
    if (!engineEnabledEl.checked) return;

    if (chess.isGameOver()) {
      board.set({ drawable: { autoShapes: [] } });
      engineStatusEl.textContent = "Game over";
      enginePanelEl.hidden = true;
      return;
    }

    if (!engine) engine = new Engine();
    engineStatusEl.textContent = "Thinking…";
    const analysis: EngineAnalysis = await engine.analyze(chess.fen());
    if (analysisId !== engineAnalysisId || !engineEnabledEl.checked) return;
    const sideToMoveIsWhite = chess.turn() === "w";

    board.set({
      drawable: {
        autoShapes: analysis.lines.map((line, i) => {
          const { orig, dest } = uciMoveToKeys(line.move);
          return { orig: orig as Key, dest: dest as Key, brush: RANK_BRUSHES[i] ?? "red" };
        }),
      },
    });

    engineStatusEl.textContent = `depth ${analysis.depth}`;
    enginePanelEl.hidden = analysis.lines.length === 0;
    enginePanelEl.innerHTML = analysis.lines
      .map((line, i) => {
        const san = uciToSan(chess, line.move);
        const score = formatScore(line, sideToMoveIsWhite);
        const color = RANK_LEGEND_COLORS[i] ?? "#888";
        return `
          <button class="engine-line" type="button" data-move="${escapeHtml(line.move)}">
            <span class="engine-line__dot" style="background:${color}"></span>
            <span class="engine-line__san">${escapeHtml(san)}</span>
            <span class="engine-line__score">${escapeHtml(score)}</span>
          </button>
        `;
      })
      .join("");

    enginePanelEl.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((btn) => {
      btn.addEventListener("click", () => playUci(btn.dataset.move as string));
    });
  }

  function renderTreeView(): void {
    treeViewEl.innerHTML = renderTree(tree, currentId, currentSide(), startNodeId);
    treeViewEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
      el.addEventListener("click", () => goTo(Number(el.dataset.nodeId)));
    });

    const activeMove = treeViewEl.querySelector<HTMLElement>(".tree-move--current");
    if (activeMove) {
      const viewRect = treeViewEl.getBoundingClientRect();
      const moveRect = activeMove.getBoundingClientRect();
      if (moveRect.top < viewRect.top || moveRect.bottom > viewRect.bottom) {
        treeViewEl.scrollTop += moveRect.top - viewRect.top - 12;
      }
    }
  }

  // Keeps the name-row badge and the "Set/Clear starting point" button's
  // label in sync with `startNodeId` and wherever you're currently viewing —
  // called after navigation and after toggling the starting point itself.
  function updateStartPointUI(): void {
    const badge = document.getElementById("study-start-badge") as HTMLElement;
    const description = describeStartPoint(tree, startNodeId);
    badge.hidden = description === null;
    badge.textContent = description ?? "";

    const btn = document.getElementById("start-point-btn") as HTMLButtonElement;
    btn.textContent = currentId === startNodeId && startNodeId !== null ? "Clear starting point" : "Set as starting point";
    btn.disabled = currentId === tree.rootId && startNodeId === null;
  }

  function goTo(nodeId: number): void {
    moveConflictEl.hidden = true;

    // Record the path taken so arrow-key navigation can follow it later.
    const path = pathTo(tree, nodeId);
    for (let i = 0; i < path.length - 1; i++) {
      lastChild[path[i].id] = path[i + 1].id;
    }

    currentId = nodeId;
    const chess = positionAt(tree, currentId);
    updateCommentEditor();
    const line = sanPathTo(tree, currentId);
    let lineEnd = currentId;
    let next = lastChild[lineEnd] ?? tree.nodes[lineEnd].children[0];
    while (next !== undefined) {
      line.push(tree.nodes[next].san as string);
      lineEnd = next;
      next = lastChild[lineEnd] ?? tree.nodes[lineEnd].children[0];
    }
    lichessAnalysisLink.href = line.length
      ? `https://lichess.org/analysis/pgn/${line.map(encodeURIComponent).join("_")}`
      : "https://lichess.org/analysis";
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      lastMove: lastMoveAt(tree, currentId),
      movable: { color: toColor(chess), dests: computeDests(chess) },
    });

    renderTreeView();
    deleteBtn.disabled = currentId === tree.rootId;
    updateStartPointUI();
    void updateExplorer(chess.fen());
    void updateEngine(chess);
  }

  function stepBack(): void {
    const parentId = tree.nodes[currentId].parentId;
    if (parentId !== null) goTo(parentId);
  }

  function stepForward(): void {
    const node = tree.nodes[currentId];
    const next = lastChild[currentId] ?? node.children[0];
    if (next !== undefined) goTo(next);
  }

  function goToLineEnd(): void {
    let nodeId = currentId;
    let next = lastChild[nodeId] ?? tree.nodes[nodeId].children[0];
    while (next !== undefined) {
      nodeId = next;
      next = lastChild[nodeId] ?? tree.nodes[nodeId].children[0];
    }
    if (nodeId !== currentId) goTo(nodeId);
  }

  // Resolves to the starting point when one is set (falling back to the
  // real root if it's somehow gone — same degrade-gracefully rule the
  // backend's stats calculations use, see starting-point.md) — used both to
  // open the editor and for "Go to start" / Up, so that action means
  // "back to where prep begins" rather than always the very first move.
  function goToStart(): void {
    goTo(startNodeId !== null && startNodeId in tree.nodes ? startNodeId : tree.rootId);
  }

  board = createBoard(boardEl, onMove, boardOrientation);
  flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  goToStart();

  function flipBoard(): void {
    boardOrientation = boardOrientation === "white" ? "black" : "white";
    boardOrientationManuallySet = true;
    board.set({ orientation: boardOrientation });
    flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  }

  function deleteCurrentMove(): void {
    if (currentId === tree.rootId) return;
    const parentId = tree.nodes[currentId].parentId as number;
    deleteSubtree(tree, currentId);
    for (const [id, childId] of Object.entries(lastChild)) {
      if (!tree.nodes[Number(id)]?.children.includes(childId)) delete lastChild[Number(id)];
    }
    // The starting point may have lived inside the subtree just removed —
    // rather than pointing at a node that no longer exists, fall back to the
    // default (the real root). See starting-point.md.
    if (startNodeId !== null && !(startNodeId in tree.nodes)) startNodeId = null;
    goTo(parentId);
    scheduleAutoSave();
  }

  flipBoardBtn.addEventListener("click", flipBoard);

  document.getElementById("start-btn")?.addEventListener("click", goToStart);

  deleteBtn.addEventListener("click", deleteCurrentMove);

  document.getElementById("start-point-btn")?.addEventListener("click", () => {
    startNodeId = currentId === startNodeId ? null : currentId;
    renderTreeView();
    updateStartPointUI();
    scheduleAutoSave(0);
  });

  deleteStudyBtn.addEventListener("click", () => void deleteStudy());
  sharedInput.addEventListener("change", async () => {
    if (studyId === null) return;
    const wanted = sharedInput.checked;
    sharedInput.disabled = true;
    try {
      const res = await fetch(`/api/studies/${studyId}/shared`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared: wanted }),
      });
      if (!res.ok) throw new Error("share failed");
      setSaveStatus(
        wanted
          ? "Shared with the community (it is ranked once its stats are calculated with Lichess's Explorer)."
          : "No longer shared.",
      );
    } catch {
      sharedInput.checked = !wanted;
      setSaveStatus("Could not change sharing. Please try again.", true);
    } finally {
      sharedInput.disabled = false;
    }
  });

  function closeKeyboardHelp(restoreFocus = false): void {
    keyboardHelpPanel.hidden = true;
    keyboardHelpButton.setAttribute("aria-expanded", "false");
    keyboardHelpButton.setAttribute("aria-label", "Show keyboard shortcuts");
    if (restoreFocus) keyboardHelpButton.focus();
  }

  function toggleKeyboardHelp(): void {
    if (!keyboardHelpPanel.hidden) {
      closeKeyboardHelp(true);
      return;
    }
    keyboardHelpPanel.hidden = !keyboardHelpPanel.hidden;
    keyboardHelpButton.setAttribute("aria-expanded", String(!keyboardHelpPanel.hidden));
    keyboardHelpButton.setAttribute("aria-label", keyboardHelpPanel.hidden ? "Show keyboard shortcuts" : "Hide keyboard shortcuts");
    if (!keyboardHelpPanel.hidden) keyboardHelpPanel.focus();
  }

  keyboardHelpButton.addEventListener("click", toggleKeyboardHelp);

  document.addEventListener("click", (event) => {
    if (
      !keyboardHelpPanel.hidden &&
      event.target instanceof Node &&
      !keyboardHelpPanel.contains(event.target) &&
      event.target !== keyboardHelpButton
    ) {
      closeKeyboardHelp();
    }
  });

  colorSelect?.addEventListener("change", () => {
    renderTreeView();
    if (!boardOrientationManuallySet) {
      boardOrientation = currentSide();
      board.set({ orientation: boardOrientation });
    }
    scheduleAutoSave();
  });

  nameInput.addEventListener("input", () => scheduleAutoSave(500));
  window.addEventListener("online", () => scheduleAutoSave(0));

  commentInputEl.addEventListener("input", () => {
    const node = tree.nodes[currentId];
    if (commentInputEl.value.trim()) node.comment = commentInputEl.value;
    else delete node.comment;

    const selectedMove = treeViewEl.querySelector<HTMLElement>(`[data-node-id="${currentId}"]`);
    const marker = selectedMove?.querySelector<HTMLElement>(".tree-move-comment-marker");
    if (marker) {
      marker.hidden = !node.comment;
      marker.title = node.comment ? "Has a comment" : "";
    }
    scheduleAutoSave(500);
  });

  commentInputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    commentInputEl.blur();
  });
  commentInputEl.addEventListener("blur", () => scheduleAutoSave(0));

  window.addEventListener("beforeunload", (event) => {
    if (deleting || (editVersion === savedVersion && !saveInProgress)) return;
    event.preventDefault();
    event.returnValue = "";
  });

  document.addEventListener("click", async (event) => {
    if (!(event.target instanceof Element) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!link || link.target === "_blank" || link.hasAttribute("download") || (editVersion === savedVersion && !saveInProgress)) return;
    event.preventDefault();
    if (navigating || deleting) return;
    navigating = true;
    try {
      while (editVersion !== savedVersion || saveInProgress) {
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = null;
        if (saveInProgress) {
          await new Promise((resolve) => window.setTimeout(resolve, 20));
          continue;
        }
        const previousVersion = savedVersion;
        await persistStudy();
        if (savedVersion === previousVersion && !saveInProgress) {
          if (!nameInput.value.trim()) flagMissingName();
          return;
        }
      }
      window.location.href = link.href;
    } finally {
      navigating = false;
    }
  }, true);

  // Lichess-style keyboard navigation: Left/Right step through the line
  // you're currently viewing, Up jumps to the start, Down to its end,
  // Delete/Backspace removes the selected move (same as lichess's own study
  // editor), f flips the board.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && !keyboardHelpPanel.hidden) {
      e.preventDefault();
      closeKeyboardHelp(true);
      return;
    }
    const target = e.target as HTMLElement;
    const navigatingFromEngineToggle = target === engineEnabledEl && e.key.startsWith("Arrow");
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) && !navigatingFromEngineToggle) return;

    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        stepBack();
        break;
      case "ArrowRight":
        e.preventDefault();
        stepForward();
        break;
      case "ArrowUp":
        e.preventDefault();
        goToStart();
        break;
      case "ArrowDown":
        e.preventDefault();
        goToLineEnd();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        deleteCurrentMove();
        break;
      case "f":
      case "F":
        e.preventDefault();
        flipBoard();
        break;
      case "?":
        e.preventDefault();
        toggleKeyboardHelp();
        break;
    }
  });

  function updateExplorerControls(): void {
    const playerSelected = settings.database === "player";
    explorerSourceEl.disabled = !settings.enabled;
    explorerSourceEl.querySelector<HTMLOptionElement>('option[value="lirep"]')!.disabled =
      playerSelected || !explorerDefaults?.lirepAvailable;
    explorerDatabaseEl.disabled = !settings.enabled || (settings.source === "lirep" && !playerSelected);
    explorerDatabaseEl.querySelector<HTMLOptionElement>('option[value="masters"]')!.disabled = settings.source === "lirep";
    explorerMinRatingEl.disabled = !(settings.enabled && settings.database === "lichess");
    explorerPlayerEl.hidden = !(settings.enabled && playerSelected);
    explorerSpeedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = !settings.enabled || settings.database === "masters";
    });
  }

  explorerEnabledEl.addEventListener("change", () => {
    settings.enabled = explorerEnabledEl.checked;
    updateExplorerControls();
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  explorerSourceEl.addEventListener("change", () => {
    settings.source = explorerSourceEl.value as ExplorerSettings["source"];
    if (settings.source === "lirep" && settings.database === "masters") {
      settings.database = "lichess";
      explorerDatabaseEl.value = "lichess";
    }
    updateExplorerControls();
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  explorerDatabaseEl.addEventListener("change", () => {
    settings.database = explorerDatabaseEl.value as ExplorerSettings["database"];
    if (settings.database === "player") {
      // One player's games exist only on Lichess; default to the signed-in user.
      settings.source = "lichess";
      explorerSourceEl.value = "lichess";
      if (!settings.player) {
        void fetchMe().then((me) => {
          if (me.username && !settings.player && settings.database === "player") {
            settings.player = me.username;
            explorerPlayerEl.value = me.username;
            void updateExplorer(positionAt(tree, currentId).fen());
            scheduleAutoSave();
          }
        });
      }
    }
    updateExplorerControls();
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  explorerPlayerEl.addEventListener("change", () => {
    settings.player = explorerPlayerEl.value.trim() || null;
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  explorerMinRatingEl.addEventListener("change", () => {
    settings.minRating = Number(explorerMinRatingEl.value);
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  explorerSpeedsEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.type !== "checkbox") return;
    const speed = target.value as ExplorerSpeed;
    if (!target.checked && settings.speeds.length === 1 && settings.speeds[0] === speed) {
      target.checked = true; // always keep at least one speed selected
      return;
    }
    settings.speeds = target.checked ? [...settings.speeds, speed] : settings.speeds.filter((s) => s !== speed);
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  engineEnabledEl.addEventListener("change", () => {
    if (engineEnabledEl.checked) {
      void updateEngine(positionAt(tree, currentId));
    } else {
      engineAnalysisId++;
      board.set({ drawable: { autoShapes: [] } });
      engineStatusEl.textContent = "";
      enginePanelEl.hidden = true;
      enginePanelEl.innerHTML = "";
      engine?.terminate();
      engine = null;
    }
  });

}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("study-main");
  if (!main) return;

  if (!me.authenticated) {
    renderSignedOut(main);
    return;
  }

  const studyId = getStudyId();
  const [existing, , explorerDefaults] = await Promise.all([
    studyId ? loadStudy(studyId) : Promise.resolve(null),
    applyBoardTheme(),
    fetchExplorerDefaults(),
  ]);
  if (studyId && !existing) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  renderEditor(main, existing, explorerDefaults, getNewStudySide());
}

init();
