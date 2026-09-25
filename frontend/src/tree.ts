import { escapeHtml } from "./layout";

export interface TreeNode {
  id: number;
  san: string | null;
  parentId: number | null;
  children: number[];
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
  // Only Black's move needs this to force a number — White's always gets one
  // regardless (standard PGN convention: "1.e4 e5 2.Nf3 Nc6", not just
  // "1.e4 e5 Nf3 Nc6"). Black only needs one when resuming after an
  // interruption: the very start of a rendered line, or right after a
  // variation was shown at this same ply.
  let needsNumber = true;

  while (nodeId !== undefined) {
    const node: TreeNode = tree.nodes[nodeId];
    const moveNumber = Math.floor((depth - 1) / 2) + 1;
    const isWhite = depth % 2 === 1;
    const isStudiedSide = isWhite === (side === "white");
    const label =
      isWhite || needsNumber
        ? `<span class="tree-move-number">${moveNumber}.${isWhite ? "" : ".."}</span> `
        : "";
    const classes = ["tree-move"];
    if (isStudiedSide) classes.push("tree-move--mine");
    if (nodeId === currentId) classes.push("tree-move--current");
    if (nodeId === studyStartNodeId) classes.push("tree-move--start-point");
    const title = nodeId === studyStartNodeId ? ' title="This study\'s starting point — stats are calculated from here"' : "";
    html += `<span class="${classes.join(" ")}" data-node-id="${nodeId}"${title}>${label}${escapeHtml(node.san as string)}</span> `;
    needsNumber = false;

    const [mainChildId, ...variations]: number[] = node.children;
    for (const variationId of variations) {
      html += `<span class="tree-variation">(${renderLine(tree, variationId, depth + 1, currentId, side, studyStartNodeId)})</span> `;
      needsNumber = true;
    }
    nodeId = mainChildId;
    depth += 1;
  }

  return html.trim();
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
  let html = renderLine(tree, mainChildId, 1, currentId, side, startNodeId);
  for (const variationId of variations) {
    html += ` <span class="tree-variation">(${renderLine(tree, variationId, 1, currentId, side, startNodeId)})</span>`;
  }
  return html;
}
