import type { Api } from "@lichess-org/chessground/api";
import { Chess } from "chess.js";
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
  sanToUci,
  toolTabsHtml,
  type Tool,
} from "./analysisTools";
import { applyBoardTheme, createBoard, toColor } from "./board";
import { Engine, whiteGaugeShare, type EngineAnalysis } from "./engine";
import {
  explorerSummary,
  renderExplorer,
  renderExplorerError,
  renderExplorerLoading,
  type ExplorerSettings,
} from "./explorer";
import { errorMessage, fetchExplorerData } from "./explorerClient";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { materialBalance, materialHtml } from "./material";
import { lastMoveAt, lichessAnalysisUrl, pathTo, positionAt, renderTree, sanPathTo, type StudyTree } from "./tree";

// A read-only viewer for a shared opening: browse its lines, nothing else.
// It is laid out like the study editor, with the same board column and tools
// (whose on/off switches and Stockfish depth it shares with the editor), but
// moves on the board are not accepted (no free play) and the Explorer uses
// the author's settings. See /api/community/studies/{id}.

interface SharedOpening {
  id: number;
  name: string;
  side: "white" | "black";
  owner: string | null;
  anonymous: boolean;
  mine: boolean;
  tree: StudyTree;
  startNodeId: number | null;
  explorerSettings: ExplorerSettings;
}

