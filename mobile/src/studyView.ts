// A study, read-only (#/study/ID, from the home screen): the analysis as a
// screen of its own, from the study's starting point, along its prep.

import { sanPathTo } from "@web/tree";

import { openAnalysis } from "./analysis";
import { study as loadStudy } from "./api";

/** Renders the study; returns what to undo on leaving it. */
export async function renderStudyView(app: HTMLElement, id: number): Promise<() => void> {
  const study = await loadStudy(id);
  const start = study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId;
  return openAnalysis({
    line: sanPathTo(study.tree, start),
    orientation: study.side,
    side: study.side,
    explorerSettings: study.explorerSettings,
    tree: study.tree,
    title: study.name,
    screen: { root: app, back: "#/studies" },
    onClose: () => {},
  });
}
