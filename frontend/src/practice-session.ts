import type { Api } from "@lichess-org/chessground/api";
import type { Color, Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyBoardTheme, computeDests, createBoard, toColor } from "./board";
import { Engine, formatScore, RANK_BRUSHES, uciMoveToKeys, type EngineAnalysis } from "./engine";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { positionAt, type StudyTree } from "./tree";

interface Study {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  startNodeId: number | null;
}

interface AttemptResult {
  streak: number;
  tauDays: number;
  knowledge: number;
}

// One instruction in the pre-computed walk through the tree — see
// buildSteps() below. "auto" covers both the opponent's replies (always)
// and any of the studied side's own moves that weren't selected for this
// session (because they're not due and not new).
type Step = { nodeId: number; quiz: boolean };

// How long the board pauses on a graded answer before auto-advancing —
// long enough to read the result, short enough that a session doesn't feel
// like it's waiting on you to click through it.
const CORRECT_PAUSE_MS = 800;
const INCORRECT_PAUSE_MS = 1600;

// Legend dot colors for the engine line list, matching the green (best) ->
// red (worst) gradient of the RANK_BRUSHES arrow colors on the board — same
// palette the Study editor's Stockfish panel uses.
const RANK_LEGEND_COLORS = ["#15781B", "#6fae54", "#e68f00", "#b56a5a", "#882020"];

function uciToSan(chess: Chess, uci: string): string {
  const clone = new Chess(chess.fen());
  const move = clone.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4, 5) || undefined });
  return move ? move.san : uci;
}

function getStudyId(): number | null {
  const id = new URLSearchParams(window.location.search).get("id");
  return id ? Number(id) : null;
}

async function loadStudy(id: number): Promise<Study | null> {
  const res = await fetch(`/api/studies/${id}`, { credentials: "same-origin" });
  return res.ok ? res.json() : null;
}

async function loadQueue(id: number): Promise<number[]> {
  const res = await fetch(`/api/studies/${id}/practice/queue`, { credentials: "same-origin" });
  if (!res.ok) return [];
  const data = await res.json();
  return data.nodeIds as number[];
}