function render(main: HTMLElement, opening: SharedOpening, signedIn: boolean): void {
  const { tree, side } = opening;
  const startNodeId = opening.startNodeId !== null && opening.startNodeId in tree.nodes ? opening.startNodeId : null;
  const startPoint = describeStartPoint(tree, startNodeId);
  const sideLabel = side === "white" ? "Playing White" : "Playing Black";
  const byline =
    opening.owner === null
      ? `by an anonymous player`
      : `by <a class="community-owner" href="/player.html?u=${encodeURIComponent(opening.owner)}">${escapeHtml(opening.owner)}</a>`;

  main.classList.add("site-main--board");
  main.innerHTML = `
    <div class="study-editor study-editor--edit">
      <header class="study-head">
        <div class="study-head__title">
          <span class="side-pawn side-pawn--${side} study-head__side" title="${sideLabel}" aria-label="${sideLabel}">${side === "white" ? "♙" : "♟"}</span>
          <h1 class="study-title opening-title">${escapeHtml(opening.name)}</h1>
          ${startPoint ? `<button id="study-start-badge" class="study-start-badge" type="button" title="Go to the starting point">${escapeHtml(startPoint)}</button>` : ""}
          <span class="study-save-status">${byline}</span>
        </div>
        <div class="study-head__links" id="opening-footer"></div>
      </header>

      <div class="study-grid">
        ${boardColumnHtml()}

        <div class="study-side-col">
          <div class="study-side-col__inner">
            <div class="study-card study-card--moves">
              <div class="study-actions">
                <a id="open-lichess-analysis" class="btn btn-secondary study-icon-btn" data-icon="&#xe05f;" aria-label="Open position in Lichess analysis" title="Open position in Lichess analysis" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer"></a>
                <button id="keyboard-help-btn" class="btn btn-secondary study-keyboard-help-btn" type="button" aria-label="Show keyboard shortcuts" aria-expanded="false" aria-controls="keyboard-help">?</button>
              </div>
              <div id="keyboard-help" class="study-keyboard-help" role="region" aria-label="Keyboard shortcuts" tabindex="-1" hidden>
                <p class="study-keyboard-help__title">Keyboard shortcuts</p>
                <p class="study-keyboard-help__intro">Click a move to jump there. This opening is read-only: import it to change it.</p>
                <ul>
                  <li><kbd>←</kbd> / <kbd>→</kbd> Previous / next move</li>
                  <li><kbd>↑</kbd> / <kbd>↓</kbd> Start / end of line</li>
                  <li><kbd>F</kbd> Flip the board</li>
                  <li><kbd>?</kbd> Show / hide these shortcuts</li>
                </ul>
              </div>
              <div id="tree-view" class="tree-view"></div>
              <p id="opening-comment" class="opening-comment" hidden></p>
            </div>

            <div class="study-card study-card--tools">
              <div id="tool-explorer" class="tool-panel tool-panel--explorer">
                <div class="explorer-settings-line">
                  <span title="The author's Explorer settings">${escapeHtml(explorerSummary(opening.explorerSettings))}</span>
                </div>
                <div id="explorer-panel" class="explorer-panel"></div>
              </div>

              ${toolTabsHtml()}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const treeViewEl = document.getElementById("tree-view") as HTMLElement;
  const commentEl = document.getElementById("opening-comment") as HTMLElement;
  const explorerPanelEl = document.getElementById("explorer-panel") as HTMLElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const engineDepthEl = document.getElementById("engine-depth") as HTMLElement;
  const depthDownBtn = document.getElementById("depth-down") as HTMLButtonElement;
  const depthUpBtn = document.getElementById("depth-up") as HTMLButtonElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const flipBoardBtn = document.getElementById("flip-board-btn") as HTMLButtonElement;
  const lichessAnalysisLink = document.getElementById("open-lichess-analysis") as HTMLAnchorElement;
  const keyboardHelpButton = document.getElementById("keyboard-help-btn") as HTMLButtonElement;
  const keyboardHelpPanel = document.getElementById("keyboard-help") as HTMLElement;
  const gaugeEl = document.getElementById("eval-gauge") as HTMLElement;
  const gaugeBlackEl = document.getElementById("eval-gauge-black") as HTMLElement;
  const materialTopEl = document.getElementById("material-top") as HTMLElement;
  const materialBottomEl = document.getElementById("material-bottom") as HTMLElement;
  const navStartBtn = document.getElementById("nav-start") as HTMLButtonElement;
  const navBackBtn = document.getElementById("nav-back") as HTMLButtonElement;
  const navForwardBtn = document.getElementById("nav-forward") as HTMLButtonElement;
  const navEndBtn = document.getElementById("nav-end") as HTMLButtonElement;
  const tabButtons = {
    explorer: document.getElementById("tab-explorer") as HTMLButtonElement,
    engine: document.getElementById("tab-engine") as HTMLButtonElement,
  };
  const tabPanels = {
    explorer: document.getElementById("tool-explorer") as HTMLElement,
    engine: document.getElementById("tool-engine") as HTMLElement,
  };

  let currentId = tree.rootId;
  let board: Api;
  let boardOrientation: "white" | "black" = side;
  let explorerRequestId = 0;
  let engine: Engine | null = null;
  let engineAnalysisId = 0;
  let engineDepth = getSavedEngineDepth();
  const shownTools: Set<Tool> = getSavedTools();
  // Which child was last followed from each node, so the arrow keys continue
  // along the variation being viewed, as in the editor.
  const lastChild: Record<number, number> = {};

  /** Plays a move only if the opening already has it here (no free moves). */
  function followSan(san: string): void {
    const childId = tree.nodes[currentId].children.find((id) => tree.nodes[id].san === san);
    if (childId !== undefined) goTo(childId);
  }

  function explorerData(fen: string) {
    return fetchExplorerData(fen, opening.explorerSettings, side, { priority: "interactive" });
  }

  async function updateExplorer(fen: string): Promise<void> {
    if (!shownTools.has("explorer")) return;
    if (!signedIn) {
      explorerPanelEl.innerHTML = `<p class="explorer-empty"><a href="/auth/login">Sign in</a> to use the Opening Explorer.</p>`;
      return;
    }
    const requestId = ++explorerRequestId;
    renderExplorerLoading(explorerPanelEl);
    try {
      const data = await explorerData(fen);
      if (requestId !== explorerRequestId) return;
      const chess = positionAt(tree, currentId);
      renderExplorer(explorerPanelEl, data, followSan, {
        inTree: new Set(tree.nodes[currentId].children.map((id) => tree.nodes[id].san as string)),
        yourTurn: (chess.turn() === "w") === (side === "white"),
      });
    } catch (err) {
      if (requestId === explorerRequestId) renderExplorerError(explorerPanelEl, errorMessage(err));
    }
  }

  // Lichess's evaluation gauge, beside the board while Stockfish is on:
  // White's share fills from White's side of the board, so it flips with it.
  function setGauge(whiteShare: number): void {
    gaugeBlackEl.style.height = `${(1 - whiteShare) * 100}%`;
    gaugeEl.setAttribute("aria-label", `Evaluation: White ${Math.round(whiteShare * 100)}%`);
  }

  function renderMaterial(): void {
    const balance = materialBalance(positionAt(tree, currentId));
    const bottom = boardOrientation === "white" ? "w" : "b";
    const top = bottom === "w" ? "b" : "w";
    materialTopEl.innerHTML = materialHtml(balance[top]);
    materialBottomEl.innerHTML = materialHtml(balance[bottom]);
  }

  function syncOrientation(): void {
    gaugeEl.classList.toggle("eval-gauge--flipped", boardOrientation === "black");
    renderMaterial();
  }

  // Stockfish's top lines for the last position analysed, reused when only
  // the Explorer is turned on or off.
  let topLines: { fen: string; depth: number; analysis: EngineAnalysis } | null = null;

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
    const explorerRequest =
      shownTools.has("explorer") && signedIn ? explorerData(fen).catch(() => null) : Promise.resolve(null);

    const depth = engineDepth;
    let analysis = topLines?.fen === fen && topLines.depth === depth ? topLines.analysis : null;
    if (!analysis) {
      engineStatusEl.textContent = `depth ${depth}…`;
      analysis = await engine.analyze(fen, depth);
      if (stale()) return;
      topLines = { fen, depth, analysis };
    }
    setGauge(whiteGaugeShare(analysis.lines[0], chess.turn() === "w"));

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

    const { shapes, chipsHtml } = engineMovesView(chess, lines, shares, "Evaluation of");
    board.set({ drawable: { autoShapes: shapes } });
    engineStatusEl.textContent = `depth ${depth}`;
    engineStatusEl.title = "Stockfish's search depth, in this browser";
    enginePanelEl.innerHTML = chipsHtml;

    // Only the opening's own moves can be followed from a chip.
    const inTree = new Set(tree.nodes[currentId].children.map((id) => sanToUci(chess, tree.nodes[id].san as string)));
    enginePanelEl.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((btn) => {
      const uci = btn.dataset.move as string;
      if (!inTree.has(uci)) {
        btn.disabled = true;
        return;
      }
      btn.addEventListener("click", () => {
        const childId = tree.nodes[currentId].children.find((id) => sanToUci(chess, tree.nodes[id].san as string) === uci);
        if (childId !== undefined) goTo(childId);
      });
    });
  }

  function renderTreeView(): void {
    treeViewEl.innerHTML = renderTree(tree, currentId, side, startNodeId);
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

  function goTo(nodeId: number): void {
    const path = pathTo(tree, nodeId);
    for (let i = 0; i < path.length - 1; i++) lastChild[path[i].id] = path[i + 1].id;

    currentId = nodeId;
    const chess = positionAt(tree, currentId);
    const comment = tree.nodes[currentId].comment;
    commentEl.hidden = !comment;
    commentEl.textContent = comment ?? "";

    const line = sanPathTo(tree, currentId);
    let next = lastChild[currentId] ?? tree.nodes[currentId].children[0];
    let lineEnd = currentId;
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
      // Read-only: nothing on the board can be moved.
      movable: { color: undefined, dests: new Map() },
    });
    renderMaterial();
    renderTreeView();
    navBackBtn.disabled = navStartBtn.disabled = currentId === tree.rootId;
    navForwardBtn.disabled = navEndBtn.disabled = tree.nodes[currentId].children.length === 0;
    void updateExplorer(chess.fen());
    void updateEngine(chess);
  }

  function stepBack(): void {
    const parentId = tree.nodes[currentId].parentId;
    if (parentId !== null) goTo(parentId);
  }

  function stepForward(): void {
    const next = lastChild[currentId] ?? tree.nodes[currentId].children[0];
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

  function goToStart(): void {
    goTo(startNodeId ?? tree.rootId);
  }

  function flipBoard(): void {
    boardOrientation = boardOrientation === "white" ? "black" : "white";
    board.set({ orientation: boardOrientation });
    syncOrientation();
    flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  }

  function applyToolsUI(): void {
    for (const name of ["explorer", "engine"] as const) {
      tabButtons[name].setAttribute("aria-pressed", String(shownTools.has(name)));
      tabPanels[name].hidden = !shownTools.has(name);
    }
    gaugeEl.hidden = !shownTools.has("engine");
    engineDepthEl.hidden = !shownTools.has("engine");
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
    const chess = positionAt(tree, currentId);
    if (tool === "engine" && !shownTools.has("engine")) {
      // Stockfish stops when turned off: it is the expensive one.
      engineAnalysisId++;
      board.set({ drawable: { autoShapes: [] } });
      engineStatusEl.textContent = "";
      enginePanelEl.innerHTML = "";
      setGauge(0.5);
      engine?.terminate();
      engine = null;
      return;
    }
    if (tool === "explorer" && !shownTools.has("explorer")) {
      explorerRequestId++; // drop a response still on its way
      explorerPanelEl.innerHTML = "";
    }
    void updateExplorer(chess.fen());
    // Stockfish's arrow widths follow the Explorer's frequencies.
    void updateEngine(chess);
  }

  function setEngineDepth(depth: number): void {
    engineDepth = Math.min(ENGINE_DEPTH_MAX, Math.max(ENGINE_DEPTH_MIN, depth));
    depthDownBtn.disabled = engineDepth <= ENGINE_DEPTH_MIN;
    depthUpBtn.disabled = engineDepth >= ENGINE_DEPTH_MAX;
    depthDownBtn.title = `Depth ${Math.max(ENGINE_DEPTH_MIN, engineDepth - ENGINE_DEPTH_STEP)}`;
    depthUpBtn.title = `Depth ${Math.min(ENGINE_DEPTH_MAX, engineDepth + ENGINE_DEPTH_STEP)}`;
    saveEngineDepth(engineDepth);
  }

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
    keyboardHelpPanel.hidden = false;
    keyboardHelpButton.setAttribute("aria-expanded", "true");
    keyboardHelpButton.setAttribute("aria-label", "Hide keyboard shortcuts");
    keyboardHelpPanel.focus();
  }

  board = createBoard(boardEl, () => {}, boardOrientation);
  board.set({ drawable: { brushes: { ...board.state.drawable.brushes, ...QUALITY_BRUSHES } } });
  flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  setEngineDepth(engineDepth);
  syncOrientation();
  applyToolsUI();
  goToStart();

  flipBoardBtn.addEventListener("click", flipBoard);
  navStartBtn.addEventListener("click", goToStart);
  navBackBtn.addEventListener("click", stepBack);
  navForwardBtn.addEventListener("click", stepForward);
  navEndBtn.addEventListener("click", goToLineEnd);
  document.getElementById("study-start-badge")?.addEventListener("click", goToStart);
  tabButtons.explorer.addEventListener("click", () => toggleTool("explorer"));
  tabButtons.engine.addEventListener("click", () => toggleTool("engine"));
  depthDownBtn.addEventListener("click", () => {
    setEngineDepth(engineDepth - ENGINE_DEPTH_STEP);
    void updateEngine(positionAt(tree, currentId));
  });
  depthUpBtn.addEventListener("click", () => {
    setEngineDepth(engineDepth + ENGINE_DEPTH_STEP);
    void updateEngine(positionAt(tree, currentId));
  });
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

  // Import (a private copy in your own studies), where the editor has its links.
  const footer = document.getElementById("opening-footer") as HTMLElement;
  if (opening.mine) {
    footer.innerHTML = `<a class="study-head__link" href="/study.html?id=${opening.id}">Edit this opening</a>`;
  } else if (!signedIn) {
    footer.innerHTML = `<a class="study-head__link" href="/auth/login">Sign in to import</a>`;
  } else {
    footer.innerHTML = `
      <span id="import-message" class="opening-import-message" role="status" aria-live="polite"></span>
      <button id="import-btn" class="study-head__link" type="button">Import to my studies</button>`;
    const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
    const message = document.getElementById("import-message") as HTMLElement;
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      try {
        const res = await fetch(`/api/community/import/${opening.id}`, { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const study = await res.json();
        importBtn.textContent = "Imported";
        message.innerHTML = `Added to your studies. <a href="/study.html?id=${study.id}">Open it</a>`;
      } catch {
        importBtn.disabled = false;
        message.textContent = "Could not import this opening. Please try again.";
      }
    });
  }
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("opening-main");
  if (!main) return;

  const id = Number(new URLSearchParams(window.location.search).get("id"));
  if (!id) {
    main.innerHTML = `<div class="empty-state"><p>No opening selected.</p><a class="btn btn-secondary" href="/community.html">Community</a></div>`;
    return;
  }

  try {
    const [res] = await Promise.all([fetch(`/api/community/studies/${id}`, { credentials: "same-origin" }), applyBoardTheme()]);
    if (res.status === 404) {
      main.innerHTML = `<div class="empty-state"><p>This opening is not shared (or no longer is).</p><a class="btn btn-secondary" href="/community.html">Community</a></div>`;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    render(main, await res.json(), me.authenticated);
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load this opening. Please try again in a moment.</p></div>`;
  }
}

init();
