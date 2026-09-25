import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyLichessBoardTheme, computeDests, createBoard, toColor } from "./board";
import { Engine, formatScore, RANK_BRUSHES, uciMoveToKeys, type EngineAnalysis } from "./engine";
import {
  DEFAULT_EXPLORER_SETTINGS,
  explorerUrl,
  fetchExplorerDefaults,
  renderExplorer,
  renderExplorerError,
  renderExplorerLoading,
  type ExplorerData,
  type ExplorerDefaults,
  type ExplorerSettings,
  type ExplorerSpeed,
} from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { addMove, createEmptyTree, deleteSubtree, renderTree, sanPathTo, type StudyTree } from "./tree";

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
}

function getStudyId(): number | null {
  const id = new URLSearchParams(window.location.search).get("id");
  return id ? Number(id) : null;
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
): Promise<Study | null> {
  const res = await fetch(id ? `/api/studies/${id}` : "/api/studies", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name, tree, explorerSettings, side }),
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

function positionAt(tree: StudyTree, nodeId: number): Chess {
  const chess = new Chess();
  for (const san of sanPathTo(tree, nodeId)) chess.move(san);
  return chess;
}

// Legend dot colors for the move list, matching the green (best) -> red
// (worst) gradient of the RANK_BRUSHES arrow colors on the board.
const RANK_LEGEND_COLORS = ["#15781B", "#6fae54", "#e68f00", "#b56a5a", "#882020"];

function uciToSan(chess: Chess, uci: string): string {
  const clone = new Chess(chess.fen());
  const move = clone.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  return move ? move.san : uci;
}

function ratingOptionsHtml(buckets: number[], selected: number | null): string {
  const options = [`<option value="auto"${selected === null ? " selected" : ""}>My current rating</option>`];
  for (const bucket of buckets) {
    const label = bucket === 0 ? "Any rating" : `${bucket}+`;
    options.push(`<option value="${bucket}"${selected === bucket ? " selected" : ""}>${label}</option>`);
  }
  return options.join("");
}

const SPEED_LABELS: Record<ExplorerSpeed, string> = {
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  classical: "Classical",
};

function speedCheckboxesHtml(allSpeeds: ExplorerSpeed[], selected: ExplorerSpeed[], disabled: boolean): string {
  return allSpeeds
    .map(
      (speed) => `
        <label class="speed-checkbox">
          <input type="checkbox" value="${speed}" ${selected.includes(speed) ? "checked" : ""} ${disabled ? "disabled" : ""} />
          ${SPEED_LABELS[speed]}
        </label>
      `,
    )
    .join("");
}

