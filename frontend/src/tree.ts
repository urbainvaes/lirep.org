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

/** The previous (-1) or next (1) variation from `nodeId`: at the nearest
 * branching above it, the first move of the variation before or after the
 * one it's in, in the tree's order; if it's the first or last there, the
 * same one level up, and so on; undefined if there is none. */
export function siblingVariation(tree: StudyTree, nodeId: number, step: -1 | 1): number | undefined {
  for (let node = tree.nodes[nodeId]; node.parentId !== null; node = tree.nodes[nodeId]) {
    const siblings = tree.nodes[node.parentId].children;
    const sibling = siblings[siblings.indexOf(nodeId) + step];
    if (sibling !== undefined) return sibling;
    nodeId = node.parentId;
  }
  return undefined;
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

/** What the move list marks besides the moves themselves. */
export interface TreeMarks {
  /** Moves after which the expected score needs Explorer data not loaded yet. */
  unfetched?: ReadonlySet<number>;
  /** How likely the position after a move is to be reached, and its value. */
  moveStats?: ReadonlyMap<number, { probability: number; score: number }>;
  /** A figure for the starting position, shown next to it (or above the
   * moves when it is the initial position). */
  startStat?: { text: string; title: string };
  /** Moves (or the starting point) whose figures lack Explorer data: a
   * Calculate button, or what a running calculation says. */
  calculate?: { buttons: ReadonlySet<number>; busy: ReadonlyMap<number, string> };
  /** A flag after the starting point's move, which clears it when clicked. */
  startFlag?: boolean;
  /** Fold the moves at each branching, each with what follows it. */
  folding?: {
    /** The folds shown open, by the id of the move they start with. */
    open: ReadonlySet<number>;
    /** By the move a branching follows: the replies the tree doesn't have. */
    others?: ReadonlyMap<number, { probability: number; score: number }>;
  };
}

// The Fold branches and Auto-fold switches, shared by the study editor and
// the read-only viewer: folding is on unless switched off in this browser,
// auto-fold off unless switched on.
const FOLD_STORAGE_KEY = "study-fold-branches";
const AUTO_FOLD_STORAGE_KEY = "study-auto-fold";

export function getSavedFolding(): { fold: boolean; autoFold: boolean } {
  try {
    return {
      fold: localStorage.getItem(FOLD_STORAGE_KEY) !== "off",
      autoFold: localStorage.getItem(AUTO_FOLD_STORAGE_KEY) === "on",
    };
  } catch {
    return { fold: true, autoFold: false };
  }
}

export function saveFolding(which: "fold" | "autoFold", on: boolean): void {
  try {
    localStorage.setItem(which === "fold" ? FOLD_STORAGE_KEY : AUTO_FOLD_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Keep the choice for this page even when browser storage is blocked.
  }
}

export const FOLD_SWITCHES_HTML = `<button id="fold-btn" class="study-switch" type="button" role="switch" aria-checked="true" title="Put the moves at each branching in folds"><span class="study-switch__track" aria-hidden="true"></span>Fold branches</button>
                <button id="autofold-btn" class="study-switch" type="button" role="switch" aria-checked="false" title="Close a variation's fold when you move out of it"><span class="study-switch__track" aria-hidden="true"></span>Auto-fold</button>`;

const moveNumberLabel = (depth: number) => `${Math.floor((depth - 1) / 2) + 1}.${depth % 2 === 1 ? "" : ".."}`;

// Small shares need a decimal to be told apart from zero.
const share = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;

function calculateHtml(nodeId: number, marks: TreeMarks): string {
  if (!marks.calculate?.buttons.has(nodeId)) return "";
  const busy = marks.calculate.busy.get(nodeId);
  return busy !== undefined
    ? `<span class="tree-move-stat tree-calc tree-calc--busy" role="status">${escapeHtml(busy)}</span>`
    : `<button type="button" class="tree-move-stat tree-calc" data-calculate="${nodeId}" title="Load the Opening Explorer data these figures need">Calculate</button>`;
}

// The starting point's figure, with its Calculate button when it has one.
const startStatHtml = (nodeId: number, marks: TreeMarks) =>
  marks.startStat
    ? `<span class="tree-move-stat" title="${escapeHtml(marks.startStat.title)}">${escapeHtml(marks.startStat.text)}${calculateHtml(nodeId, marks).replace(/tree-move-stat /, "")}</span>`
    : "";

function renderMove(
  tree: StudyTree,
  nodeId: number,
  depth: number,
  currentId: number,
  side: "white" | "black",
  studyStartNodeId: number | null,
  marks: TreeMarks,
): string {
  const isWhite = depth % 2 === 1;
  const classes = ["tree-move"];
  if (isWhite === (side === "white")) classes.push("tree-move--mine");
  if (nodeId === currentId) classes.push("tree-move--current");
  if (nodeId === studyStartNodeId) classes.push("tree-move--start-point");
  const title = nodeId === studyStartNodeId ? ' title="This study\'s starting point — stats are calculated from here"' : "";
  const hasComment = Boolean(tree.nodes[nodeId].comment?.trim());
  const unfetchedMarker = marks.unfetched?.has(nodeId)
    ? '<span class="tree-move-unfetched" title="The expected score needs Opening Explorer data for the position after this move, not loaded yet: open this move to load it"></span>'
    : "";
  const stat = marks.moveStats?.get(nodeId);
  // A score that isn't a number: the move isn't played in the Explorer's games.
  const statMarker = !stat
    ? ""
    : Number.isNaN(stat.score)
      ? '<span class="tree-move-stat" title="Not played in the Opening Explorer\'s games">0% · –</span>'
      : `<span class="tree-move-stat" title="Reached in ${(stat.probability * 100).toFixed(1)}% of games; expected score from here ${(stat.score * 100).toFixed(1)}%">${share(stat.probability)} · ${(stat.score * 100).toFixed(1)}%</span>`;
  // The figures follow the move, outside it: not part of what is clicked or
  // highlighted.
  const flag = nodeId === studyStartNodeId && marks.startFlag
    ? '<button type="button" class="tree-start-flag" data-clear-start title="The starting point: stats are calculated from here. Click to clear it." aria-label="Clear the starting point">🏁</button>'
    : "";
  const startMarker = nodeId === studyStartNodeId ? flag + startStatHtml(nodeId, marks) : calculateHtml(nodeId, marks);
  return `<span class="${classes.join(" ")}" data-node-id="${nodeId}"${title}>${escapeHtml(tree.nodes[nodeId].san as string)}${unfetchedMarker}<span class="tree-move-comment-marker"${hasComment ? ' title="Has a comment"' : ""} ${hasComment ? "" : "hidden"} aria-hidden="true"></span></span>${statMarker}${startMarker}`;
}

function renderLine(
  tree: StudyTree,
  lineStartNodeId: number,
  startDepth: number,
  currentId: number,
  side: "white" | "black",
  studyStartNodeId: number | null,
  marks: TreeMarks,
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

    // Folded, a branching ends the row: its moves go in folds below.
    if (rowStartDepth % 2 === 1 && !(marks.folding && node.children.length > 1)) {
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
      if (marks.folding || (firstRow && playedId === rowStartId)) continue;
      const parentId = tree.nodes[playedId].parentId;
      if (parentId === null) continue;
      const alternatives = tree.nodes[parentId].children.filter((childId) => childId !== playedId);
      for (const alternativeId of alternatives) {
        branches.push(renderLine(tree, alternativeId, playedDepth, currentId, side, studyStartNodeId, marks));
      }
    }

    html += `
      <div class="tree-move-row">
        <span class="tree-move-number">${number}</span>
        <span class="tree-move-cell tree-move-cell--white">${whiteId === undefined ? "" : renderMove(tree, whiteId, rowStartDepth, currentId, side, studyStartNodeId, marks)}</span>
        <span class="tree-move-cell tree-move-cell--black">${blackId === undefined ? "" : renderMove(tree, blackId, rowStartDepth % 2 === 0 ? rowStartDepth : rowStartDepth + 1, currentId, side, studyStartNodeId, marks)}</span>
      </div>
      ${branches.length ? `<div class="tree-variations">${branches.map((branch) => `<div class="tree-variation">${branch}</div>`).join("")}</div>` : ""}
    `;

    const lastPlayedId = pairedBlackId ?? rowStartId;
    const nextDepth = rowStartDepth + (pairedBlackId === undefined ? 1 : 2);
    if (marks.folding && tree.nodes[lastPlayedId].children.length > 1) {
      html += renderFolds(tree, lastPlayedId, nextDepth, currentId, side, studyStartNodeId, marks);
      break;
    }
    nodeId = tree.nodes[lastPlayedId].children[0];
    depth = rowStartDepth + (pairedBlackId === undefined ? 1 : 2);
    firstRow = false;
  }

  return `<div class="tree-line">${html}</div>`;
}

// The moves after `nodeId`, in all its lines.
function movesAfter(tree: StudyTree, nodeId: number): number {
  return tree.nodes[nodeId].children.reduce((count, childId) => count + 1 + movesAfter(tree, childId), 0);
}

// The moves at a branching, each in a fold with what follows it, in the
// tree's own order (never reordered by their figures); then the replies the
// tree doesn't have.
function renderFolds(
  tree: StudyTree,
  parentId: number,
  depth: number,
  currentId: number,
  side: "white" | "black",
  studyStartNodeId: number | null,
  marks: TreeMarks,
): string {
  const folds = tree.nodes[parentId].children.map((id) => {
    const head = `<span class="tree-move-number">${moveNumberLabel(depth)}</span> ${renderMove(tree, id, depth, currentId, side, studyStartNodeId, marks)}`;
    const next = tree.nodes[id].children;
    if (!next.length) return `<div class="tree-fold tree-fold--leaf"><div class="tree-fold__head">${head}</div></div>`;
    const body = next.length > 1
      ? renderFolds(tree, id, depth + 1, currentId, side, studyStartNodeId, marks)
      : renderLine(tree, next[0], depth + 1, currentId, side, studyStartNodeId, marks);
    const open = marks.folding?.open.has(id) ? " open" : "";
    // How many moves the fold holds, after its figures; shown while it's closed.
    const moves = movesAfter(tree, id);
    const count = `<span class="tree-fold__count" title="${moves} more move${moves === 1 ? "" : "s"} in this line">(${moves})</span>`;
    return `<details class="tree-fold" data-fold-id="${id}"${open}><summary class="tree-fold__head">${head}${count}</summary><div class="tree-fold__body">${body}</div></details>`;
  });
  const others = marks.folding?.others?.get(parentId);
  const othersRow = others && others.probability > 0
    ? `<div class="tree-fold tree-fold--others"><div class="tree-fold__head">Other replies <span class="tree-move-stat" title="Replies this study doesn't have: reached in ${(others.probability * 100).toFixed(1)}% of games; expected score ${(others.score * 100).toFixed(1)}%">${share(others.probability)} · ${(others.score * 100).toFixed(1)}%</span></div></div>`
    : "";
  return `<div class="tree-folds">${folds.join("")}${othersRow}</div>`;
}

export function renderTree(
  tree: StudyTree,
  currentId: number,
  side: "white" | "black",
  startNodeId: number | null = null,
  marks: TreeMarks = {},
): string {
  const root = tree.nodes[tree.rootId];
  if (root.children.length === 0) {
    return '<span class="tree-empty">No moves yet — play them on the board.</span>';
  }
  // From the initial position, the starting position's figure has no move
  // to follow: it goes above the moves.
  const fromRoot = startNodeId === null || startNodeId === tree.rootId || !(startNodeId in tree.nodes);
  const rootStat = fromRoot && marks.startStat ? `<div class="tree-start-stat">${startStatHtml(tree.rootId, marks)}</div>` : "";
  if (marks.folding && root.children.length > 1) {
    return rootStat + renderFolds(tree, tree.rootId, 1, currentId, side, startNodeId, marks);
  }
  const [mainChildId, ...variations] = root.children;
  return `${rootStat}
    ${renderLine(tree, mainChildId, 1, currentId, side, startNodeId, marks)}
    ${variations.map((variationId) => `<div class="tree-variations tree-variations--root"><div class="tree-variation">${renderLine(tree, variationId, 1, currentId, side, startNodeId, marks)}</div></div>`).join("")}
  `;
}
