import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyLichessBoardTheme, computeDests, createBoard, playMoveSound, toColor } from "./board";
import { Engine, formatScore, RANK_BRUSHES, uciMoveToKeys, whiteGaugeShare, type EngineAnalysis } from "./engine";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerSummary,
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
import { addMove, createEmptyTree, deleteSubtree, lastMoveAt, lichessAnalysisUrl, pathTo, positionAt, renderTree, sanPathTo, type StudyTree } from "./tree";

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

type Tool = "explorer" | "engine";
const TOOLS_STORAGE_KEY = "study-tools";

// Which of the Explorer and Stockfish are on, remembered in this browser;
// neither by default, so the move tree has the whole column.
function getSavedTools(): Set<Tool> {
  try {
    const saved = localStorage.getItem(TOOLS_STORAGE_KEY);
    if (saved === null) return new Set();
    return new Set(saved.split(",").filter((t): t is Tool => t === "explorer" || t === "engine"));
  } catch {
    return new Set();
  }
}

function saveTools(tools: Set<Tool>): void {
  try {
    localStorage.setItem(TOOLS_STORAGE_KEY, [...tools].join(","));
  } catch {
    // The choice just isn't remembered.
  }
}

function sidePawn(side: "white" | "black"): HTMLElement {
  const pawn = document.createElement("span");
  pawn.className = `side-pawn side-pawn--${side} study-head__side`;
  pawn.title = pawn.ariaLabel = side === "white" ? "Playing White" : "Playing Black";
  pawn.textContent = side === "white" ? "♙" : "♟";
  return pawn;
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

  // Sized so that, scrolled to the bottom, the board fills the screen height.
  main.classList.add("site-main--board");
  main.innerHTML = `
    <div class="study-editor study-editor--edit">
      <header class="study-head">
        <div class="study-head__title">
          ${
            existing
              ? `<span class="side-pawn side-pawn--${existing.side} study-head__side" title="${existing.side === "white" ? "Playing White" : "Playing Black"}" aria-label="${existing.side === "white" ? "Playing White" : "Playing Black"}">${existing.side === "white" ? "♙" : "♟"}</span>`
              : `<select id="study-color" class="study-color-select" aria-label="Side" title="Which side is this repertoire for? This can't be changed after saving.">
                    <option value="white" ${newStudySide === "white" ? "selected" : ""}>Playing White</option>
                    <option value="black" ${newStudySide === "black" ? "selected" : ""}>Playing Black</option>
                  </select>`
          }
          <h1 id="study-title" class="study-title" title="Rename" ${existing ? "" : "hidden"}>${existing ? escapeHtml(existing.name) : ""}</h1>
          <button id="rename-btn" class="study-rename-btn" type="button" aria-label="Rename study" title="Rename" ${existing ? "" : "hidden"}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <input
            id="study-name"
            class="study-name-input"
            type="text"
            placeholder="Name this study"
            aria-label="Study name"
            value="${existing ? escapeHtml(existing.name) : ""}"
            ${existing ? "hidden" : ""}
          />
          <button id="study-start-badge" class="study-start-badge" type="button" title="Go to the starting point" hidden></button>
          <span id="study-save-status" class="study-save-status" role="status" aria-live="polite">
            ${existing ? "Saved" : "Name this study to start auto-saving."}
          </span>
        </div>
        <div class="study-head__links" id="study-links" ${existing ? "" : "hidden"}>
          <a class="study-head__link" id="study-stats-link" href="/stat.html?id=${existing?.id ?? ""}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/></svg>Stats</a>
          <a class="study-head__link" id="study-practice-link" href="/practice-session.html?id=${existing?.id ?? ""}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>Practice</a>
          <details class="study-menu" id="study-menu">
            <summary class="btn btn-secondary" aria-label="More study options">⋯</summary>
            <div class="study-menu__panel">
              <label class="study-share">
                <input type="checkbox" id="study-shared" ${existing?.shared ? "checked" : ""} />
                Share with the community
              </label>
              <p class="study-menu__note">Shared studies appear on the Community page, and other people can import a copy.</p>
              <button id="delete-study-btn" class="btn btn-danger" type="button">Delete study</button>
            </div>
          </details>
        </div>
      </header>

      <div class="study-grid">
        <div class="study-board-col">
          <div class="study-card study-card--board">
            <div id="board" class="study-board"></div>
            <div id="eval-gauge" class="eval-gauge" role="img" aria-label="Evaluation" hidden>
              <div id="eval-gauge-black" class="eval-gauge__black"></div>
            </div>
          </div>
          <div class="board-nav" role="group" aria-label="Move navigation">
            <button id="nav-start" class="board-nav__btn" type="button" title="Go to start (↑)" aria-label="Go to start"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
            <button id="nav-back" class="board-nav__btn" type="button" title="Previous move (←)" aria-label="Previous move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17 5v14L6 12z"/></svg></button>
            <button id="nav-forward" class="board-nav__btn" type="button" title="Next move (→)" aria-label="Next move"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5v14l11-7z"/></svg></button>
            <button id="nav-end" class="board-nav__btn" type="button" title="End of line (↓)" aria-label="End of line"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
            <button id="flip-board-btn" class="board-nav__btn board-flip-btn" type="button" data-icon="&#xe07b;" title="Flip board" aria-label="Flip board"></button>
          </div>
        </div>

        <div class="study-side-col">
          <div class="study-side-col__inner">
            <div class="study-card study-card--moves">
              <div class="study-actions">
                <button id="delete-btn" class="btn btn-secondary study-icon-btn" type="button" data-icon="&#xe04f;" aria-label="Delete this move" title="Delete this move and everything after it (Delete)"></button>
                <button id="start-point-btn" class="btn btn-secondary btn-small" type="button">Set as starting point</button>
                <button id="comment-btn" class="btn btn-secondary btn-small" type="button" aria-expanded="false" aria-controls="comment-editor">Comment</button>
                <a id="open-lichess-analysis" class="btn btn-secondary study-icon-btn" data-icon="&#xe05f;" aria-label="Open position in Lichess analysis" title="Open position in Lichess analysis" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer"></a>
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
              <div id="tree-view" class="tree-view"></div>
              <p id="move-conflict" class="move-conflict" hidden></p>
              <div class="study-comment-editor" id="comment-editor" hidden>
                <textarea id="study-comment" rows="2" placeholder="Comment on this position" aria-label="Comment on selected position"></textarea>
              </div>
            </div>

            <div class="study-card study-card--tools">

              <div id="tool-engine" class="tool-panel tool-panel--engine" hidden>
                <div id="engine-panel" class="engine-chips"></div>
              </div>

              <div id="tool-explorer" class="tool-panel tool-panel--explorer">
                <div class="explorer-settings-line">
                  <span id="explorer-summary"></span>
                  <button id="explorer-settings-btn" class="btn btn-secondary btn-small" type="button" aria-expanded="false" aria-controls="explorer-settings">Change</button>
                </div>
                <div id="explorer-settings" class="explorer-settings" hidden>
                  <div class="analysis-header__settings">
                    <select id="explorer-source" aria-label="Explorer data source">
                      <option value="lirep" ${settings.source === "lirep" ? "selected" : ""} ${explorerDefaults?.lirepAvailable ? "" : "disabled"}>Lirep</option>
                      <option value="lichess" ${settings.source === "lichess" ? "selected" : ""}>Lichess</option>
                    </select>
                    <select id="explorer-database" aria-label="Lichess database" ${settings.source === "lichess" ? "" : "disabled"}>
                      <option value="lichess" ${settings.database === "lichess" ? "selected" : ""}>Players</option>
                      <option value="masters" ${settings.database === "masters" ? "selected" : ""} ${settings.source === "lirep" ? "disabled" : ""}>Masters</option>
                      <option value="player" ${settings.database === "player" ? "selected" : ""}>Player</option>
                    </select>
                    <input id="explorer-player" class="explorer-player" type="text" placeholder="Lichess username"
                      aria-label="Player whose games to show" value="${escapeHtml(settings.player ?? "")}"
                      ${settings.database === "player" ? "" : "hidden"} />
                    <select id="explorer-min-rating" aria-label="Minimum rating" ${settings.database === "lichess" ? "" : "disabled"}>
                      ${ratingOptionsHtml(ratingBuckets, settings.minRating, defaultMinRating)}
                    </select>
                  </div>
                  <div class="speed-checkboxes" id="explorer-speeds">
                    ${speedCheckboxesHtml(allSpeeds, settings.speeds, settings.database === "masters")}
                  </div>
                  <p class="explorer-settings__note">These settings are also the ones this study's stats are calculated with.</p>
                </div>
                <div id="explorer-panel" class="explorer-panel"></div>
              </div>

              <div class="tool-tabs" role="group" aria-label="Analysis tools">
                <button id="tab-engine" class="tool-tab" type="button" aria-pressed="false" aria-controls="tool-engine">
                  <span class="analysis-label" data-icon="&#xe05f;" aria-hidden="true"></span>Stockfish
                </button>
                <button id="tab-explorer" class="tool-tab" type="button" aria-pressed="false" aria-controls="tool-explorer">
                  <span class="analysis-label" data-icon="&#xe03b;" aria-hidden="true"></span>Opening Explorer
                </button>
                <span id="engine-status" class="engine-eval tool-tabs__status" title="Stockfish runs in this browser"></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const treeViewEl = document.getElementById("tree-view") as HTMLElement;
  const commentInputEl = document.getElementById("study-comment") as HTMLTextAreaElement;
  const keyboardHelpButton = document.getElementById("keyboard-help-btn") as HTMLButtonElement;
  const keyboardHelpPanel = document.getElementById("keyboard-help") as HTMLElement;
  const explorerPanelEl = document.getElementById("explorer-panel") as HTMLElement;
  const explorerSourceEl = document.getElementById("explorer-source") as HTMLSelectElement;
  const explorerDatabaseEl = document.getElementById("explorer-database") as HTMLSelectElement;
  const explorerPlayerEl = document.getElementById("explorer-player") as HTMLInputElement;
  const explorerMinRatingEl = document.getElementById("explorer-min-rating") as HTMLSelectElement;
  const explorerSpeedsEl = document.getElementById("explorer-speeds") as HTMLElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const nameInput = document.getElementById("study-name") as HTMLInputElement;
  const titleEl = document.getElementById("study-title") as HTMLElement;
  const renameBtn = document.getElementById("rename-btn") as HTMLButtonElement;
  const colorSelect = document.getElementById("study-color") as HTMLSelectElement | null;
  const saveStatusEl = document.getElementById("study-save-status") as HTMLElement;
  const deleteStudyBtn = document.getElementById("delete-study-btn") as HTMLButtonElement;
  const sharedInput = document.getElementById("study-shared") as HTMLInputElement;
  const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;
  const flipBoardBtn = document.getElementById("flip-board-btn") as HTMLButtonElement;
  const moveConflictEl = document.getElementById("move-conflict") as HTMLElement;
  const lichessAnalysisLink = document.getElementById("open-lichess-analysis") as HTMLAnchorElement;
  const navStartBtn = document.getElementById("nav-start") as HTMLButtonElement;
  const gaugeEl = document.getElementById("eval-gauge") as HTMLElement;
  const gaugeBlackEl = document.getElementById("eval-gauge-black") as HTMLElement;
  const navBackBtn = document.getElementById("nav-back") as HTMLButtonElement;
  const navForwardBtn = document.getElementById("nav-forward") as HTMLButtonElement;
  const navEndBtn = document.getElementById("nav-end") as HTMLButtonElement;
  const studyLinksEl = document.getElementById("study-links") as HTMLElement;
  const studyMenuEl = document.getElementById("study-menu") as HTMLDetailsElement;
  const commentBtn = document.getElementById("comment-btn") as HTMLButtonElement;
  const commentEditorEl = document.getElementById("comment-editor") as HTMLElement;
  const explorerSummaryEl = document.getElementById("explorer-summary") as HTMLElement;
  const explorerSettingsBtn = document.getElementById("explorer-settings-btn") as HTMLButtonElement;
  const explorerSettingsEl = document.getElementById("explorer-settings") as HTMLElement;
  const tabButtons = {
    explorer: document.getElementById("tab-explorer") as HTMLButtonElement,
    engine: document.getElementById("tab-engine") as HTMLButtonElement,
  };
  const tabPanels = {
    explorer: document.getElementById("tool-explorer") as HTMLElement,
    engine: document.getElementById("tool-engine") as HTMLElement,
  };

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
  // The Explorer and Stockfish can each be on or off; only those on run.
  const shownTools: Set<Tool> = getSavedTools();
  // The comment box opens for a position that has a comment, or when asked.
  let commentRequested = false;

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
    const open = commentRequested || Boolean(node.comment?.trim());
    commentEditorEl.hidden = !open;
    commentBtn.setAttribute("aria-expanded", String(open));
    commentBtn.classList.toggle("btn--active", open);
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
      setSaveStatus("Unsaved changes");
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
    // Once the study exists, its name changes only when a rename is
    // committed (see finishRename), not with every keystroke in the field.
    const name = (studyId === null ? nameInput.value.trim() : titleEl.textContent?.trim()) || savedName;
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
            syncGaugeOrientation();
          }
          colorSelect.replaceWith(sidePawn(saved.side));
        }
        studyLinksEl.hidden = false;
        titleEl.textContent = saved.name;
        if (document.activeElement !== nameInput) showTitle();
        (document.getElementById("study-stats-link") as HTMLAnchorElement).href = `/stat.html?id=${saved.id}`;
        (document.getElementById("study-practice-link") as HTMLAnchorElement).href = `/practice-session.html?id=${saved.id}`;
        sharedInput.checked = saved.shared ?? true;
      }
      if (!deleting) {
        if (!nameInput.value.trim()) {
          setSaveStatus("Saved with the current name; enter a name to rename this study.");
        } else {
          setSaveStatus(editVersion === savingVersion && !saveAgain ? "Saved" : "Saving…");
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
    if (!shownTools.has("explorer")) return;
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
      const chess = positionAt(tree, currentId);
      renderExplorer(explorerPanelEl, data, playSan, {
        inTree: new Set(tree.nodes[currentId].children.map((id) => tree.nodes[id].san as string)),
        yourTurn: (chess.turn() === "w") === (currentSide() === "white"),
      });
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

  // Lichess's evaluation gauge, beside the board while Stockfish is on:
  // White's share fills from White's side of the board, so it flips with it.
  function setGauge(whiteShare: number): void {
    gaugeBlackEl.style.height = `${(1 - whiteShare) * 100}%`;
    gaugeEl.setAttribute("aria-label", `Evaluation: White ${Math.round(whiteShare * 100)}%`);
  }

  function syncGaugeOrientation(): void {
    gaugeEl.classList.toggle("eval-gauge--flipped", boardOrientation === "black");
  }

  async function updateEngine(chess: Chess): Promise<void> {
    const analysisId = ++engineAnalysisId;
    if (!shownTools.has("engine")) return;

    if (chess.isGameOver()) {
      board.set({ drawable: { autoShapes: [] } });
      setGauge(chess.isCheckmate() ? (chess.turn() === "w" ? 0 : 1) : 0.5);
      engineStatusEl.textContent = "Game over";
      enginePanelEl.innerHTML = "";
      return;
    }

    if (!engine) engine = new Engine();
    engineStatusEl.textContent = "Thinking…";
    const analysis: EngineAnalysis = await engine.analyze(chess.fen());
    if (analysisId !== engineAnalysisId || !shownTools.has("engine")) return;
    const sideToMoveIsWhite = chess.turn() === "w";
    setGauge(whiteGaugeShare(analysis.lines[0], sideToMoveIsWhite));

    board.set({
      drawable: {
        autoShapes: analysis.lines.map((line, i) => {
          const { orig, dest } = uciMoveToKeys(line.move);
          return { orig: orig as Key, dest: dest as Key, brush: RANK_BRUSHES[i] ?? "red" };
        }),
      },
    });

    engineStatusEl.textContent = `depth ${analysis.depth}`;
    // One compact row: each candidate as a chip, best first, in its arrow's colour.
    enginePanelEl.innerHTML = analysis.lines
      .map((line, i) => {
        const san = uciToSan(chess, line.move);
        const score = formatScore(line, sideToMoveIsWhite);
        const color = RANK_LEGEND_COLORS[i] ?? "#888";
        return `<button class="engine-chip" type="button" data-move="${escapeHtml(line.move)}" title="Play ${escapeHtml(san)}">
            <span class="engine-chip__dot" style="background:${color}"></span><strong>${escapeHtml(san)}</strong> ${escapeHtml(score)}
          </button>`;
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

    if (nodeId !== currentId) commentRequested = false;
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
    // The whole line, so it can be stepped through on Lichess, opened at the
    // current move.
    lichessAnalysisLink.href = lichessAnalysisUrl(line, sanPathTo(tree, currentId).length);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      lastMove: lastMoveAt(tree, currentId),
      movable: { color: toColor(chess), dests: computeDests(chess) },
    });

    renderTreeView();
    deleteBtn.disabled = currentId === tree.rootId;
    navBackBtn.disabled = navStartBtn.disabled = currentId === tree.rootId;
    navForwardBtn.disabled = navEndBtn.disabled = tree.nodes[currentId].children.length === 0;
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

  function applyToolsUI(): void {
    for (const name of ["explorer", "engine"] as const) {
      tabButtons[name].setAttribute("aria-pressed", String(shownTools.has(name)));
      tabPanels[name].hidden = !shownTools.has(name);
    }
    gaugeEl.hidden = !shownTools.has("engine");
    // The tools card takes only the room its open tools need; the tree has the rest.
    const toolsCard = document.querySelector(".study-card--tools");
    toolsCard?.classList.toggle("study-card--tools-both", shownTools.size === 2);
    toolsCard?.classList.toggle("study-card--tools-explorer", shownTools.has("explorer"));
    toolsCard?.classList.toggle("study-card--tools-none", shownTools.size === 0);
  }

  function toggleTool(tool: Tool): void {
    if (shownTools.has(tool)) shownTools.delete(tool);
    else shownTools.add(tool);
    saveTools(shownTools);
    applyToolsUI();
    const on = shownTools.has(tool);
    if (tool === "engine") {
      if (on) {
        void updateEngine(positionAt(tree, currentId));
      } else {
        // Stockfish stops when turned off: it is the expensive one.
        engineAnalysisId++;
        board.set({ drawable: { autoShapes: [] } });
        engineStatusEl.textContent = "";
        enginePanelEl.innerHTML = "";
        setGauge(0.5);
        engine?.terminate();
        engine = null;
      }
    } else if (on) {
      void updateExplorer(positionAt(tree, currentId).fen());
    } else {
      explorerRequestId++; // drop a response still on its way
      explorerPanelEl.innerHTML = "";
    }
  }

  tabButtons.explorer.addEventListener("click", () => toggleTool("explorer"));
  tabButtons.engine.addEventListener("click", () => toggleTool("engine"));

  function updateExplorerSummary(): void {
    explorerSummaryEl.textContent = explorerSummary(settings);
  }
  updateExplorerSummary();

  explorerSettingsBtn.addEventListener("click", () => {
    explorerSettingsEl.hidden = !explorerSettingsEl.hidden;
    explorerSettingsBtn.setAttribute("aria-expanded", String(!explorerSettingsEl.hidden));
    explorerSettingsBtn.textContent = explorerSettingsEl.hidden ? "Change" : "Done";
  });

  board = createBoard(boardEl, onMove, boardOrientation);
  syncGaugeOrientation();
  applyToolsUI();
  flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  goToStart();

  function flipBoard(): void {
    boardOrientation = boardOrientation === "white" ? "black" : "white";
    boardOrientationManuallySet = true;
    board.set({ orientation: boardOrientation });
    syncGaugeOrientation();
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

  navStartBtn.addEventListener("click", goToStart);
  navBackBtn.addEventListener("click", stepBack);
  navForwardBtn.addEventListener("click", stepForward);
  navEndBtn.addEventListener("click", goToLineEnd);

  commentBtn.addEventListener("click", () => {
    const open = commentEditorEl.hidden;
    if (!open && tree.nodes[currentId].comment?.trim()) {
      commentInputEl.focus(); // a comment is there: the box stays open
      return;
    }
    commentRequested = open;
    updateCommentEditor();
    if (open) commentInputEl.focus();
  });

  // The "⋯" menu closes on any click outside it, like a native menu.
  document.addEventListener("click", (event) => {
    if (studyMenuEl.open && event.target instanceof Node && !studyMenuEl.contains(event.target)) studyMenuEl.open = false;
  });

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
        wanted ? "Shared with the community" : "No longer shared",
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
      syncGaugeOrientation();
    }
    scheduleAutoSave();
  });

  // A new study saves as its name is typed (that creates it); afterwards the
  // name is a title with a pencil, and renaming saves on Enter or on leaving
  // the field. Esc cancels.
  function showTitle(): void {
    nameInput.hidden = true;
    titleEl.hidden = false;
    renameBtn.hidden = false;
  }

  function startRename(): void {
    if (studyId === null) return;
    nameInput.value = titleEl.textContent ?? "";
    titleEl.hidden = true;
    renameBtn.hidden = true;
    nameInput.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  function finishRename(commit: boolean): void {
    if (studyId === null || nameInput.hidden) return;
    const name = nameInput.value.trim();
    if (commit && name && name !== titleEl.textContent) {
      titleEl.textContent = name;
      scheduleAutoSave(0);
    }
    showTitle();
  }

  titleEl.addEventListener("click", startRename);
  renameBtn.addEventListener("click", startRename);
  nameInput.addEventListener("input", () => {
    if (studyId === null) scheduleAutoSave(500);
  });
  nameInput.addEventListener("keydown", (event) => {
    if (studyId === null) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finishRename(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishRename(false);
    }
  });
  nameInput.addEventListener("blur", () => finishRename(true));
  document.getElementById("study-start-badge")?.addEventListener("click", goToStart);
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
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;

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
    explorerSourceEl.querySelector<HTMLOptionElement>('option[value="lirep"]')!.disabled =
      playerSelected || !explorerDefaults?.lirepAvailable;
    explorerDatabaseEl.disabled = settings.source === "lirep" && !playerSelected;
    explorerDatabaseEl.querySelector<HTMLOptionElement>('option[value="masters"]')!.disabled = settings.source === "lirep";
    explorerMinRatingEl.disabled = settings.database !== "lichess";
    explorerPlayerEl.hidden = !playerSelected;
    explorerSpeedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = settings.database === "masters";
    });
    updateExplorerSummary();
  }

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
            updateExplorerSummary();
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
    updateExplorerSummary();
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
  });

  explorerMinRatingEl.addEventListener("change", () => {
    settings.minRating = Number(explorerMinRatingEl.value);
    updateExplorerSummary();
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
    updateExplorerSummary();
    void updateExplorer(positionAt(tree, currentId).fen());
    scheduleAutoSave();
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
