import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { escapeHtml } from "./layout";

export interface TreeNode {
  id: number;
  san: string | null;
  parentId: number | null;
  children: number[];
  comment?: string;
}

export interface StudyTree {
  nodes: Record<number, TreeNode>;
  rootId: number;
  nextId: number;
}

export function createEmptyTree(): StudyTree {
  return {
    nodes: { 0: { id: 0, san: null, parentId: null, children: [] } },
    rootId: 0,
    nextId: 1,
  };
}

/** A Lichess analysis link to `line` (SAN moves from the initial position),
 * opened at its `ply`-th move: Lichess reads the ply from the #fragment and
 * would otherwise open a pasted line at its last move. */
export function lichessAnalysisUrl(line: string[], ply: number): string {
  return line.length
    ? `https://lichess.org/analysis/pgn/${line.map(encodeURIComponent).join("_")}#${ply}`
    : "https://lichess.org/analysis";
}

export function pathTo(tree: StudyTree, nodeId: number): TreeNode[] {
  const path: TreeNode[] = [];
  let current: TreeNode | undefined = tree.nodes[nodeId];
  while (current) {
    path.unshift(current);
    current = current.parentId !== null ? tree.nodes[current.parentId] : undefined;
  }
  return path;
}

export function sanPathTo(tree: StudyTree, nodeId: number): string[] {
  return pathTo(tree, nodeId)
    .map((node) => node.san)
    .filter((san): san is string => san !== null);
}

/** A chess.js position replayed from the tree's real root up to `nodeId`. */
export function positionAt(tree: StudyTree, nodeId: number): Chess {
  const chess = new Chess();
  for (const san of sanPathTo(tree, nodeId)) chess.move(san);
  return chess;
}

/** The [from, to] squares of the move that led to `nodeId`, for chessground's
 * `lastMove` highlight — `[]` at the root, where there's no move to show.
 * Chessground only tracks this itself for moves made through its own drag
 * API; jumping the board to an arbitrary position via `board.set({ fen })`
 * (navigating the tree, auto-playing a reply, switching lines) leaves
 * whatever was highlighted before untouched unless this is passed
 * explicitly alongside the new fen — that mismatch is the bug this fixes. */
export function lastMoveAt(tree: StudyTree, nodeId: number): Key[] {
  const sans = sanPathTo(tree, nodeId);
  if (sans.length === 0) return [];
  const chess = new Chess();
  let from = "";
  let to = "";
  for (const san of sans) {
    const move = chess.move(san);
    from = move.from;
    to = move.to;
  }
  return [from as Key, to as Key];
}

/** Adds `san` as a child of `parentId`, reusing an existing branch with the same move if there is one. */
export function addMove(tree: StudyTree, parentId: number, san: string): number {
  const parent = tree.nodes[parentId];
  const existing = parent.children.find((childId) => tree.nodes[childId].san === san);
  if (existing !== undefined) return existing;

  const id = tree.nextId++;
  tree.nodes[id] = { id, san, parentId, children: [] };
  parent.children.push(id);
  return id;
}

/** Removes a node and everything below it. The root can't be deleted. */
export function deleteSubtree(tree: StudyTree, nodeId: number): void {
  const node = tree.nodes[nodeId];
  if (!node || node.parentId === null) return;
  for (const childId of [...node.children]) deleteSubtree(tree, childId);
  delete tree.nodes[nodeId];
  const parent = tree.nodes[node.parentId];
  if (parent) parent.children = parent.children.filter((id) => id !== nodeId);
}

/** The tree's first-child-always line, used for card previews. */
export function mainLineSans(tree: StudyTree): string[] {
  const sans: string[] = [];
  let node = tree.nodes[tree.rootId];
  while (node.children.length > 0) {
    node = tree.nodes[node.children[0]];
    sans.push(node.san as string);
  }
  return sans;
}