function renderEditor(main: HTMLElement, existing: Study | null, explorerDefaults: ExplorerDefaults | null): void {
  const settings: ExplorerSettings = existing?.explorerSettings ?? { ...DEFAULT_EXPLORER_SETTINGS };
  const ratingBuckets = explorerDefaults?.ratingBuckets ?? [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
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
        <select id="study-color" class="study-color-select" title="Which side is this repertoire for?">
          <option value="white" ${(existing?.side ?? "white") === "white" ? "selected" : ""}>Playing White</option>
          <option value="black" ${existing?.side === "black" ? "selected" : ""}>Playing Black</option>
        </select>
      </div>
      <div class="study-grid">
        <div class="study-card study-card--board">
          <div id="board" class="study-board"></div>
        </div>

        <div class="study-card study-card--moves">
          <div id="tree-view" class="tree-view"></div>
          <p class="tree-hint">Click a move to jump there. Play a different move from any point to start a variation.</p>
          <div class="study-actions">
            <button id="start-btn" class="btn btn-secondary" type="button">Go to start</button>
            <button id="delete-btn" class="btn btn-secondary" type="button">Delete this move</button>
          </div>
        </div>

        <div class="study-card study-card--explorer">
          <div class="analysis-header">
            <label class="explorer-toggle">
              <input type="checkbox" id="explorer-enabled" ${settings.enabled ? "checked" : ""} />
              Opening Explorer
            </label>
            <div class="analysis-header__settings">
              <select id="explorer-database" ${settings.enabled ? "" : "disabled"}>
                <option value="lichess" ${settings.database === "lichess" ? "selected" : ""}>Players</option>
                <option value="masters" ${settings.database === "masters" ? "selected" : ""}>Masters</option>
              </select>
              <select
                id="explorer-min-rating"
                ${settings.enabled && settings.database === "lichess" ? "" : "disabled"}
              >
                ${ratingOptionsHtml(ratingBuckets, settings.minRating)}
              </select>
            </div>
          </div>
          <div class="speed-checkboxes" id="explorer-speeds">
            ${speedCheckboxesHtml(allSpeeds, settings.speeds, !settings.enabled || settings.database !== "lichess")}
          </div>
          <div id="explorer-panel" class="explorer-panel" ${settings.enabled ? "" : "hidden"}></div>
        </div>

        <div class="study-card study-card--engine">
          <div class="analysis-header">
            <label class="explorer-toggle">
              <input type="checkbox" id="engine-enabled" />
              Stockfish
            </label>
            <span id="engine-status" class="engine-eval"></span>
          </div>
          <div id="engine-panel" class="engine-panel" hidden></div>
        </div>
      </div>

      <div class="study-save-row">
        <a class="btn btn-secondary" href="/studies.html">Cancel</a>
        <button id="save-btn" class="btn btn-primary" type="button">Save</button>
      </div>
      <p id="study-error" class="study-error" hidden></p>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const treeViewEl = document.getElementById("tree-view") as HTMLElement;
  const explorerPanelEl = document.getElementById("explorer-panel") as HTMLElement;
  const explorerEnabledEl = document.getElementById("explorer-enabled") as HTMLInputElement;
  const explorerDatabaseEl = document.getElementById("explorer-database") as HTMLSelectElement;
  const explorerMinRatingEl = document.getElementById("explorer-min-rating") as HTMLSelectElement;
  const explorerSpeedsEl = document.getElementById("explorer-speeds") as HTMLElement;
  const engineEnabledEl = document.getElementById("engine-enabled") as HTMLInputElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const nameInput = document.getElementById("study-name") as HTMLInputElement;
  const colorSelect = document.getElementById("study-color") as HTMLSelectElement;
  const errorEl = document.getElementById("study-error") as HTMLElement;
  const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;

  const tree: StudyTree = existing?.tree ?? createEmptyTree();
  let currentId = tree.rootId;
  let board: Api;
  let explorerRequestId = 0;
  let engine: Engine | null = null;

  function playSan(san: string): void {
    const chess = positionAt(tree, currentId);
    const move = chess.move(san);
    if (!move) return;
    goTo(addMove(tree, currentId, move.san));
  }

  function onMove(orig: Key, dest: Key): void {
    const chess = positionAt(tree, currentId);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    goTo(addMove(tree, currentId, move.san));
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
      const res = await fetch(explorerUrl(fen, settings), { credentials: "same-origin" });
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
    goTo(addMove(tree, currentId, move.san));
  }

  async function updateEngine(chess: Chess): Promise<void> {
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

  function goTo(nodeId: number): void {
    currentId = nodeId;
    const chess = positionAt(tree, currentId);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      movable: { color: toColor(chess), dests: computeDests(chess) },
    });

    treeViewEl.innerHTML = renderTree(tree, currentId);
    treeViewEl.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
      el.addEventListener("click", () => goTo(Number(el.dataset.nodeId)));
    });
    deleteBtn.disabled = currentId === tree.rootId;
    void updateExplorer(chess.fen());
    void updateEngine(chess);
  }

  board = createBoard(boardEl, onMove);
  goTo(tree.rootId);

  document.getElementById("start-btn")?.addEventListener("click", () => goTo(tree.rootId));

  deleteBtn.addEventListener("click", () => {
    if (currentId === tree.rootId) return;
    const parentId = tree.nodes[currentId].parentId as number;
    deleteSubtree(tree, currentId);
    goTo(parentId);
  });

  function setSpeedControlsDisabled(disabled: boolean): void {
    explorerMinRatingEl.disabled = disabled;
    explorerSpeedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = disabled;
    });
  }

  explorerEnabledEl.addEventListener("change", () => {
    settings.enabled = explorerEnabledEl.checked;
    explorerDatabaseEl.disabled = !settings.enabled;
    setSpeedControlsDisabled(!settings.enabled || settings.database !== "lichess");
    void updateExplorer(positionAt(tree, currentId).fen());
  });

  explorerDatabaseEl.addEventListener("change", () => {
    settings.database = explorerDatabaseEl.value as ExplorerSettings["database"];
    setSpeedControlsDisabled(!settings.enabled || settings.database !== "lichess");
    void updateExplorer(positionAt(tree, currentId).fen());
  });

  explorerMinRatingEl.addEventListener("change", () => {
    settings.minRating = explorerMinRatingEl.value === "auto" ? null : Number(explorerMinRatingEl.value);
    void updateExplorer(positionAt(tree, currentId).fen());
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
  });

  engineEnabledEl.addEventListener("change", () => {
    if (engineEnabledEl.checked) {
      void updateEngine(positionAt(tree, currentId));
    } else {
      board.set({ drawable: { autoShapes: [] } });
      engineStatusEl.textContent = "";
      enginePanelEl.hidden = true;
      enginePanelEl.innerHTML = "";
      engine?.terminate();
      engine = null;
    }
  });

  document.getElementById("save-btn")?.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    errorEl.hidden = true;
    if (!name) {
      errorEl.textContent = "Please name this study.";
      errorEl.hidden = false;
      return;
    }
    const side = colorSelect.value as "white" | "black";
    const saved = await saveStudy(existing?.id ?? null, name, tree, settings, side);
    if (!saved) {
      errorEl.textContent = "Could not save. Please try again.";
      errorEl.hidden = false;
      return;
    }
    window.location.href = "/studies.html";
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

  renderEditor(main, existing, explorerDefaults);
}

init();
