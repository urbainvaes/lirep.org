import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";
import { applyBoardTheme, createBoard, toColor } from "./board";
import { Engine, formatScore, RANK_BRUSHES, uciMoveToKeys, type EngineAnalysis } from "./engine";
import {
  explorerUrl,
  renderExplorer,
  renderExplorerError,
  renderExplorerLoading,
  type ExplorerData,
  type ExplorerSettings,
} from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { lastMoveAt, lichessAnalysisUrl, pathTo, positionAt, renderTree, sanPathTo, type StudyTree } from "./tree";

// A read-only viewer for a shared opening: browse its lines, nothing else.
// Moves on the board are not accepted (no free play); the Explorer and
// Stockfish are off until the visitor switches them on, and those switches are
// local to this page. See /api/community/studies/{id}.

interface SharedOpening {
  id: number;
  name: string;
  side: "white" | "black";
  owner: string;
  mine: boolean;
  tree: StudyTree;
  startNodeId: number | null;
  explorerSettings: ExplorerSettings;
}

// Legend dot colors matching the RANK_BRUSHES arrows (best green -> worst red).
const RANK_LEGEND_COLORS = ["#15781B", "#6fae54", "#e68f00", "#b56a5a", "#882020"];

function uciToSan(chess: Chess, uci: string): string {
  const clone = new Chess(chess.fen());
  const move = clone.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  return move ? move.san : uci;
}

function render(main: HTMLElement, opening: SharedOpening, signedIn: boolean): void {
  const { tree, side } = opening;
  const startNodeId = opening.startNodeId !== null && opening.startNodeId in tree.nodes ? opening.startNodeId : null;

  main.innerHTML = `
    <p class="doc-intro"><a class="community-owner" href="/player.html?u=${encodeURIComponent(opening.owner)}">← ${escapeHtml(opening.owner)}</a></p>
    <div class="study-editor">
      <div class="study-name-row">
        <h1 class="opening-title">${escapeHtml(opening.name)}</h1>
        <span class="study-color-badge">${side === "white" ? "Playing White" : "Playing Black"}</span>
        <button id="flip-board-btn" class="board-flip-btn" type="button" data-icon="" title="Flip board" aria-label="Flip board"></button>
      </div>
      <div class="study-grid">
        <div class="study-card study-card--board">
          <div id="board" class="study-board"></div>
        </div>

        <div class="study-card study-card--moves">
          <div id="tree-view" class="tree-view"></div>
          <p id="opening-comment" class="opening-comment" hidden></p>
          <div class="study-actions">
            <a id="open-lichess-analysis" class="btn btn-secondary study-icon-btn" data-icon="" aria-label="Open position in Lichess analysis" title="Open position in Lichess analysis" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer"></a>
            <button id="start-btn" class="btn btn-secondary" type="button">Go to start</button>
          </div>
        </div>

        <div class="study-card study-card--explorer">
          <div class="analysis-header">
            <label class="explorer-toggle">
              <input type="checkbox" id="explorer-enabled" aria-label="Opening Explorer" />
              <span class="analysis-label" data-icon="" aria-hidden="true">Opening Explorer</span>
            </label>
          </div>
          <div id="explorer-panel" class="explorer-panel" hidden></div>
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
      <div class="opening-footer" id="opening-footer"></div>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const treeViewEl = document.getElementById("tree-view") as HTMLElement;
  const commentEl = document.getElementById("opening-comment") as HTMLElement;
  const explorerEnabledEl = document.getElementById("explorer-enabled") as HTMLInputElement;
  const explorerPanelEl = document.getElementById("explorer-panel") as HTMLElement;
  const engineEnabledEl = document.getElementById("engine-enabled") as HTMLInputElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const flipBoardBtn = document.getElementById("flip-board-btn") as HTMLButtonElement;
  const lichessAnalysisLink = document.getElementById("open-lichess-analysis") as HTMLAnchorElement;

  let currentId = tree.rootId;
  let board: Api;
  let boardOrientation: "white" | "black" = side;
  let explorerRequestId = 0;
  let engine: Engine | null = null;
  let engineAnalysisId = 0;
  // Which child was last followed from each node, so the arrow keys continue
  // along the variation being viewed, as in the editor.
  const lastChild: Record<number, number> = {};

  /** Plays a move only if the opening already has it here (no free moves). */
  function followSan(san: string): void {
    const childId = tree.nodes[currentId].children.find((id) => tree.nodes[id].san === san);
    if (childId !== undefined) goTo(childId);
  }

  async function updateExplorer(fen: string): Promise<void> {
    if (!explorerEnabledEl.checked) {
      explorerPanelEl.hidden = true;
      return;
    }
    explorerPanelEl.hidden = false;
    if (!signedIn) {
      explorerPanelEl.innerHTML = `<p class="explorer-empty"><a href="/auth/login">Sign in</a> to use the Opening Explorer.</p>`;
      return;
    }
    const requestId = ++explorerRequestId;
    renderExplorerLoading(explorerPanelEl);
    try {
      const res = await fetch(explorerUrl(fen, opening.explorerSettings, side), { credentials: "same-origin" });
      if (requestId !== explorerRequestId) return;
      if (!res.ok) {
        renderExplorerError(explorerPanelEl);
        return;
      }
      const data: ExplorerData = await res.json();
      if (requestId !== explorerRequestId) return;
      renderExplorer(explorerPanelEl, data, followSan);
    } catch {
      if (requestId === explorerRequestId) renderExplorerError(explorerPanelEl);
    }
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
          <button class="engine-line" type="button" data-san="${escapeHtml(san)}">
            <span class="engine-line__dot" style="background:${color}"></span>
            <span class="engine-line__san">${escapeHtml(san)}</span>
            <span class="engine-line__score">${escapeHtml(score)}</span>
          </button>
        `;
      })
      .join("");

    enginePanelEl.querySelectorAll<HTMLButtonElement>("[data-san]").forEach((btn) => {
      btn.addEventListener("click", () => followSan(btn.dataset.san as string));
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
    renderTreeView();
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
    flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  }

  board = createBoard(boardEl, () => {}, boardOrientation);
  flipBoardBtn.title = `Flip board — f (${boardOrientation === "white" ? "White" : "Black"} at bottom)`;
  goToStart();

  flipBoardBtn.addEventListener("click", flipBoard);
  document.getElementById("start-btn")?.addEventListener("click", goToStart);
  explorerEnabledEl.addEventListener("change", () => void updateExplorer(positionAt(tree, currentId).fen()));
  engineEnabledEl.addEventListener("change", () => {
    const chess = positionAt(tree, currentId);
    if (engineEnabledEl.checked) {
      void updateEngine(chess);
    } else {
      engineAnalysisId++;
      board.set({ drawable: { autoShapes: [] } });
      engineStatusEl.textContent = "";
      enginePanelEl.hidden = true;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const fromEngineToggle = target === engineEnabledEl && e.key.startsWith("Arrow");
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) && !fromEngineToggle) return;
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
    }
  });

  // Import (a private copy in your own studies), at the bottom of the page.
  const footer = document.getElementById("opening-footer") as HTMLElement;
  if (opening.mine) {
    footer.innerHTML = `<a class="btn btn-secondary" href="/study.html?id=${opening.id}">Edit this opening</a>`;
  } else if (!signedIn) {
    footer.innerHTML = `<a class="btn btn-secondary" href="/auth/login">Sign in to import</a>`;
  } else {
    footer.innerHTML = `
      <button id="import-btn" class="btn btn-primary" type="button">Import to my studies</button>
      <span id="import-message" class="opening-import-message" role="status" aria-live="polite"></span>`;
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
