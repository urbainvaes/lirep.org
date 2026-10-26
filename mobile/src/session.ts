// A practice session on one study, as on the website (practice-session.ts,
// practice.md): the server's queue says which of your moves to ask; the
// walk (practiceSteps.ts) plays the rest. A first answer is recorded (seeing
// the answer first counts as a miss); after a wrong one you may try again or
// see the answer. When a round is done, the next one loads while positions
// are due or new; after that, more is optional: offered, not started.

import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";

import { computeDests, createBoard, playMoveSound, toColor } from "@web/board";
import { escapeHtml } from "@web/layout";
import { buildSteps, PRACTICE_ANIMATION_MS, type Step } from "@web/practiceSteps";
import { lastMoveAt, positionAt, sanPathTo } from "@web/tree";

import { openAnalysis } from "./analysis";
import { ANALYSIS_ICON, FLIP_ICON, PREVIOUS_ICON } from "./icons";
import { practiceQueue, practiceSummary, recordAttempt, study as loadStudy } from "./api";

const CORRECT_PAUSE_MS = 700;
const CELEBRATION_MS = 1800;
const ANSWER_PAUSE_MS = 1500;
const ROUND_PAUSE_MS = 1500;

/** Renders the session; returns what to undo on leaving it. */
export async function renderSession(app: HTMLElement, id: number): Promise<() => void> {
  const [study, firstQueue] = await Promise.all([loadStudy(id), practiceQueue(id)]);
  const tree = study.tree;
  const start = study.startNodeId !== null && study.startNodeId in tree.nodes ? study.startNodeId : tree.rootId;

  app.innerHTML = `
    <div class="session">
      <header class="bar">
        <a class="bar__back" href="#/practice" aria-label="Back">‹</a>
        <h1 class="bar__title">${escapeHtml(study.name)}</h1>
        <span class="bar__aside" id="knowledge" title="Known"></span>
      </header>
      <div class="session__above">
        <div class="dots" id="dots" aria-label="This session's answers"></div>
        <div class="session__status">
          <span class="session__prompt" id="prompt" aria-live="polite"></span>
          <span class="session__progress" id="progress"></span>
        </div>
      </div>
      <div class="session__board"><div id="board" class="board"></div></div>
      <div class="session__below">
        <p class="session__warning" id="warning" hidden>Not saved</p>
      </div>
      <div class="session__toolbar">
        <button class="icon-button" type="button" id="flip" aria-label="Flip the board" title="Flip the board">${FLIP_ICON}</button>
        <button class="icon-button" type="button" id="analysis" aria-label="Analysis" title="Analysis">${ANALYSIS_ICON}</button>
        <button class="icon-button" type="button" id="previous" aria-label="The previous question, in the analysis" title="Previous question" disabled>${PREVIOUS_ICON}</button>
        <button class="button" type="button" id="answer" title="Counts as a miss if you haven't answered" hidden>Show answer</button>
        <a class="button" href="#/practice" id="done" hidden>Done</a>
        <button class="button" type="button" id="more" hidden>Practise more</button>
      </div>
      <div class="done" id="full" hidden>
        <div class="done__mark">100%</div>
        <div class="done__time">known</div>
      </div>
    </div>
  `;
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const promptEl = el("prompt");
  const progressEl = el("progress");
  const knowledgeEl = el("knowledge");
  const answerBtn = el("answer") as HTMLButtonElement;

  let steps: Step[] = buildSteps(tree, start, new Set(firstQueue.nodeIds));
  let optional = firstQueue.optional; // this round is review, nothing due
  let stepIndex = 0;
  let asked = 0;
  let total = steps.filter((step) => step.quiz).length;
  let answered = 0; // first answers this session
  let right = 0;
  let awaiting: number | null = null; // the node whose move is asked
  let graded = false; // its first answer is recorded: now only retries
  let timer: number | undefined;
  let left = false;

  const board: Api = createBoard(el("board"), onMove, study.side);
  board.set({ animation: { duration: PRACTICE_ANIMATION_MS } });

  function prompt(text: string, tone: "" | "good" | "bad" = ""): void {
    promptEl.textContent = text;
    promptEl.className = `session__prompt${tone ? ` session__prompt--${tone}` : ""}`;
  }

  // The study's knowledge, top right; reaching 100% for the first time in
  // the session is celebrated, briefly, while practice goes on.
  let celebrated: boolean | null = null; // null until first known
  async function showKnowledge(): Promise<void> {
    let k: number | null | undefined;
    try {
      k = (await practiceSummary())[String(id)]?.aggregateKnowledge;
    } catch {
      return; // Just not shown.
    }
    if (left) return;
    const pct = k == null ? null : Math.round(k * 100);
    knowledgeEl.textContent = pct === null ? "" : `${pct}%`;
    if (celebrated === null) celebrated = pct === 100;
    else if (!celebrated && pct === 100) {
      celebrated = true;
      el("full").hidden = false;
      window.setTimeout(() => (el("full").hidden = true), CELEBRATION_MS);
    }
  }

  // A dot per first answer: red wrong; green right, paler while the
  // position's streak is short of the 3 that make it known (offline, the
  // streak isn't known yet: plain green). On one row, the oldest dropped
  // when it's full.
  function dot(correct: boolean, streak?: number): void {
    const dots = el("dots");
    const d = document.createElement("span");
    d.className = `dots__dot dots__dot--${correct ? "good" : "bad"}${correct && streak ? ` dots__dot--streak${Math.min(streak, 3)}` : ""}`;
    dots.append(d);
    while (dots.scrollWidth > dots.clientWidth && dots.firstChild) dots.firstChild.remove();
  }

  let shownNode = start; // the position on the board
  let previous: number | null = null; // the last question answered
  function setPosition(nodeId: number, interactive: boolean): void {
    shownNode = nodeId;
    const chess = positionAt(tree, nodeId);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      check: chess.isCheck(),
      lastMove: lastMoveAt(tree, nodeId),
      movable: interactive ? { color: toColor(chess), dests: computeDests(chess) } : { color: undefined, dests: new Map() },
    });
  }

  // The session's next step, waiting a moment (paused by the analysis).
  let pending: (() => void) | null = null;
  function later(fn: () => void, ms: number): void {
    window.clearTimeout(timer);
    pending = fn;
    timer = window.setTimeout(() => {
      pending = null;
      fn();
    }, ms);
  }

  function ask(nodeId: number): void {
    awaiting = nodeId;
    graded = false;
    answerBtn.hidden = false;
    setPosition(tree.nodes[nodeId].parentId as number, true);
    progressEl.textContent = `${optional ? "review " : ""}${asked + 1} / ${total}`;
    prompt("Your move");
  }

  async function advance(): Promise<void> {
    while (stepIndex < steps.length && !steps[stepIndex].quiz) stepIndex++;
    if (stepIndex < steps.length) return ask(steps[stepIndex].nodeId);
    // The round is done: the next one, unless it would only be optional.
    const tally = answered ? ` · ${right} / ${answered} right` : "";
    prompt(`Round done${tally}`, "good");
    progressEl.textContent = "";
    let queue: { nodeIds: number[]; optional: boolean };
    try {
      queue = await practiceQueue(id);
    } catch {
      return prompt("Can't load the next round", "bad");
    }
    if (left) return;
    steps = buildSteps(tree, start, new Set(queue.nodeIds));
    optional = queue.optional;
    stepIndex = 0;
    asked = 0;
    total = steps.filter((step) => step.quiz).length;
    if (!total || optional) {
      prompt(`${total ? "Nothing due" : "Nothing left to practise"}${tally}`, "good");
      el("done").hidden = false;
      el("more").hidden = !total;
      return;
    }
    later(() => void advance(), ROUND_PAUSE_MS);
  }

  /** The asked move is played on the board, then the next step. */
  function finish(nodeId: number, text: string, tone: "" | "good" | "bad", pause: number): void {
    awaiting = null;
    previous = nodeId;
    (el("previous") as HTMLButtonElement).disabled = false;
    answerBtn.hidden = true;
    setPosition(nodeId, false);
    prompt(text, tone);
    stepIndex++;
    asked++;
    later(() => void advance(), pause);
  }

  // Records the position's first answer (a miss when the answer is shown
  // first); no second one meanwhile.
  async function record(nodeId: number, correct: boolean): Promise<void> {
    graded = true;
    answerBtn.hidden = true;
    board.set({ movable: { color: undefined, dests: new Map() } });
    const result = await recordAttempt(id, nodeId, correct);
    if (left) return;
    // Offline, it waits to be sent: no warning, only the bar's count.
    el("warning").hidden = result !== null;
    dot(correct, typeof result === "object" && result ? result.streak : undefined);
    answered++;
    if (correct) right++;
    void showKnowledge();
  }

  async function firstAnswer(nodeId: number, correct: boolean): Promise<void> {
    await record(nodeId, correct);
    if (left) return;
    if (correct) return finish(nodeId, "Correct", "good", CORRECT_PAUSE_MS);
    answerBtn.hidden = false;
    setPosition(tree.nodes[nodeId].parentId as number, true);
    prompt("Try again", "bad");
  }

  function onMove(orig: Key, dest: Key): void {
    if (awaiting === null) return;
    const nodeId = awaiting;
    const chess = positionAt(tree, tree.nodes[nodeId].parentId as number);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    playMoveSound(move, chess);
    const correct = move.san === tree.nodes[nodeId].san;
    if (!graded) {
      void firstAnswer(nodeId, correct);
    } else if (correct) {
      // Only the first answer counts: this one was recorded as a miss.
      finish(nodeId, "Got it on retry", "", CORRECT_PAUSE_MS);
    } else {
      setPosition(tree.nodes[nodeId].parentId as number, true);
      prompt("Try again", "bad");
    }
  }

  el("flip").addEventListener("click", () =>
    board.set({ orientation: board.state.orientation === "white" ? "black" : "white" }),
  );
  el("full").addEventListener("click", () => (el("full").hidden = true));
  // The analysis, on the board's position, or on the previous question
  // (its position, the answer one step on): the session pauses meanwhile.
  el("analysis").addEventListener("click", () => analyse(sanPathTo(tree, shownNode)));
  el("previous").addEventListener("click", () => {
    if (previous === null) return;
    const line = sanPathTo(tree, previous);
    analyse(line, line.length - 1);
  });
  function analyse(line: string[], at?: number): void {
    const resume = pending;
    window.clearTimeout(timer);
    pending = null;
    openAnalysis({
      line,
      at,
      orientation: board.state.orientation,
      side: study.side,
      explorerSettings: study.explorerSettings,
      tree,
      onClose: () => {
        if (resume && !left) later(resume, 300);
      },
    });
  }
  answerBtn.addEventListener("click", async () => {
    if (awaiting === null) return;
    const nodeId = awaiting;
    // Before any answer: recorded as a miss, as a wrong move would be.
    if (!graded) await record(nodeId, false);
    if (left || awaiting !== nodeId) return;
    finish(nodeId, tree.nodes[nodeId].san as string, "bad", ANSWER_PAUSE_MS);
  });
  el("more").addEventListener("click", () => {
    el("done").hidden = true;
    el("more").hidden = true;
    void advance();
  });

  void showKnowledge();
  if (!total) {
    setPosition(start, false);
    prompt("Nothing to practise", "good");
    el("done").hidden = false;
  } else {
    void advance();
  }

  return () => {
    left = true;
    window.clearTimeout(timer);
    board.destroy();
  };
}
