import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyLichessBoardTheme, computeDests, createBoard, formatMoves, playMoveSound, toColor } from "./board";
import {
  boardColumnHtml,
  describeStartPoint,
  engineMovesView,
  ENGINE_DEPTH_MAX,
  ENGINE_DEPTH_MIN,
  ENGINE_DEPTH_STEP,
  getSavedEngineDepth,
  getSavedTools,
  missingPopularMoves,
  moveShares,
  QUALITY_BRUSHES,
  saveEngineDepth,
  saveTools,
  toolTabsHtml,
  toolToggleTitle,
  type Tool,
} from "./analysisTools";
import { Engine, whiteGaugeShare, type EngineAnalysis } from "./engine";
import { FOCUS_SHORTCUT_HTML, setupFocusMode } from "./focusMode";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerSummary,
  fetchExplorerDefaults,
  LEAF_VALUE_DESCRIPTIONS,
  LEAF_VALUE_LABELS,
  LEAF_VALUE_SHORT_LABELS,
  bindExplorerSettingsForm,
  explorerSettingsFormHtml,
  renderExplorer,
  renderExplorerError,
  renderExplorerLoading,
  type ExplorerDefaults,
  type ExplorerSettings,
  type ExplorerSpeed,
  type LeafValue,
} from "./explorer";
import {
  EVAL_DEPTH_STORAGE_KEY,
  EVAL_DEPTHS,
  evaluatePosition,
  openEvaluationCache,
  studyDepth,
  type EvaluationCache,
} from "./evalCache";
import { calculateExpectedScore } from "./expectedScore";
import { MOVE_LEVELS, Suggester, type Suggestion } from "./suggest";
import { cachedExplorerData, errorMessage, fetchExplorerData, hasExplorerData } from "./explorerClient";
import { materialBalance, materialHtml } from "./material";
import { downloadStudyFile } from "./studyFile";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { brokenStudyHtml } from "./studyCard";
import {
  addMove,
  createEmptyTree,
  deleteSubtree,
  FOLD_SWITCHES_HTML,
  getSavedFolding,
  lastMoveAt,
  lichessAnalysisUrl,
  pathTo,
  positionAt,
  renderTree,
  saveFolding,
  sanPathTo,
  setLichessOrientation,
  siblingVariation,
  type StudyTree,
} from "./tree";

interface StudyStats {
  winProbability: number;
  calculatedAt: string;
  database: "lichess" | "masters";
  minRating: number | null;
  nodesEvaluated: number;
  explorerCalls: number;
  scoreDepth?: number | null; // Stockfish depth, when Stockfish valued lines' ends
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
  // see doc/starting-point.md.
  startNodeId: number | null;
  // Why its stored moves can't be read (store.py's _broken_study): then
  // it isn't opened, so nothing can save over them.
  broken?: string;
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
          <a class="study-head__link" id="study-games-link" href="/games.html?id=${existing?.id ?? ""}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>Games</a>
          <details class="study-menu" id="study-menu">
            <summary class="btn btn-secondary" aria-label="More study options">⋯</summary>
            <div class="study-menu__panel">
              <label class="study-share">
                <input type="checkbox" id="study-shared" ${existing?.shared ? "checked" : ""} />
                Share with the community
              </label>
              <p class="study-menu__note">Shared studies appear on the Community page, and other people can import a copy.</p>
              <button id="export-study-btn" class="btn btn-secondary" type="button" title="Download this study as a Lirep study file, to import later">Export to file</button>
              <button id="delete-study-btn" class="btn btn-danger" type="button">Delete study</button>
            </div>
          </details>
        </div>
      </header>

      <div class="study-grid">
        ${boardColumnHtml({ focus: true })}

        <div class="study-side-col">
          <div class="study-side-col__inner">
            <div class="study-card study-card--moves">
              <div class="study-actions">
                ${FOLD_SWITCHES_HTML}
                <button id="comment-btn" class="btn btn-secondary study-icon-btn" type="button" aria-expanded="false" aria-controls="comment-editor" aria-label="Comment on this position" title="Comment on this position"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>
                <a id="open-lichess-analysis" class="btn btn-secondary study-icon-btn" data-icon="&#xe05f;" aria-label="Open position in Lichess analysis" title="Open position in Lichess analysis" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer"></a>
                <button id="start-point-btn" class="btn btn-secondary study-icon-btn study-start-btn" type="button" aria-label="Set as starting point" title="Set as starting point"><span aria-hidden="true">🏁</span><span class="study-start-btn__cross" aria-hidden="true">✕</span></button>
                <button id="delete-btn" class="btn btn-secondary study-icon-btn" type="button" data-icon="&#xe04f;" aria-label="Delete this move" title="Delete this move and everything after it (Delete)"></button>
                <span id="focus-save-status" class="focus-save-status" role="status" aria-live="polite"></span>
                <button id="keyboard-help-btn" class="btn btn-secondary study-keyboard-help-btn" type="button" aria-label="Show keyboard shortcuts" aria-expanded="false" aria-controls="keyboard-help">?</button>
              </div>
              <div id="keyboard-help" class="study-keyboard-help" role="region" aria-label="Keyboard shortcuts" tabindex="-1" hidden>
                <p class="study-keyboard-help__title">Keyboard shortcuts</p>
                <p class="study-keyboard-help__intro">Click a move to jump there. Play a different move from any point to start a variation.</p>
                <ul>
                  <li><kbd>←</kbd> / <kbd>→</kbd> Previous / next move</li>
                  <li><kbd>↑</kbd> / <kbd>↓</kbd> Previous / next variation</li>
                  <li><kbd>Shift</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd> Start / end of line</li>
                  <li><kbd>Delete</kbd> Delete selected move and its branches</li>
                  <li><kbd>C</kbd> Comment on this position</li>
                  <li><kbd>F</kbd> Flip the board</li>
                  ${FOCUS_SHORTCUT_HTML}
                  <li><kbd>?</kbd> Show / hide these shortcuts</li>
                </ul>
              </div>
              <p id="live-score" class="live-score" aria-live="polite" hidden></p>
              <div id="tree-view" class="tree-view"></div>
              <p id="move-conflict" class="move-conflict" hidden></p>
              <div class="study-comment-editor" id="comment-editor" hidden>
                <textarea id="study-comment" rows="2" placeholder="Comment on this position" aria-label="Comment on selected position"></textarea>
              </div>
            </div>

            <div class="study-card study-card--tools">
              <div id="tool-explorer" class="tool-panel tool-panel--explorer">
                <div id="explorer-panel" class="explorer-panel"></div>
              </div>

