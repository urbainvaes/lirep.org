// The walk through a study that a practice session follows (see
// practice.md §5): shared by the website's session (practice-session.ts)
// and the mobile app's.

import type { StudyTree } from "./tree";

// One instruction in the pre-computed walk through the tree — see
// buildSteps() below. "auto" covers both the opponent's replies (always)
// and any of the studied side's own moves that weren't selected for this
// session (because they're not due and not new).
export type Step = { nodeId: number; quiz: boolean };

/** Every node reachable from `startNodeId` whose subtree contains at least
 * one selected item, mapped to whether *it itself* is selected (a quiz
 * step) or just something to auto-play through on the way to one (an
 * ancestor, or an opponent reply, or one of your own moves that isn't due
 * this session). Everything outside this set — a whole variation with
 * nothing due or new in it — is skipped entirely rather than walked
 * through for no reason. See practice.md §5; this is a simplification of
 * its "sample opponent replies" idea: since every branch that matters gets
 * walked deterministically here, there's nothing left to sample. */
export function buildSteps(tree: StudyTree, startNodeId: number, selected: Set<number>): Step[] {
  const relevant = new Set<number>();
  function mark(nodeId: number): boolean {
    let isRelevant = selected.has(nodeId);
    for (const childId of tree.nodes[nodeId].children) {
      if (mark(childId)) isRelevant = true;
    }
    if (isRelevant) relevant.add(nodeId);
    return isRelevant;
  }
  mark(startNodeId);

  const steps: Step[] = [];
  function walk(nodeId: number): void {
    for (const childId of tree.nodes[nodeId].children) {
      if (!relevant.has(childId)) continue;
      steps.push({ nodeId: childId, quiz: selected.has(childId) });
      walk(childId);
    }
  }
  walk(startNodeId);
  return steps;
}
