// A practice session on one study, as on the website (practice-session.ts,
// practice.md): the server's queue says which of your moves to ask; the
// walk (practiceSteps.ts) plays the rest. A first answer is recorded; after
// a wrong one you may try again or see the answer. When a round is done,
// the next one loads.

import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";

import { applyBoardTheme, computeDests, createBoard, playMoveSound, toColor } from "@web/board";
import { escapeHtml } from "@web/layout";
import { buildSteps, type Step } from "@web/practiceSteps";
import { lastMoveAt, positionAt } from "@web/tree";

import { practiceQueue, practiceSummary, recordAttempt, study as loadStudy } from "./api";

const CORRECT_PAUSE_MS = 700;
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
      <div class="session__board"><div id="board" class="board"></div></div>
      <div class="session__status">
        <span class="session__prompt" id="prompt" aria-live="polite"></span>
        <span class="session__progress" id="progress"></span>
      </div>
      <div class="session__actions">
        <button class="button" type="button" id="answer" hidden>Show answer</button>
        <a class="button" href="#/practice" id="done" hidden>Done</a>
      </div>
      <p class="session__warning" id="warning" hidden>Not saved: check your connection</p>
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
  void applyBoardTheme();

  function prompt(text: string, tone: "" | "good" | "bad" = ""): void {
    promptEl.textContent = text;
    promptEl.className = `session__prompt${tone ? ` session__prompt--${tone}` : ""}`;
  }

  async function showKnowledge(): Promise<void> {
    try {
      const k = (await practiceSummary())[String(id)]?.aggregateKnowledge;
      if (!left) knowledgeEl.textContent = k == null ? "" : `${Math.round(k * 100)}%`;
    } catch {
      // Just not shown.
    }
  }

  function setPosition(nodeId: number, interactive: boolean): void {
    const chess = positionAt(tree, nodeId);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      lastMove: lastMoveAt(tree, nodeId),
      movable: interactive ? { color: toColor(chess), dests: computeDests(chess) } : { color: undefined, dests: new Map() },
    });
  }

  function later(fn: () => void, ms: number): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
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
    el("warning").hidden = result !== null;
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