              <div id="tool-settings" class="tool-panel tool-panel--settings" hidden>
                <div class="tool-settings__group">
                  <h3 class="tool-settings__title">Opening Explorer</h3>
                  <p class="tool-settings__note">Which games the Explorer shows. They are also the ones this study's stats are calculated with.</p>
                  <div id="explorer-settings-form">${explorerSettingsFormHtml(settings, {
                    lirepAvailable: Boolean(explorerDefaults?.lirepAvailable),
                    ratingBuckets,
                    defaultMinRating,
                    speeds: allSpeeds,
                  })}</div>
                </div>
                <div class="tool-settings__group">
                  <h3 class="tool-settings__title">End of preparation</h3>
                  <p class="tool-settings__note">How the expected score values a line where your preparation ends, in the move list's figures and on the Stats page. <a class="tool-settings__doc" href="/doc/expected-score.html#leaf-values" target="_blank" rel="noopener">How each works</a></p>
                  <div class="tool-settings__radios" id="leaf-value-radios" role="radiogroup" aria-label="Value at the end of preparation">
                    ${(Object.keys(LEAF_VALUE_LABELS) as LeafValue[])
                      .map(
                        (leaf) => `<label class="tool-settings__radio" title="${LEAF_VALUE_DESCRIPTIONS[leaf]}"><input type="radio" name="leaf-value" value="${leaf}"${(settings.leafValue ?? "explorer") === leaf ? " checked" : ""} />${LEAF_VALUE_SHORT_LABELS[leaf]}</label>`,
                      )
                      .join("")}
                  </div>
                </div>
                <div class="tool-settings__group" id="figures-depth-group">
                  <h3 class="tool-settings__title">Stockfish depth</h3>
                  <p class="tool-settings__note">How deep Stockfish evaluates the lines' ends it values: saved with the study, for its figures, its suggested moves and its Stats page. Evaluations already made in this browser at that depth are reused; Calculate makes the others.</p>
                  <div class="tool-settings__radios" id="figures-depth" role="radiogroup" aria-label="Stockfish depth">
                    ${EVAL_DEPTHS.map((d) => `<label class="tool-settings__radio"><input type="radio" name="figures-depth" value="${d}" />${d} · ${({ 8: "Quick", 12: "Balanced" } as Record<number, string>)[d] ?? "Thorough"}</label>`).join("")}
                  </div>
                </div>
              </div>

              <div id="tool-suggest" class="tool-panel tool-panel--settings" hidden>
                <div class="tool-settings__group">
                  <h3 class="tool-settings__title">Suggest moves <span class="suggest-doc">(see <a href="/doc/suggested-moves.html" target="_blank" rel="noopener" title="How the moves are chosen: the algorithm, in the documentation">how it works</a>)</span></h3>
                  <p class="tool-settings__note">Adds your moves one at a time, each the one raising the expected score most, with the end-of-prep value set in the settings (<span id="suggest-valued"></span>). Nothing goes into the study until you add it. Fast, but not always the best: a move worth little alone, but much with the next one, is missed.</p>
                  <div class="suggest-goal" role="radiogroup" aria-label="How many moves">
                    <label class="tool-settings__radio"><input type="radio" name="suggest-goal" value="moves" checked />Add<input id="suggest-moves" type="number" min="1" max="200" value="5" aria-label="Number of moves" />moves</label>
                    <label class="tool-settings__radio"><input type="radio" name="suggest-goal" value="target" />Until the expected score reaches<input id="suggest-target" type="number" min="1" max="100" step="0.5" value="55" aria-label="Target expected score, in percent" />%</label>
                  </div>
                  <div class="suggest-goal" role="radiogroup" aria-label="Where">
                    <label class="tool-settings__radio"><input type="radio" name="suggest-scope" value="study" checked />In the whole study (from its starting point)</label>
                    <label class="tool-settings__radio"><input type="radio" name="suggest-scope" value="here" />After the selected move only</label>
                  </div>
                  <details class="suggest-advanced">
                    <summary>Advanced</summary>
                    <label>Your most played moves considered in a position<input id="suggest-candidates" type="number" min="1" max="10" value="6" /></label>
                    <label>Games a move needs to be considered<input id="suggest-min-games" type="number" min="1" value="100" /></label>
                    <label>Replies left out below this share of games (%)<input id="suggest-min-reach" type="number" min="0" max="100" step="0.1" value="0.2" /></label>
                    <label title="By the centipawns a move loses against Stockfish's best: its evaluation before the move minus after it. Stockfish then evaluates the moves tried, at the depth in the settings">Moves allowed
                      <select id="suggest-level">
                        <option value="" selected>Any</option>
                        ${MOVE_LEVELS.map((level) => `<option value="${level.cp}">${level.label} (losing at most ${level.cp} cp)</option>`).join("")}
                        <option value="custom">Losing at most…</option>
                      </select>
                      <span id="suggest-max-loss-field" hidden><input id="suggest-max-loss" type="number" min="0" step="5" value="50" aria-label="Most centipawns lost" />cp</span>
                    </label>
                  </details>
                  <div class="suggest-actions">
                    <button id="suggest-one-btn" class="btn btn-secondary btn-small" type="button">Suggest one move</button>
                    <button id="suggest-run-btn" class="btn btn-primary btn-small" type="button">Run</button>
                    <button id="suggest-stop-btn" class="btn btn-secondary btn-small" type="button" hidden>Stop</button>
                    <button id="suggest-add-all-btn" class="btn btn-secondary btn-small" type="button" hidden>Add all</button>
                    <button id="suggest-clear-btn" class="btn btn-secondary btn-small" type="button" hidden>Clear</button>
                  </div>
                  <p id="suggest-status" class="suggest-status" aria-live="polite"></p>
                  <ol id="suggest-list" class="suggest-list"></ol>
                </div>
              </div>

              ${toolTabsHtml({ suggest: true, settings: true })}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const studyHeadEl = main.querySelector(".study-head") as HTMLElement;
  const boardEl = document.getElementById("board") as HTMLElement;
  const treeViewEl = document.getElementById("tree-view") as HTMLElement;
  const liveScoreEl = document.getElementById("live-score") as HTMLElement;
  const focusSaveStatusEl = document.getElementById("focus-save-status") as HTMLElement;

  // Focus mode (see focusMode.ts): the site's header and the study's line
  // hide. Either way, the board is sized to what the window has left below
  // whatever is above the editor, so the editor fits without scrolling.
  const focusMode = setupFocusMode({
    main,
    button: document.getElementById("focus-btn") as HTMLButtonElement,
    grid: main.querySelector(".study-grid") as HTMLElement,
    above: [studyHeadEl],
  });

  // Experimental: the moves at each branching in folds (see renderFolds in
  // tree.ts), on unless switched off in this browser.
  const savedFolding = getSavedFolding();
  let foldBranches = savedFolding.fold;
  const openFolds = new Set<number>();
  const foldBtn = document.getElementById("fold-btn") as HTMLButtonElement;
  foldBtn.setAttribute("aria-checked", String(foldBranches));
  foldBtn.addEventListener("click", () => {
    foldBranches = !foldBranches;
    foldBtn.setAttribute("aria-checked", String(foldBranches));
    autoFoldBtn.disabled = !foldBranches;
    saveFolding("fold", foldBranches);
    renderTreeView();
  });