async function recordAttempt(studyId: number, nodeId: number, correct: boolean): Promise<AttemptResult | null> {
  const res = await fetch(`/api/studies/${studyId}/practice/attempt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ nodeId, correct }),
  });
  return res.ok ? res.json() : null;
}

async function loadAggregateKnowledge(studyId: number): Promise<number | null> {
  const res = await fetch("/api/practice/summary", { credentials: "same-origin" });
  if (!res.ok) return null;
  const summaries = await res.json();
  return summaries[String(studyId)]?.aggregateKnowledge ?? null;
}

function renderSignedOut(main: HTMLElement): void {
  main.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to practice.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

/** Every node reachable from `startNodeId` whose subtree contains at least
 * one selected item, mapped to whether *it itself* is selected (a quiz
 * step) or just something to auto-play through on the way to one (an
 * ancestor, or an opponent reply, or one of your own moves that isn't due
 * this session). Everything outside this set — a whole variation with
 * nothing due or new in it — is skipped entirely rather than walked
 * through for no reason. See practice.md §5; this is a simplification of
 * its "sample opponent replies" idea: since every branch that matters gets
 * walked deterministically here, there's nothing left to sample. */
function buildSteps(tree: StudyTree, startNodeId: number, selected: Set<number>): Step[] {
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

function renderSession(main: HTMLElement, study: Study, steps: Step[]): void {
  if (steps.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <p>"${escapeHtml(study.name)}" has no moves of its own to practice yet.</p>
        <a class="btn btn-primary" href="/practice.html">Back to Practice</a>
      </div>
    `;
    return;
  }

  const totalQuizzes = steps.filter((step) => step.quiz).length;

  main.innerHTML = `
    <div class="practice-session">
      <div class="practice-session__header">
        <h1 class="page-title">${escapeHtml(study.name)}</h1>
        <a class="btn btn-secondary" href="/practice.html">End session</a>
      </div>
      <div class="practice-layout">
        <div class="study-card study-card--board">
          <div class="study-board-tools">
            <button id="flip-board-btn" class="board-flip-btn" type="button" data-icon="" title="Flip board" aria-label="Flip board"></button>
          </div>
          <div id="board" class="study-board"></div>
        </div>
        <div class="study-card practice-panel">
          <p id="practice-progress" class="practice-progress"></p>
          <p id="practice-prompt" class="practice-prompt"></p>
          <button id="practice-show-answer" class="btn btn-secondary practice-show-answer" type="button" hidden>
            Show answer
          </button>
          <div class="analysis-header">
            <label class="explorer-toggle">
              <input type="checkbox" id="engine-enabled" />
              Stockfish
            </label>
            <span id="engine-status" class="engine-eval"></span>
          </div>
          <div id="engine-panel" class="engine-panel" hidden></div>
          <div id="practice-summary" class="practice-feedback practice-feedback--summary" hidden></div>
          <ul id="practice-history" class="practice-history"></ul>
        </div>
      </div>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const flipBoardBtn = document.getElementById("flip-board-btn") as HTMLButtonElement;
  const progressEl = document.getElementById("practice-progress") as HTMLElement;
  const promptEl = document.getElementById("practice-prompt") as HTMLElement;
  const showAnswerBtn = document.getElementById("practice-show-answer") as HTMLButtonElement;
  const engineEnabledEl = document.getElementById("engine-enabled") as HTMLInputElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const summaryEl = document.getElementById("practice-summary") as HTMLElement;
  const historyEl = document.getElementById("practice-history") as HTMLElement;

  const tree = study.tree;
  let stepIndex = 0;
  let quizzesDone = 0;
  let correctCount = 0;
  let awaitingNodeId: number | null = null;
  // True once the *first* attempt at the current position has been graded
  // (and recorded via the API) — further attempts at the same position are
  // just retries: they let you keep trying until you get it, but they don't
  // change the knowledge score or the history entry a second time.
  let firstAttemptGraded = false;
  let board: Api;
  let engine: Engine | null = null;
  let currentChess: Chess = new Chess();
  // Defaults to the studied side at the bottom (e.g. Black at the bottom
  // for a Black opening) — that's the side you're actually answering for.
  let boardOrientation: Color = study.side;

  async function updateEngine(chess: Chess): Promise<void> {
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
    if (chess.fen() !== currentChess.fen()) return; // stale: the position moved on while this was running
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
          <div class="engine-line engine-line--readonly">
            <span class="engine-line__dot" style="background:${color}"></span>
            <span class="engine-line__san">${escapeHtml(san)}</span>
            <span class="engine-line__score">${escapeHtml(score)}</span>
          </div>
        `;
      })
      .join("");
  }

  /** Every place the board's displayed position changes goes through here,
   * so re-running Stockfish on the new position (when the toggle is on)
   * never gets forgotten at one call site but not another. */
  function setBoardPosition(chess: Chess, interactive: boolean): void {
    currentChess = chess;
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      movable: interactive ? { color: toColor(chess), dests: computeDests(chess) } : { color: undefined, dests: new Map() },
    });
    void updateEngine(chess);
  }

  function addHistoryEntry(expectedSan: string, correct: boolean, playedSan: string, knowledgePct: number | null): void {
    const pct = knowledgePct === null ? "" : `<span class="practice-history__knowledge">${knowledgePct}%</span>`;
    const detail = correct
      ? escapeHtml(expectedSan)
      : `${escapeHtml(playedSan)} <span class="practice-history__expected">→ ${escapeHtml(expectedSan)}</span>`;
    const item = document.createElement("li");
    item.className = `practice-history__item ${correct ? "practice-history__item--correct" : "practice-history__item--incorrect"}`;
    item.innerHTML = `
      <span class="practice-history__mark">${correct ? "✓" : "✗"}</span>
      <span class="practice-history__san">${detail}</span>
      ${pct}
    `;
    historyEl.insertBefore(item, historyEl.firstChild);
  }

  async function finish(): Promise<void> {
    const aggregate = await loadAggregateKnowledge(study.id);
    const pct = aggregate === null ? "—" : `${Math.round(aggregate * 100)}%`;
    progressEl.textContent = "Session complete";
    promptEl.textContent = "";
    promptEl.className = "practice-prompt";
    summaryEl.hidden = false;
    summaryEl.innerHTML = `
      <p>${correctCount} / ${quizzesDone} correct this session.</p>
      <p>"${escapeHtml(study.name)}" knowledge is now ${pct}.</p>
      <a class="btn btn-primary" href="/practice.html">Back to Practice</a>
    `;
  }

  function showPrompt(nodeId: number): void {
    const parentId = tree.nodes[nodeId].parentId as number;
    setBoardPosition(positionAt(tree, parentId), true);
    awaitingNodeId = nodeId;
    firstAttemptGraded = false;
    showAnswerBtn.hidden = true;
    progressEl.textContent = `Position ${quizzesDone + 1} of ${totalQuizzes}`;
    promptEl.textContent = "Your move";
    promptEl.className = "practice-prompt";
  }

  async function advance(): Promise<void> {
    while (stepIndex < steps.length && !steps[stepIndex].quiz) {
      stepIndex++;
    }
    if (stepIndex >= steps.length) {
      await finish();
      return;
    }
    showPrompt(steps[stepIndex].nodeId);
  }

  /** The current position is done being quizzed — either answered right
   * (first try or a retry) or revealed via "Show answer" — so lock the
   * board on the real move and auto-advance after a pause. */
  function completeItem(nodeId: number, promptClass: string, message: string, pauseMs: number): void {
    awaitingNodeId = null;
    firstAttemptGraded = false;
    showAnswerBtn.hidden = true;
    setBoardPosition(positionAt(tree, nodeId), false);
    promptEl.className = `practice-prompt ${promptClass}`.trim();
    promptEl.textContent = message;
    stepIndex++;
    window.setTimeout(() => void advance(), pauseMs);
  }

  function retryAtSamePrompt(nodeId: number, message: string): void {
    const parentId = tree.nodes[nodeId].parentId as number;
    setBoardPosition(positionAt(tree, parentId), true);
    promptEl.className = "practice-prompt practice-prompt--incorrect";
    promptEl.textContent = message;
  }

  async function handleFirstAttempt(nodeId: number, correct: boolean, playedSan: string): Promise<void> {
    quizzesDone++;
    if (correct) correctCount++;

    const result = await recordAttempt(study.id, nodeId, correct);
    const expectedSan = tree.nodes[nodeId].san as string;
    const knowledgePct = result ? Math.round(result.knowledge * 100) : null;
    addHistoryEntry(expectedSan, correct, playedSan, knowledgePct);

    if (correct) {
      completeItem(nodeId, "practice-prompt--correct", "Correct!", CORRECT_PAUSE_MS);
    } else {
      // Allow another try instead of moving straight on — a single slip
      // shouldn't end the position, only a second miss (or giving up) does.
      firstAttemptGraded = true;
      showAnswerBtn.hidden = false;
      retryAtSamePrompt(nodeId, "Not quite — try again");
    }
  }

  function handleRetry(nodeId: number, correct: boolean): void {
    if (correct) {
      completeItem(nodeId, "practice-prompt--correct", "Correct!", CORRECT_PAUSE_MS);
    } else {
      retryAtSamePrompt(nodeId, "Still not quite — try again");
    }
  }

  function onMove(orig: Key, dest: Key): void {
    if (awaitingNodeId === null) return;
    const nodeId = awaitingNodeId;
    const parentId = tree.nodes[nodeId].parentId as number;
    const chess = positionAt(tree, parentId);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    const expectedSan = tree.nodes[nodeId].san as string;
    const correct = move.san === expectedSan;
    if (!firstAttemptGraded) {
      void handleFirstAttempt(nodeId, correct, move.san);
    } else {
      handleRetry(nodeId, correct);
    }
  }

  board = createBoard(boardEl, onMove, boardOrientation);

  flipBoardBtn.addEventListener("click", () => {
    boardOrientation = boardOrientation === "white" ? "black" : "white";
    board.set({ orientation: boardOrientation });
  });

  showAnswerBtn.addEventListener("click", () => {
    if (awaitingNodeId === null) return;
    const nodeId = awaitingNodeId;
    const expectedSan = tree.nodes[nodeId].san as string;
    completeItem(nodeId, "", `The move was ${expectedSan}`, INCORRECT_PAUSE_MS);
  });

  engineEnabledEl.addEventListener("change", () => {
    if (engineEnabledEl.checked) {
      void updateEngine(currentChess);
    } else {
      board.set({ drawable: { autoShapes: [] } });
      engineStatusEl.textContent = "";
      enginePanelEl.hidden = true;
      enginePanelEl.innerHTML = "";
      engine?.terminate();
      engine = null;
    }
  });

  void advance();
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("practice-main");
  if (!main) return;

  if (!me.authenticated) {
    renderSignedOut(main);
    return;
  }

  const studyId = getStudyId();
  if (!studyId) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  const [study, , nodeIds] = await Promise.all([loadStudy(studyId), applyBoardTheme(), loadQueue(studyId)]);
  if (!study) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  const startNodeId =
    study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId;
  const steps = buildSteps(study.tree, startNodeId, new Set(nodeIds));
  renderSession(main, study, steps);
}

init();
