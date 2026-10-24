// A practice session on one study, as on the website (practice-session.ts,
// practice.md): the server's queue says which of your moves to ask; the
// walk (practiceSteps.ts) plays the rest. A first answer is recorded; after
// a wrong one you may try again or see the answer. When a round is done,
// the next one loads.

import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";

import { applyBoardTheme, computeDests, createBoard, playMoveSound, toColor } from "@web/board";
import { escapeHtml } from "@web/layout";
import { buildSteps, PRACTICE_ANIMATION_MS, type Step } from "@web/practiceSteps";
import { lastMoveAt, positionAt, sanPathTo } from "@web/tree";

import { openAnalysis } from "./analysis";
import { ANALYSIS_ICON, FLIP_ICON } from "./icons";
import { practiceQueue, practiceSummary, recordAttempt, study as loadStudy } from "./api";

const CORRECT_PAUSE_MS = 700;
const CELEBRATION_MS = 1800;
const ANSWER_PAUSE_MS = 1500;

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
        <button class="button" type="button" id="answer" hidden>Show answer</button>
        <a class="button" href="#/practice" id="done" hidden>Done</a>
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

  let steps: Step[] = buildSteps(tree, start, new Set(firstQueue));
  let stepIndex = 0;
  let asked = 0;
  let total = steps.filter((step) => step.quiz).length;
  let awaiting: number | null = null; // the node whose move is asked
  let graded = false; // its first answer is recorded: now only retries
  let timer: number | undefined;
  let left = false;

  const board: Api = createBoard(el("board"), onMove, study.side);
  board.set({ animation: { duration: PRACTICE_ANIMATION_MS } });
  void applyBoardTheme();

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

  // A dot per first answer: green right, red wrong; on one row, the oldest
  // dropped when it's full.
  function dot(correct: boolean): void {
    const dots = el("dots");
    const d = document.createElement("span");
    d.className = `dots__dot dots__dot--${correct ? "good" : "bad"}`;
    dots.append(d);
    while (dots.scrollWidth > dots.clientWidth && dots.firstChild) dots.firstChild.remove();
  }

  let shownNode = start; // the position on the board
  function setPosition(nodeId: number, interactive: boolean): void {
    shownNode = nodeId;
    const chess = positionAt(tree, nodeId);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
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
    answerBtn.hidden = true;
    setPosition(tree.nodes[nodeId].parentId as number, true);
    progressEl.textContent = `${asked + 1} / ${total}`;
    prompt("Your move");
  }

  async function advance(): Promise<void> {
    while (stepIndex < steps.length && !steps[stepIndex].quiz) stepIndex++;
    if (stepIndex < steps.length) return ask(steps[stepIndex].nodeId);
    // The round is done: the next one.
    prompt("Round done", "good");
    let queue: number[];
    try {
      queue = await practiceQueue(id);
    } catch {
      return prompt("Can't load the next round", "bad");
    }
    if (left) return;
    steps = buildSteps(tree, start, new Set(queue));
    stepIndex = 0;
    asked = 0;
    total = steps.filter((step) => step.quiz).length;
    if (!total) {
      prompt("Nothing left to practise", "good");
      progressEl.textContent = "";
      el("done").hidden = false;
      return;
    }
    later(() => void advance(), CORRECT_PAUSE_MS);
  }

  /** The asked move is played on the board, then the next step. */
  function finish(nodeId: number, text: string, tone: "good" | "bad", pause: number): void {
    awaiting = null;
    answerBtn.hidden = true;
    setPosition(nodeId, false);
    prompt(text, tone);
    stepIndex++;
    asked++;
    later(() => void advance(), pause);
  }

  async function firstAnswer(nodeId: number, correct: boolean): Promise<void> {
    const result = await recordAttempt(id, nodeId, correct);
    if (left) return;
    // Offline, it waits to be sent: no warning, only the bar's count.
    el("warning").hidden = result !== null;
    dot(correct);
    void showKnowledge();
    if (correct) return finish(nodeId, "Correct", "good", CORRECT_PAUSE_MS);
    graded = true;
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
      // No second move while the first answer is being saved.
      board.set({ movable: { color: undefined, dests: new Map() } });
      void firstAnswer(nodeId, correct);
    } else if (correct) {
      finish(nodeId, "Correct", "good", CORRECT_PAUSE_MS);
    } else {
      setPosition(tree.nodes[nodeId].parentId as number, true);
      prompt("Try again", "bad");
    }
  }

  el("flip").addEventListener("click", () =>
    board.set({ orientation: board.state.orientation === "white" ? "black" : "white" }),
  );
  el("full").addEventListener("click", () => (el("full").hidden = true));
  // The analysis, on the board's position: the session pauses meanwhile.
  el("analysis").addEventListener("click", () => {
    const resume = pending;
    window.clearTimeout(timer);
    pending = null;
    openAnalysis({
      line: sanPathTo(tree, shownNode),
      orientation: board.state.orientation,
      side: study.side,
      explorerSettings: study.explorerSettings,
      onClose: () => {
        if (resume && !left) later(resume, 300);
      },
    });
  });
  answerBtn.addEventListener("click", () => {
    if (awaiting !== null) finish(awaiting, tree.nodes[awaiting].san as string, "bad", ANSWER_PAUSE_MS);
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