  // With folding on: moving to another move closes the folds not on the
  // way to it, so a variation folds up once you leave it. Off unless
  // switched on in this browser.
  let autoFold = savedFolding.autoFold;
  const autoFoldBtn = document.getElementById("autofold-btn") as HTMLButtonElement;
  autoFoldBtn.setAttribute("aria-checked", String(autoFold));
  autoFoldBtn.disabled = !foldBranches;
  autoFoldBtn.addEventListener("click", () => {
    autoFold = !autoFold;
    autoFoldBtn.setAttribute("aria-checked", String(autoFold));
    saveFolding("autoFold", autoFold);
    if (autoFold) {
      openFolds.clear();
      renderTreeView();
    }
  });
  const commentInputEl = document.getElementById("study-comment") as HTMLTextAreaElement;
  const keyboardHelpButton = document.getElementById("keyboard-help-btn") as HTMLButtonElement;
  const keyboardHelpPanel = document.getElementById("keyboard-help") as HTMLElement;
  const explorerPanelEl = document.getElementById("explorer-panel") as HTMLElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const engineDepthEl = document.getElementById("engine-depth") as HTMLElement;
  const depthDownBtn = document.getElementById("depth-down") as HTMLButtonElement;
  const depthUpBtn = document.getElementById("depth-up") as HTMLButtonElement;
  let engineDepth = getSavedEngineDepth();
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const nameInput = document.getElementById("study-name") as HTMLInputElement;
  const titleEl = document.getElementById("study-title") as HTMLElement;
  const renameBtn = document.getElementById("rename-btn") as HTMLButtonElement;
  const colorSelect = document.getElementById("study-color") as HTMLSelectElement | null;
  const saveStatusEl = document.getElementById("study-save-status") as HTMLElement;
  focusSaveStatusEl.textContent = saveStatusEl.textContent?.trim() ?? "";
  const deleteStudyBtn = document.getElementById("delete-study-btn") as HTMLButtonElement;
  const sharedInput = document.getElementById("study-shared") as HTMLInputElement;
  const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;
  const flipBoardBtn = document.getElementById("flip-board-btn") as HTMLButtonElement;
  const moveConflictEl = document.getElementById("move-conflict") as HTMLElement;
  const lichessAnalysisLink = document.getElementById("open-lichess-analysis") as HTMLAnchorElement;
  const navStartBtn = document.getElementById("nav-start") as HTMLButtonElement;
  const gaugeEl = document.getElementById("eval-gauge") as HTMLElement;
  const materialTopEl = document.getElementById("material-top") as HTMLElement;
  const materialBottomEl = document.getElementById("material-bottom") as HTMLElement;
  const gaugeBlackEl = document.getElementById("eval-gauge-black") as HTMLElement;
  const navBackBtn = document.getElementById("nav-back") as HTMLButtonElement;
  const navForwardBtn = document.getElementById("nav-forward") as HTMLButtonElement;
  const navEndBtn = document.getElementById("nav-end") as HTMLButtonElement;
  const studyLinksEl = document.getElementById("study-links") as HTMLElement;
  const studyMenuEl = document.getElementById("study-menu") as HTMLDetailsElement;
  const commentBtn = document.getElementById("comment-btn") as HTMLButtonElement;
  const commentEditorEl = document.getElementById("comment-editor") as HTMLElement;
  const tabButtons = {
    explorer: document.getElementById("tab-explorer") as HTMLButtonElement,
    engine: document.getElementById("tab-engine") as HTMLButtonElement,
  };
  const tabPanels = {
    explorer: document.getElementById("tool-explorer") as HTMLElement,
    engine: document.getElementById("tool-engine") as HTMLElement,
  };
  // The gear's settings and the bulb's suggested moves take the tools'
  // place in their card while shown.
  const windowPanels = {
    settings: document.getElementById("tool-settings") as HTMLElement,
    suggest: document.getElementById("tool-suggest") as HTMLElement,
  };
  const windowTabs = {
    settings: document.getElementById("tab-settings") as HTMLButtonElement,
    suggest: document.getElementById("tab-suggest") as HTMLButtonElement,
  };
  let shownWindow: "settings" | "suggest" | null = null;

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
  // the default. See doc/starting-point.md.
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
    for (const el of [saveStatusEl, focusSaveStatusEl]) {
      el.textContent = message;
      el.classList.toggle("study-save-status--error", failed);
    }
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
    // Moves, the starting point and the Explorer settings change which
    // lines' data is already in this browser.
    scheduleUnfetchedCheck();
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
            syncOrientation();
          }
          colorSelect.replaceWith(sidePawn(saved.side));
        }
        studyLinksEl.hidden = false;
        titleEl.textContent = saved.name;
        if (document.activeElement !== nameInput) showTitle();
        (document.getElementById("study-stats-link") as HTMLAnchorElement).href = `/stat.html?id=${saved.id}`;
        (document.getElementById("study-practice-link") as HTMLAnchorElement).href = `/practice-session.html?id=${saved.id}`;
        (document.getElementById("study-games-link") as HTMLAnchorElement).href = `/games.html?id=${saved.id}`;
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
    playMoveSound(move);
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
    playMoveSound(move);
    goTo(addMove(tree, currentId, move.san));
    scheduleAutoSave();
  }

  async function updateExplorer(fen: string): Promise<void> {
    if (!shownTools.has("explorer")) return;
    const requestId = ++explorerRequestId;
    renderExplorerLoading(explorerPanelEl);
    try {
      const data = await fetchExplorerData(fen, settings, currentSide(), { priority: "interactive" });
      if (requestId !== explorerRequestId) return;
      explorerFetched(fen);
      const chess = positionAt(tree, currentId);
      renderExplorer(
        explorerPanelEl,
        data,
        playSan,
        {
          inTree: new Set(tree.nodes[currentId].children.map((id) => tree.nodes[id].san as string)),
          yourTurn: (chess.turn() === "w") === (currentSide() === "white"),
        },
        explorerSummary(settings),
      );
    } catch (err) {
      if (requestId === explorerRequestId) renderExplorerError(explorerPanelEl, errorMessage(err));
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
    playMoveSound(move);
    goTo(addMove(tree, currentId, move.san));
    scheduleAutoSave();
  }

  // Lichess's evaluation gauge, beside the board while Stockfish is on:
  // White's share fills from White's side of the board, so it flips with it.
  function setGauge(whiteShare: number): void {
    gaugeBlackEl.style.height = `${(1 - whiteShare) * 100}%`;
    gaugeEl.setAttribute("aria-label", `Evaluation: White ${Math.round(whiteShare * 100)}%`);
  }

  // The material balance above and below the board, as during a Lichess
  // game: the row nearest each side's pieces shows what that side is up.
  function renderMaterial(): void {
    const balance = materialBalance(positionAt(tree, currentId));
    const bottom = boardOrientation === "white" ? "w" : "b";
    const top = bottom === "w" ? "b" : "w";
    materialTopEl.innerHTML = materialHtml(balance[top]);
    materialBottomEl.innerHTML = materialHtml(balance[bottom]);
  }

  // What depends on which side is at the bottom: the gauge and the material rows.
  function syncOrientation(): void {
    gaugeEl.classList.toggle("eval-gauge--flipped", boardOrientation === "black");
    renderMaterial();
    setLichessOrientation(lichessAnalysisLink, boardOrientation);
  }

  // Stockfish's top lines for the last position analysed, reused when only
  // the Explorer side changes (turned on or off, other settings).
  let topLines: { fen: string; depth: number; analysis: EngineAnalysis } | null = null;
  // The position the arrows and chips on show are for.
  let shownFen: string | null = null;

  async function updateEngine(chess: Chess): Promise<void> {
    const analysisId = ++engineAnalysisId;
    if (!shownTools.has("engine")) return;
    const stale = () => analysisId !== engineAnalysisId || !shownTools.has("engine");

    if (chess.isGameOver()) {
      board.set({ drawable: { autoShapes: [] } });
      setGauge(chess.isCheckmate() ? (chess.turn() === "w" ? 0 : 1) : 0.5);
      engineStatusEl.textContent = "Game over";
      enginePanelEl.innerHTML = "";
      return;
    }

    if (!engine) engine = new Engine();
    const fen = chess.fen();
    // Another position's arrows would point at the wrong squares while this
    // one is analysed: they go, and only come back for this position.
    if (shownFen !== fen) {
      shownFen = null;
      board.set({ drawable: { autoShapes: [] } });
      enginePanelEl.innerHTML = "";
    }
    const sideToMoveIsWhite = chess.turn() === "w";
    // Fetched alongside the analysis; deduplicated with the Explorer panel's
    // own request and served from the browser cache when it can be.
    const explorerRequest = shownTools.has("explorer")
      ? fetchExplorerData(fen, settings, currentSide(), { priority: "interactive" }).catch(() => null)
      : Promise.resolve(null);

    const depth = engineDepth;
    let analysis = topLines?.fen === fen && topLines.depth === depth ? topLines.analysis : null;
    if (!analysis) {
      engineStatusEl.textContent = `depth ${depth}…`;
      analysis = await engine.analyze(fen, depth);
      if (stale()) return;
      topLines = { fen, depth, analysis };
    }
    setGauge(whiteGaugeShare(analysis.lines[0], sideToMoveIsWhite));

    const explorer = await explorerRequest;
    if (stale()) return;
    const shares = moveShares(chess, explorer);
    const lines = [...analysis.lines];
    const extra = missingPopularMoves(lines, shares);
    if (extra.length) {
      engineStatusEl.textContent = `depth ${depth}…`;
      engineStatusEl.title = "Evaluating popular Explorer moves";
      const more = await engine.analyze(fen, depth, extra);
      if (stale()) return;
      lines.push(...more.lines.filter((l) => !lines.some((known) => known.move === l.move)));
    }

    const { shapes, chipsHtml } = engineMovesView(chess, lines, shares, "Play");
    board.set({ drawable: { autoShapes: shapes } });
    shownFen = fen;
    engineStatusEl.textContent = `depth ${depth}`;
    engineStatusEl.title = "Stockfish's search depth, in this browser";
    enginePanelEl.innerHTML = chipsHtml;

    enginePanelEl.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((btn) => {
      btn.addEventListener("click", () => playUci(btn.dataset.move as string));
    });
  }

  // Experimental: the expected score, live, in the move list. The Stats
  // page's walk runs on the Explorer data this browser already holds, with
  // Explorer results where lines end (whatever the Stats page's setting).
  // Each of the opponent's replies at a branching shows how likely it is to
  // be reached and what it is worth, so that they can be compared, and so do
  // the replies the tree doesn't have, together; the total goes next to the
  // starting position. A figure that lacks Explorer data shows Calculate
  // instead, which loads just the positions it needs, in the background.
  //
  // Separately, a ring marks each move after which the expected score needs
  // a position whose Explorer data this browser hasn't loaded yet: every
  // position where the opponent is to move (how often each reply is
  // played), and the one before each line's last move (that move's
  // results). Opening such a move with the Explorer panel on loads it.
  // Checked in the browser's Explorer cache only, never fetched for this.
  type Figures = { probability: number; score: number };
  type Missing = { fen: string; nodeId: number };
  let unfetched: ReadonlyMap<number, string> = new Map(); // node id -> position after it
  let missing: readonly Missing[] = [];
  let missingEvaluations: readonly Missing[] = [];

  // The figures' and suggestions' Stockfish values: from this browser's
  // evaluation cache, the Stats page's, at the study's depth, set in the
  // settings and saved with the study.
  const figuresDepth = () => studyDepth(settings);
  let evaluationCachePromise: Promise<EvaluationCache> | null = null;
  const evaluationCache = () =>
    (evaluationCachePromise ??= fetchMe().then((me) => openEvaluationCache(me.username ?? "")));
  let moveStats: ReadonlyMap<number, Figures> = new Map();
  let otherReplies: ReadonlyMap<number, Figures> = new Map();
  let startStat: { text: string; title: string } | undefined;
  let calcButtons: ReadonlySet<number> = new Set(); // replies, or the start, lacking figures
  const calcBusy = new Map<number, string>(); // what a running Calculate says instead
  let liveRun = 0;
  let unfetchedTimer: number | null = null;

  const effectiveStart = () => (startNodeId !== null && startNodeId in tree.nodes ? startNodeId : tree.rootId);

  // After edits, a moment after the last one: they change what's needed.
  function scheduleUnfetchedCheck(): void {
    if (unfetchedTimer !== null) window.clearTimeout(unfetchedTimer);
    unfetchedTimer = window.setTimeout(() => {
      unfetchedTimer = null;
      void checkUnfetched();
    }, 300);
  }

  // The panel just loaded this position: every move leading to it has its
  // data now, and the walk goes again if it lacked it.
  function explorerFetched(fen: string): void {
    const kept = new Map([...unfetched].filter(([, needed]) => needed !== fen));
    if (kept.size !== unfetched.size) {
      unfetched = kept;
      renderTreeView();
    }
    if (missing.some((m) => m.fen === fen)) void checkUnfetched();
  }

  // The positions the expected score's walk reads, by the move leading to
  // each (the starting point's own position has no move to mark if it's the
  // initial one).
  function neededPositions(): Map<number, string> {
    const side = currentSide();
    const start = startNodeId !== null && startNodeId in tree.nodes ? startNodeId : tree.rootId;
    const needed = new Map<number, string>();
    const after = (chess: Chess, nodeId: number) => {
      const next = new Chess(chess.fen());
      next.move(tree.nodes[nodeId].san as string);
      return next;
    };
    // With Stockfish values, lines' ends need no Explorer results: only the
    // positions where the opponent is to move do.
    const explorerEnds = (settings.leafValue ?? "explorer") !== "stockfish";
    const walk = (nodeId: number, chess: Chess): void => {
      if (chess.isGameOver()) return;
      const children = tree.nodes[nodeId].children;
      if ((chess.turn() === "w") === (side === "white")) {
        const own = children[0];
        // Nothing prepared from the starting point: its own results.
        if (own === undefined) {
          if (nodeId === start && explorerEnds) needed.set(nodeId, chess.fen());
          return;
        }
        const next = after(chess, own);
        // The line goes on after your move if an opponent's reply in the
        // tree is answered; otherwise it ends with it, valued here.
        if (!next.isGameOver() && tree.nodes[own].children.some((reply) => tree.nodes[reply].children.length > 0)) {
          walk(own, next);
        } else if (!next.isGameOver() && explorerEnds) {
          needed.set(nodeId, chess.fen());
        }
        return;
      }
      needed.set(nodeId, chess.fen());
      for (const reply of children) walk(reply, after(chess, reply));
    };
    walk(start, positionAt(tree, start));
    needed.delete(tree.rootId);
    return needed;
  }

  // The opponent's replies at branchings from the starting point on: where
  // the figures go.
  function branchReplies(start: number, side: "white" | "black"): number[] {
    const replies: number[] = [];
    const visit = (nodeId: number, ply: number): void => {
      const children = tree.nodes[nodeId].children;
      // After an even number of moves, White is to move: these are the
      // opponent's moves when the study is for Black.
      const opponentReplies = (ply % 2 === 0) === (side === "black");
      for (const childId of children) {
        if (opponentReplies && children.length > 1) replies.push(childId);
        visit(childId, ply + 1);
      }
    };
    visit(start, sanPathTo(tree, start).length);
    return replies;
  }

  async function checkUnfetched(): Promise<void> {
    const run = ++liveRun;
    const side = currentSide();
    if (Object.keys(tree.nodes).length <= 1) {
      missing = [];
      unfetched = new Map();
      moveStats = new Map();
      otherReplies = new Map();
      startStat = undefined;
      calcButtons = new Set();
      liveScoreEl.hidden = true;
      renderTreeView();
      return;
    }
    const needed = [...neededPositions()];
    const loaded = await Promise.all(needed.map(([, fen]) => hasExplorerData(fen, settings, side)));
    if (run !== liveRun) return;
    const start = effectiveStart();
    const stats = new Map<number, Figures>();
    const others = new Map<number, Figures>(); // score summed as points until the end
    let unprepared = 0;
    let unpreparedPoints = 0;
    let result;
    const leaf = settings.leafValue ?? "explorer";
    const depth = figuresDepth();
    try {
      const evaluations = leaf === "explorer" ? null : await evaluationCache();
      result = await calculateExpectedScore(
        tree,
        start,
        side,
        (fen) => cachedExplorerData(fen, settings, side),
        leaf,
        evaluations ? (fen) => evaluations.get(fen, depth) : undefined,
        (position) => {
          if (position.san !== null) {
            unprepared += position.probability;
            unpreparedPoints += position.probability * position.score;
            const sum = others.get(position.nodeId) ?? { probability: 0, score: 0 };
            others.set(position.nodeId, { probability: sum.probability + position.probability, score: sum.score + position.probability * position.score });
            return;
          }
          if (position.complete) stats.set(position.nodeId, { probability: position.probability, score: position.score });
        },
      );
    } catch {
      // The 2016 sample's Explorer is asked from the backend, and can fail.
      if (run !== liveRun) return;
      liveScoreEl.hidden = false;
      liveScoreEl.textContent = "Expected score: the Explorer data couldn't be read.";
      return;
    }
    if (run !== liveRun) return;
    liveScoreEl.hidden = true;
    missing = result.missingPositions;
    missingEvaluations = result.missingEvaluations;
    unfetched = new Map(needed.filter((_, i) => !loaded[i]));
    for (const [id, sum] of others) others.set(id, { probability: sum.probability, score: sum.score / sum.probability });
    const replies = branchReplies(start, side);
    // A reply the walk didn't reach with nothing missing on its way or after
    // it isn't played in the Explorer's games (or the position before it
    // has none): 0%, with no score, and nothing for Calculate to load.
    const lacking = [...missing, ...missingEvaluations].map((m) => m.nodeId).filter((id) => id in tree.nodes);
    const lacksData = (reply: number) => {
      const above = new Set(pathTo(tree, reply).map((node) => node.id));
      return lacking.some((id) => above.has(id) || pathTo(tree, id).some((node) => node.id === reply));
    };
    const unplayed = { probability: 0, score: NaN };
    moveStats = new Map(
      replies.filter((id) => stats.has(id) || !lacksData(id)).map((id) => [id, stats.get(id) ?? unplayed]),
    );
    otherReplies = others;
    const buttons = new Set(replies.filter((id) => !moveStats.has(id)));
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const valuedWith = leaf === "explorer" ? "Explorer results" : `${LEAF_VALUE_LABELS[leaf]} (Stockfish depth ${depth})`;
    if (missing.length || missingEvaluations.length) {
      buttons.add(start);
      startStat = {
        text: "Expected score:",
        title: `Load the Opening Explorer data${leaf === "explorer" ? "" : " and the Stockfish evaluations"} the whole study needs`,
      };
    } else {
      startStat = {
        text: `Expected score: ${pct(result.score)}`,
        title: `Calculated live; lines' ends valued with ${valuedWith}. Replies you haven't prepared: ${pct(unprepared)} of games${
          unprepared ? `, scoring ${pct(unpreparedPoints / unprepared)}` : ""
        }.`,
      };
    }
    calcButtons = buttons;
    renderTreeView();
  }

  // Calculate for `target` (a reply at a branching, or the starting point
  // for the whole study): load the missing positions on its way from the
  // starting point and in what follows it, walk again, and repeat for those
  // found missing further on, until its figures are complete.
  async function calculateFigures(target: number): Promise<void> {
    if (calcBusy.has(target)) return;
    const side = currentSide();
    const whole = target === effectiveStart();
    const above = new Set(pathTo(tree, target).map((node) => node.id));
    const concerns = (nodeId: number) =>
      whole || above.has(nodeId) || (nodeId in tree.nodes && pathTo(tree, nodeId).some((node) => node.id === target));
    let loaded = 0;
    const say = (text: string) => {
      calcBusy.set(target, text);
      renderTreeView();
    };
    say("Calculating…");
    let engine: Engine | null = null;
    const tried = new Set<string>(); // evaluations Stockfish couldn't give stay missing
    try {
      for (let round = 0; round < 100; round++) {
        const needed = [...new Set(missing.filter((m) => concerns(m.nodeId)).map((m) => m.fen))];
        const toEvaluate = [...new Set(missingEvaluations.filter((m) => concerns(m.nodeId) && !tried.has(m.fen)).map((m) => m.fen))];
        if (!needed.length && !toEvaluate.length) break;
        if (toEvaluate.length) {
          const evaluations = await evaluationCache();
          const depth = figuresDepth();
          engine ??= new Engine();
          for (const fen of toEvaluate) {
            tried.add(fen);
            const cp = await evaluatePosition(engine, new Chess(fen), depth);
            if (cp !== null) await evaluations.set(fen, depth, cp);
            loaded += 1;
            say(`Calculating… ${loaded} position${loaded === 1 ? "" : "s"} done`);
          }
        }
        for (const fen of needed) {
          await fetchExplorerData(fen, settings, side, {
            priority: "background",
            onRateLimited: (resumeAt) =>
              say(`Lichess asked to wait; resuming at ${new Date(resumeAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}…`),
          });
          loaded += 1;
          say(`Calculating… ${loaded} position${loaded === 1 ? "" : "s"} done`);
        }
        await checkUnfetched();
      }
      calcBusy.delete(target);
    } catch (err) {
      calcBusy.set(target, errorMessage(err) ?? "Couldn't load the Explorer data.");
      renderTreeView();
      window.setTimeout(() => {
        calcBusy.delete(target);
        renderTreeView();
      }, 6000);
      return;
    } finally {
      (engine as Engine | null)?.terminate();
    }
    renderTreeView();
  }

  function renderTreeView(): void {
    // Folded, the folds on the way to the current move are open too.
    const open = new Set(openFolds);
    for (const node of pathTo(tree, currentId)) open.add(node.id);
    treeViewEl.innerHTML = renderTree(tree, currentId, currentSide(), startNodeId, {
      unfetched: new Set(unfetched.keys()),
      moveStats,
      startStat,
      calculate: { buttons: calcButtons, busy: calcBusy },
      startFlag: true,
      folding: foldBranches ? { open, others: otherReplies } : undefined,
    });
    treeViewEl.querySelector<HTMLButtonElement>("[data-clear-start]")?.addEventListener("click", () => setStartPoint(null));
    treeViewEl.querySelectorAll<HTMLButtonElement>("[data-calculate]").forEach((button) => {
      button.addEventListener("click", (event) => {
        // In a fold's head: calculate rather than toggle the fold.
        event.preventDefault();
        event.stopPropagation();
        void calculateFigures(Number(button.dataset.calculate));
      });
    });
    treeViewEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
      el.addEventListener("click", (event) => {
        // A move in a fold's head goes to the move rather than toggling the fold.
        if (el.closest("summary")) event.preventDefault();
        goTo(Number(el.dataset.nodeId));
      });
    });
    treeViewEl.querySelectorAll<HTMLDetailsElement>("details[data-fold-id]").forEach((fold) => {
      fold.addEventListener("toggle", () => {
        const id = Number(fold.dataset.foldId);
        if (fold.open) openFolds.add(id);
        else openFolds.delete(id);
      });
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

    // The flag; crossed out when this move is the starting point, to clear it.
    const btn = document.getElementById("start-point-btn") as HTMLButtonElement;
    const clears = currentId === startNodeId && startNodeId !== null;
    const label = clears ? "Clear the starting point" : "Set as starting point";
    btn.classList.toggle("study-start-btn--clear", clears);
    btn.setAttribute("aria-label", label);
    btn.title = label;
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
    const previousId = currentId;
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
    lichessAnalysisLink.href = lichessAnalysisUrl(line, sanPathTo(tree, currentId).length, boardOrientation);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      check: chess.isCheck(),
      lastMove: lastMoveAt(tree, currentId),
      movable: { color: toColor(chess), dests: computeDests(chess) },
    });
    renderMaterial();

    // Auto-fold: only the folds on the way to the new move stay open.
    if (autoFold && nodeId !== previousId) openFolds.clear();
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
  // backend's stats calculations use, see doc/starting-point.md) — used both to
  // open the editor and for "Go to start" / Up, so that action means
  // "back to where prep begins" rather than always the very first move.
  function goToStart(): void {
    goTo(startNodeId !== null && startNodeId in tree.nodes ? startNodeId : tree.rootId);
  }

  function applyToolsUI(): void {
    for (const name of ["explorer", "engine"] as const) {
      tabButtons[name].setAttribute("aria-pressed", String(shownTools.has(name)));
      tabButtons[name].title = toolToggleTitle(name, shownTools.has(name));
      tabPanels[name].hidden = shownWindow !== null || !shownTools.has(name);
    }
    for (const name of ["settings", "suggest"] as const) {
      windowPanels[name].hidden = shownWindow !== name;
      windowTabs[name].setAttribute("aria-pressed", String(shownWindow === name));
    }
    gaugeEl.hidden = !shownTools.has("engine");
    engineDepthEl.hidden = !shownTools.has("engine");
    // The tools card takes only the room its open tools need; the tree has the rest.
    const toolsCard = document.querySelector(".study-card--tools");
    toolsCard?.classList.toggle("study-card--tools-both", shownTools.size === 2);
    toolsCard?.classList.toggle("study-card--tools-explorer", shownWindow !== null || shownTools.has("explorer"));
    toolsCard?.classList.toggle("study-card--tools-none", shownWindow === null && shownTools.size === 0);
  }

  // The Explorer panel, and Stockfish's arrow widths, which follow the
  // Explorer's frequencies (Stockfish's own top lines are reused).
  function refreshExplorerViews(): void {
    const chess = positionAt(tree, currentId);
    void updateExplorer(chess.fen());
    if (shownTools.has("engine")) void updateEngine(chess);
  }

  function toggleTool(tool: Tool): void {
    // From the settings or the suggestions, a tool's tab goes back to the
    // tools, with it on.
    if (shownWindow !== null) {
      shownWindow = null;
      if (shownTools.has(tool)) return applyToolsUI();
      shownTools.add(tool);
    } else if (shownTools.has(tool)) shownTools.delete(tool);
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
    } else {
      if (!on) {
        explorerRequestId++; // drop a response still on its way
        explorerPanelEl.innerHTML = "";
      }
      refreshExplorerViews();
    }
  }

  function setEngineDepth(depth: number): void {
    engineDepth = Math.min(ENGINE_DEPTH_MAX, Math.max(ENGINE_DEPTH_MIN, depth));
    depthDownBtn.disabled = engineDepth <= ENGINE_DEPTH_MIN;
    depthUpBtn.disabled = engineDepth >= ENGINE_DEPTH_MAX;
    depthDownBtn.title = `Depth ${Math.max(ENGINE_DEPTH_MIN, engineDepth - ENGINE_DEPTH_STEP)}`;
    depthUpBtn.title = `Depth ${Math.min(ENGINE_DEPTH_MAX, engineDepth + ENGINE_DEPTH_STEP)}`;
    saveEngineDepth(engineDepth);
  }

  depthDownBtn.addEventListener("click", () => {
    setEngineDepth(engineDepth - ENGINE_DEPTH_STEP);
    void updateEngine(positionAt(tree, currentId));
  });
  depthUpBtn.addEventListener("click", () => {
    setEngineDepth(engineDepth + ENGINE_DEPTH_STEP);
    void updateEngine(positionAt(tree, currentId));
  });
  setEngineDepth(engineDepth);

  tabButtons.explorer.addEventListener("click", () => toggleTool("explorer"));
  tabButtons.engine.addEventListener("click", () => toggleTool("engine"));

  // The gear swaps the card's tools for the Explorer settings, and back;
  // the bulb likewise for the suggested moves.
  for (const name of ["settings", "suggest"] as const) {
    windowTabs[name].addEventListener("click", () => {
      shownWindow = shownWindow === name ? null : name;
      if (name === "suggest") updateSuggestValued();
      applyToolsUI();
    });
  }

  bindExplorerSettingsForm(
    document.getElementById("explorer-settings-form") as HTMLElement,
    settings,
    Boolean(explorerDefaults?.lirepAvailable),
    () => {
      refreshExplorerViews();
      scheduleAutoSave();
    },
  );

  // The study's end-of-prep value: saved with its settings, and the
  // figures follow it. With Stockfish, alone or as Hybrid, its depth
  // shows too.
  const leafValueRadios = document.getElementById("leaf-value-radios") as HTMLElement;
  const depthGroup = document.getElementById("figures-depth-group") as HTMLElement;
  const depthRadios = document.getElementById("figures-depth") as HTMLElement;
  const showDepth = () => {
    depthGroup.hidden = (settings.leafValue ?? "explorer") === "explorer";
    const radio = depthRadios.querySelector<HTMLInputElement>(`input[value="${figuresDepth()}"]`);
    if (radio) radio.checked = true;
  };
  showDepth();
  leafValueRadios.addEventListener("change", (e) => {
    settings.leafValue = (e.target as HTMLInputElement).value as LeafValue;
    showDepth();
    scheduleAutoSave();
    void checkUnfetched();
  });
  depthRadios.addEventListener("change", (e) => {
    const value = (e.target as HTMLInputElement).value;
    settings.depth = Number(value);
    try {
      localStorage.setItem(EVAL_DEPTH_STORAGE_KEY, value);
    } catch {
      // The study keeps it; this is only the default for new studies.
    }
    scheduleAutoSave();
    void checkUnfetched();
  });

  // The bulb's suggested moves (see suggest.ts). They are worked out on a
  // copy of the study, which holds the earlier suggestions not added yet,
  // and go into the study only when added.
  const suggestValuedEl = document.getElementById("suggest-valued") as HTMLElement;
  const suggestStatusEl = document.getElementById("suggest-status") as HTMLElement;
  const suggestListEl = document.getElementById("suggest-list") as HTMLOListElement;
  const suggestOneBtn = document.getElementById("suggest-one-btn") as HTMLButtonElement;
  const suggestRunBtn = document.getElementById("suggest-run-btn") as HTMLButtonElement;
  const suggestStopBtn = document.getElementById("suggest-stop-btn") as HTMLButtonElement;
  const suggestAddAllBtn = document.getElementById("suggest-add-all-btn") as HTMLButtonElement;
  const suggestClearBtn = document.getElementById("suggest-clear-btn") as HTMLButtonElement;
  const suggestNumber = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value);
  let suggestions: Suggestion[] = [];
  let suggestRunning = false;
  let suggestStop = false;

  function updateSuggestValued(): void {
    const leaf = settings.leafValue ?? "explorer";
    suggestValuedEl.textContent = leaf === "explorer" ? LEAF_VALUE_LABELS[leaf] : `${LEAF_VALUE_LABELS[leaf]}, depth ${figuresDepth()}`;
  }

  /** Adds `line` (SAN from the initial position) to `target`, move by move;
   * the id of its last move, or null if one of your moves conflicts with
   * another you already have there. */
  function addLine(target: StudyTree, line: string[]): number | null {
    let nodeId = target.rootId;
    const chess = new Chess();
    for (const san of line) {
      const yours = (chess.turn() === "w") === (currentSide() === "white");
      const children = target.nodes[nodeId].children;
      const existing = children.find((id) => target.nodes[id].san === san);
      if (existing === undefined && yours && children.length) return null;
      nodeId = existing ?? addMove(target, nodeId, san);
      chess.move(san);
    }
    return nodeId;
  }

  /** The node at the end of `line` in the study, if it's there. */
  function nodeOfLine(line: string[]): number | undefined {
    let nodeId = tree.rootId;
    for (const san of line) {
      const next = tree.nodes[nodeId].children.find((id) => tree.nodes[id].san === san);
      if (next === undefined) return undefined;
      nodeId = next;
    }
    return nodeId;
  }

  // A move with its number, from its ply (0: White's first move).
  const numbered = (ply: number, san: string) => `${Math.floor(ply / 2) + 1}.${ply % 2 ? ".." : ""} ${san}`;

  function renderSuggestions(): void {
    const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
    suggestListEl.innerHTML = suggestions
      .map((s, i) => {
        const added = nodeOfLine(s.line) !== undefined;
        // "after 2... d5: 3. d3": the reply, then your move, numbered.
        const reply = s.line.length > 1 ? `after ${numbered(s.line.length - 2, s.reply)}: ` : "";
        const own = numbered(s.line.length - 1, s.move);
        return `<li class="suggest-row${added ? " suggest-row--added" : ""}">
          <button class="suggest-row__line" type="button" data-index="${i}" title="${escapeHtml(formatMoves(s.line))}">${escapeHtml(reply)}<strong>${escapeHtml(own)}</strong></button>
          <span class="suggest-row__score" title="The expected score with this move and the ones above">${pct(s.score)} (+${(s.gain * 100).toFixed(2)})</span>
          ${added ? `<span class="suggest-row__score">added</span>` : `<button class="btn btn-secondary btn-small" type="button" data-add="${i}" title="Add this line to the study, with the moves above it leads through">Add</button>`}
        </li>`;
      })
      .join("");
    const pending = suggestions.some((s) => nodeOfLine(s.line) === undefined);
    suggestAddAllBtn.hidden = suggestRunning || !pending;
    suggestClearBtn.hidden = suggestRunning || !suggestions.length;
    suggestOneBtn.disabled = suggestRunBtn.disabled = suggestRunning;
    suggestStopBtn.hidden = !suggestRunning;
  }

  async function suggest(oneOnly: boolean): Promise<void> {
    if (suggestRunning) return;
    const side = currentSide();
    const scope = (document.querySelector('input[name="suggest-scope"]:checked') as HTMLInputElement).value;
    const goal = (document.querySelector('input[name="suggest-goal"]:checked') as HTMLInputElement).value;
    // The score is always the whole study's; "here" only restricts where
    // moves are added.
    const start = effectiveStart();
    const within = scope === "here" ? currentId : null;
    const leaf = settings.leafValue ?? "explorer";
    const depth = figuresDepth();
    const level = (document.getElementById("suggest-level") as HTMLSelectElement).value;
    const maxLoss = level === "custom" ? (document.getElementById("suggest-max-loss") as HTMLInputElement).value : level;
    let engine: Engine | null = null;
    const status = (text: string) => (suggestStatusEl.textContent = text);
    const suggester = new Suggester(tree, {
      side,
      startNodeId: start,
      within,
      leafValue: leaf,
      candidates: Math.max(1, suggestNumber("suggest-candidates") || 6),
      minGames: Math.max(1, suggestNumber("suggest-min-games") || 1),
      minReach: Math.max(0, suggestNumber("suggest-min-reach") || 0) / 100,
      maxLoss: maxLoss ? Number(maxLoss) : null,
      explorer: (fen) =>
        fetchExplorerData(fen, settings, side, {
          priority: "background",
          onRateLimited: (resumeAt) =>
            status(`Lichess asked to wait; resuming at ${new Date(resumeAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}…`),
        }),
      evaluate: async (fen) => {
        const evaluations = await evaluationCache();
        const saved = await evaluations.get(fen, depth);
        if (saved !== undefined) return saved;
        engine ??= new Engine();
        const cp = await evaluatePosition(engine, new Chess(fen), depth);
        if (cp !== null) await evaluations.set(fen, depth, cp);
        return cp;
      },
      onStatus: status,
    });
    // The earlier suggestions not added yet stay in the copy, so the next
    // ones build on them.
    for (const s of suggestions) if (nodeOfLine(s.line) === undefined) addLine(suggester.tree, s.line);
    suggestRunning = true;
    suggestStop = false;
    renderSuggestions();
    const target = suggestNumber("suggest-target") / 100;
    const limit = oneOnly ? 1 : goal === "moves" ? Math.max(1, suggestNumber("suggest-moves") || 1) : 200;
    let added = 0;
    let message = "";
    try {
      let score = (await suggester.total()).score;
      if (!oneOnly && goal === "target" && score >= target) {
        message = `The expected score is already ${(score * 100).toFixed(2)}%.`;
      }
      while (!message && added < limit && !suggestStop) {
        const next = await suggester.next(() => suggestStop);
        if (!next) {
          if (!suggestStop) message = "No move raises the expected score any more (within the limits under Advanced).";
          break;
        }
        suggestions.push(next);
        added += 1;
        score = next.score;
        renderSuggestions();
        if (!oneOnly && goal === "target" && score >= target) message = `Reached ${(score * 100).toFixed(2)}%.`;
      }
      status(message || (suggestStop ? "Stopped." : `${added} move${added === 1 ? "" : "s"} suggested: expected score ${(score * 100).toFixed(2)}%.`));
    } catch (err) {
      status(errorMessage(err) ?? "Couldn't read the Explorer data.");
    } finally {
      (engine as Engine | null)?.terminate();
      suggestRunning = false;
      renderSuggestions();
    }
  }

  function addSuggestion(index: number): boolean {
    const nodeId = addLine(tree, suggestions[index].line);
    if (nodeId === null) {
      suggestStatusEl.textContent = "That line passes through a position where you already have another move.";
      return false;
    }
    return true;
  }

  const suggestLevel = document.getElementById("suggest-level") as HTMLSelectElement;
  suggestLevel.addEventListener("change", () => {
    (document.getElementById("suggest-max-loss-field") as HTMLElement).hidden = suggestLevel.value !== "custom";
  });
  suggestOneBtn.addEventListener("click", () => void suggest(true));
  suggestRunBtn.addEventListener("click", () => void suggest(false));
  suggestStopBtn.addEventListener("click", () => {
    suggestStop = true;
    suggestStatusEl.textContent = "Stopping…";
  });
  suggestClearBtn.addEventListener("click", () => {
    suggestions = [];
    suggestStatusEl.textContent = "";
    renderSuggestions();
  });
  suggestAddAllBtn.addEventListener("click", () => {
    let last: number | undefined;
    suggestions.forEach((s, i) => {
      if (nodeOfLine(s.line) === undefined && addSuggestion(i)) last = nodeOfLine(s.line);
    });
    if (last !== undefined) {
      goTo(last);
      scheduleAutoSave();
    }
    renderSuggestions();
  });
  suggestListEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const add = target.closest<HTMLElement>("[data-add]");
    if (add) {
      const index = Number(add.dataset.add);
      if (addSuggestion(index)) {
        goTo(nodeOfLine(suggestions[index].line)!);
        scheduleAutoSave();
      }
      renderSuggestions();
      return;
    }
    const row = target.closest<HTMLElement>("[data-index]");
    if (!row) return;
    const line = suggestions[Number(row.dataset.index)].line;
    const nodeId = nodeOfLine(line);
    if (nodeId !== undefined) return goTo(nodeId);
    // Not in the study: shown on the board until you move on, with no
    // moves possible there.
    const chess = new Chess();
    let lastMove: Key[] = [];
    for (const san of line) {
      const move = chess.move(san);
      lastMove = [move.from as Key, move.to as Key];
    }
    board.set({ fen: chess.fen(), turnColor: toColor(chess), check: chess.isCheck(), lastMove, movable: { color: undefined, dests: new Map() } });
  });

  board = createBoard(boardEl, onMove, boardOrientation);
  board.set({ drawable: { brushes: { ...board.state.drawable.brushes, ...QUALITY_BRUSHES } } });
  syncOrientation();
  applyToolsUI();
  flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  goToStart();
  void checkUnfetched();

  function flipBoard(): void {
    boardOrientation = boardOrientation === "white" ? "black" : "white";
    boardOrientationManuallySet = true;
    board.set({ orientation: boardOrientation });
    syncOrientation();
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
    // default (the real root). See doc/starting-point.md.
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

  function setStartPoint(nodeId: number | null): void {
    startNodeId = nodeId;
    renderTreeView();
    updateStartPointUI();
    scheduleAutoSave(0);
  }

  document.getElementById("start-point-btn")?.addEventListener("click", () => {
    setStartPoint(currentId === startNodeId ? null : currentId);
  });

  deleteStudyBtn.addEventListener("click", () => void deleteStudy());
  document.getElementById("export-study-btn")!.addEventListener("click", async () => {
    studyMenuEl.open = false;
    let games: { section: string; pgn: string; comment: string }[] = [];
    try {
      const res = await fetch(`/api/studies/${studyId}/games`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      games = (await res.json()).games;
    } catch {
      setSaveStatus("Could not export: the study's games could not be loaded.", true);
      return;
    }
    downloadStudyFile({ name: savedName, side: currentSide(), tree, startNodeId, explorerSettings: settings, games });
  });
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
      syncOrientation();
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

  // The previous (-1) or next (1) variation; nothing at either end.
  function switchVariation(step: -1 | 1): void {
    const target = siblingVariation(tree, currentId, step);
    if (target !== undefined) goTo(target);
  }

  // Lichess-style keyboard navigation: Left/Right step through the line
  // you're currently viewing, Up/Down go to the previous/next variation,
  // Shift+Up jumps to the start, Shift+Down to the end, Delete/Backspace removes
  // the selected move (same as lichess's own study editor), c opens the
  // comment box, f flips the board.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && !keyboardHelpPanel.hidden) {
      e.preventDefault();
      closeKeyboardHelp(true);
      return;
    }
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (focusMode.handleKey(e)) return;

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
        if (e.shiftKey) goToStart();
        else switchVariation(-1);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (e.shiftKey) goToLineEnd();
        else switchVariation(1);
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        deleteCurrentMove();
        break;
      case "c":
      case "C":
        // Opens the comment box (or goes back to it) without typing the c.
        e.preventDefault();
        commentRequested = true;
        updateCommentEditor();
        commentInputEl.focus();
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
  if (existing?.broken) {
    main.innerHTML = `<div class="empty-state"><h1>${escapeHtml(existing.name)}</h1>${brokenStudyHtml(existing.broken)}<a class="btn btn-secondary" href="/">Back to studies</a></div>`;
    return;
  }

  renderEditor(main, existing, explorerDefaults, getNewStudySide());
}

init();
