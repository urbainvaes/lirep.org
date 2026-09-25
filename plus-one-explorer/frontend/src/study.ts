import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyLichessBoardTheme, computeDests, createBoard, toColor } from "./board";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { addMove, createEmptyTree, deleteSubtree, renderTree, sanPathTo, type StudyTree } from "./tree";

interface Study {
  id: number;
  name: string;
  tree: StudyTree;
}

function getStudyId(): number | null {
  const id = new URLSearchParams(window.location.search).get("id");
  return id ? Number(id) : null;
}

async function loadStudy(id: number): Promise<Study | null> {
  const res = await fetch(`/api/studies/${id}`, { credentials: "same-origin" });
  return res.ok ? res.json() : null;
}

async function saveStudy(id: number | null, name: string, tree: StudyTree): Promise<Study | null> {
  const res = await fetch(id ? `/api/studies/${id}` : "/api/studies", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name, tree }),
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

function renderEditor(main: HTMLElement, existing: Study | null): void {
  main.innerHTML = `
    <div class="study-editor">
      <input
        id="study-name"
        class="study-name-input"
        type="text"
        placeholder="Name this study"
        value="${existing ? escapeHtml(existing.name) : ""}"
      />
      <div class="study-board-row">
        <div id="board" class="study-board"></div>
        <div class="study-side">
          <div id="tree-view" class="tree-view"></div>
          <p class="tree-hint">Click a move to jump there. Play a different move from any point to start a variation.</p>
          <div class="study-actions">
            <button id="start-btn" class="btn btn-secondary" type="button">Go to start</button>
            <button id="delete-btn" class="btn btn-secondary" type="button">Delete this move</button>
          </div>
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
  const nameInput = document.getElementById("study-name") as HTMLInputElement;
  const errorEl = document.getElementById("study-error") as HTMLElement;
  const deleteBtn = document.getElementById("delete-btn") as HTMLButtonElement;

  const tree: StudyTree = existing?.tree ?? createEmptyTree();
  let currentId = tree.rootId;
  let board: Api;

  function onMove(orig: Key, dest: Key): void {
    const chess = positionAt(tree, currentId);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    goTo(addMove(tree, currentId, move.san));
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

  document.getElementById("save-btn")?.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    errorEl.hidden = true;
    if (!name) {
      errorEl.textContent = "Please name this study.";
      errorEl.hidden = false;
      return;
    }
    const saved = await saveStudy(existing?.id ?? null, name, tree);
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
  const [existing] = await Promise.all([
    studyId ? loadStudy(studyId) : Promise.resolve(null),
    applyBoardTheme(),
  ]);
  if (studyId && !existing) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  renderEditor(main, existing);
}

init();