function renderMove(
  tree: StudyTree,
  nodeId: number,
  depth: number,
  currentId: number,
  side: "white" | "black",
  studyStartNodeId: number | null,
): string {
  const isWhite = depth % 2 === 1;
  const classes = ["tree-move"];
  if (isWhite === (side === "white")) classes.push("tree-move--mine");
  if (nodeId === currentId) classes.push("tree-move--current");
  if (nodeId === studyStartNodeId) classes.push("tree-move--start-point");
  const title = nodeId === studyStartNodeId ? ' title="This study\'s starting point — stats are calculated from here"' : "";
  const hasComment = Boolean(tree.nodes[nodeId].comment?.trim());
  return `<span class="${classes.join(" ")}" data-node-id="${nodeId}"${title}>${escapeHtml(tree.nodes[nodeId].san as string)}<span class="tree-move-comment-marker"${hasComment ? ' title="Has a comment"' : ""} ${hasComment ? "" : "hidden"} aria-hidden="true"></span></span>`;
}

function renderLine(
  tree: StudyTree,
  lineStartNodeId: number,
  startDepth: number,
  currentId: number,
  side: "white" | "black",
  studyStartNodeId: number | null,
): string {
  let html = "";
  let nodeId: number | undefined = lineStartNodeId;
  let depth = startDepth;
  let firstRow = true;

  while (nodeId !== undefined) {
    const rowStartId = nodeId;
    const rowStartDepth = depth;
    const node = tree.nodes[rowStartId];
    let pairedBlackId: number | undefined;

    if (rowStartDepth % 2 === 1) {
      const possibleBlackId = node.children[0];
      if (possibleBlackId !== undefined) pairedBlackId = possibleBlackId;
    }

    const whiteId = rowStartDepth % 2 === 1 ? rowStartId : undefined;
    const blackId = rowStartDepth % 2 === 0 ? rowStartId : pairedBlackId;
    const moveNumber = Math.floor((rowStartDepth - 1) / 2) + 1;
    const number = rowStartDepth % 2 === 1 ? `${moveNumber}.` : `${moveNumber}...`;
    const branches: string[] = [];

    for (const [playedId, playedDepth] of [
      [rowStartId, rowStartDepth],
      ...(pairedBlackId !== undefined ? [[pairedBlackId, rowStartDepth + 1]] : []),
    ] as [number, number][]) {
      if (firstRow && playedId === rowStartId) continue;
      const parentId = tree.nodes[playedId].parentId;
      if (parentId === null) continue;
      const alternatives = tree.nodes[parentId].children.filter((childId) => childId !== playedId);
      for (const alternativeId of alternatives) {
        branches.push(renderLine(tree, alternativeId, playedDepth, currentId, side, studyStartNodeId));
      }
    }

    html += `
      <div class="tree-move-row">
        <span class="tree-move-number">${number}</span>
        <span class="tree-move-cell tree-move-cell--white">${whiteId === undefined ? "" : renderMove(tree, whiteId, rowStartDepth, currentId, side, studyStartNodeId)}</span>
        <span class="tree-move-cell tree-move-cell--black">${blackId === undefined ? "" : renderMove(tree, blackId, rowStartDepth % 2 === 0 ? rowStartDepth : rowStartDepth + 1, currentId, side, studyStartNodeId)}</span>
      </div>
      ${branches.length ? `<div class="tree-variations">${branches.map((branch) => `<div class="tree-variation">${branch}</div>`).join("")}</div>` : ""}
    `;

    const lastPlayedId = pairedBlackId ?? rowStartId;
    nodeId = tree.nodes[lastPlayedId].children[0];
    depth = rowStartDepth + (pairedBlackId === undefined ? 1 : 2);
    firstRow = false;
  }

  return `<div class="tree-line">${html}</div>`;
}

export function renderTree(
  tree: StudyTree,
  currentId: number,
  side: "white" | "black",
  startNodeId: number | null = null,
): string {
  const root = tree.nodes[tree.rootId];
  if (root.children.length === 0) {
    return '<span class="tree-empty">No moves yet — play them on the board.</span>';
  }
  const [mainChildId, ...variations] = root.children;
  return `
    ${renderLine(tree, mainChildId, 1, currentId, side, startNodeId)}
    ${variations.map((variationId) => `<div class="tree-variations tree-variations--root"><div class="tree-variation">${renderLine(tree, variationId, 1, currentId, side, startNodeId)}</div></div>`).join("")}
  `;
}
