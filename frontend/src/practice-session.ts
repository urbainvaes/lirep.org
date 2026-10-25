import type { Api } from "@lichess-org/chessground/api";
import type { Color, Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { applyBoardTheme, computeDests, createBoard, playMoveSound, toColor } from "./board";
import { Engine, formatScore, RANK_BRUSHES, uciMoveToKeys, type EngineAnalysis } from "./engine";
import { renderBullet } from "./bullet";
import { FOCUS_BUTTON_HTML, setupFocusMode } from "./focusMode";
import type { BulletStats } from "./bulletStats";
import type { ExplorerSettings } from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { buildSteps, PRACTICE_ANIMATION_MS, type Step } from "./practiceSteps";
import { lastMoveAt, positionAt, sanPathTo, setLichessOrientation, type StudyTree } from "./tree";

interface Study {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  startNodeId: number | null;
  explorerSettings?: ExplorerSettings | null;
}

interface AttemptResult {
  streak: number;
  tauDays: number;
  knowledge: number;
}


// How long the board pauses on a graded answer before auto-advancing —
// long enough to read the result, short enough that a session doesn't feel
// like it's waiting on you to click through it.
const CORRECT_PAUSE_MS = 800;
const INCORRECT_PAUSE_MS = 1600;
// Long enough to read the round's summary before the next one starts.
const ROUND_PAUSE_MS = 1600;

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
  // Only a real 404 means "no such study" — any other failure (expired
  // session, a 500) is a transient error, not an empty state, so it's
  // thrown instead and caught by init()'s try/catch with its own message.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`failed to load study (${res.status})`);
  return res.json();
}

/** The next round's positions; optional when nothing is due or new, only
 * review (see practice.md §5). */
interface Queue {
  nodeIds: number[];
  optional: boolean;
}

async function loadQueue(id: number): Promise<Queue> {
  const res = await fetch(`/api/studies/${id}/practice/queue`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`failed to load practice queue (${res.status})`);
  const data = await res.json();
  return { nodeIds: data.nodeIds as number[], optional: Boolean(data.optional) };
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

function renderSession(main: HTMLElement, study: Study, startNodeId: number, initialSteps: Step[], initialOptional: boolean): void {
  if (initialSteps.length === 0) {
    main.innerHTML = `
      <div class="empty-state">
        <p>"${escapeHtml(study.name)}" has no moves of its own to practice yet.</p>
        <a class="btn btn-primary" href="/practice.html">Back to Practice</a>
      </div>
    `;
    return;
  }

  main.innerHTML = `
    <div class="practice-session">
      <div class="practice-session__header">
        <h1 class="page-title">${escapeHtml(study.name)}</h1>
        <div class="practice-session__header-right">
          <span class="practice-knowledge-badge">
            <span>Knowledge</span>
            <strong id="practice-knowledge">—</strong>
          </span>
          <a class="btn btn-secondary" href="/practice.html">End session</a>
        </div>
      </div>
      <div class="practice-session__tools">
        <button id="flip-board-btn" class="board-flip-btn" type="button" data-icon="" title="Flip board (f)" aria-label="Flip board"></button>
        ${FOCUS_BUTTON_HTML}
        <a id="open-lichess-analysis" class="btn btn-secondary" href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer">Open position in Lichess analysis</a>
      </div>
      <div class="practice-layout">
        <div class="study-card study-card--board">
          <div id="board" class="study-board"></div>
        </div>
        <div class="study-card practice-panel">
          <p id="practice-progress" class="practice-progress"></p>
          <p id="practice-prompt" class="practice-prompt"></p>
          <p id="practice-save-warning" class="practice-save-warning" hidden>
            Couldn't save that attempt — check your connection. Your progress here wasn't recorded.
          </p>
          <button id="practice-show-answer" class="btn btn-secondary practice-show-answer" type="button" title="Before any answer, this counts as a miss" hidden>
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
  const lichessAnalysisLink = document.getElementById("open-lichess-analysis") as HTMLAnchorElement;
  const progressEl = document.getElementById("practice-progress") as HTMLElement;
  const promptEl = document.getElementById("practice-prompt") as HTMLElement;
  const showAnswerBtn = document.getElementById("practice-show-answer") as HTMLButtonElement;
  const engineEnabledEl = document.getElementById("engine-enabled") as HTMLInputElement;
  const engineStatusEl = document.getElementById("engine-status") as HTMLElement;
  const enginePanelEl = document.getElementById("engine-panel") as HTMLElement;
  const summaryEl = document.getElementById("practice-summary") as HTMLElement;
  const historyEl = document.getElementById("practice-history") as HTMLElement;
  const knowledgeEl = document.getElementById("practice-knowledge") as HTMLElement;
  const saveWarningEl = document.getElementById("practice-save-warning") as HTMLElement;

  const tree = study.tree;
  // Once a round's queue is drained, the next one is fetched (see
  // startNextRound): started while positions are due or new, offered when
  // it would only be optional review. `steps`/`totalQuizzes`/`optional` are
  // therefore reassigned per round; `quizzesDone`/`correctCount` accumulate
  // for as long as this tab stays open.
  let steps = initialSteps;
  let optional = initialOptional;
  let totalQuizzes = steps.filter((step) => step.quiz).length;
  let stepIndex = 0;
  let roundDone = 0;
  let quizzesDone = 0;
  let correctCount = 0;
  let awaitingNodeId: number | null = null;
  // True once the *first* attempt at the current position has been graded
  // (and recorded via the API) — further attempts at the same position are
  // just retries: they let you keep trying until you get it, but they don't
  // change the knowledge score or the history entry a second time.
  let firstAttemptGraded = false;
  // Fires once per tab visit — reaching 100% again later (or staying there)
  // shouldn't re-trigger it every single subsequent correct answer.
  let celebrated = false;
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

  /** A Lichess analysis link for the *line* leading to `nodeId`, not just
   * its bare position — PGN rather than FEN, so opening it shows the whole
   * game up to here (and lets you step back through it), the same as the
   * Study editor's own "Open position in Lichess analysis" link. */
  function lichessAnalysisUrl(nodeId: number): string {
    const line = sanPathTo(tree, nodeId);
    const color = boardOrientation === "black" ? "?color=black" : "";
    return line.length
      ? `https://lichess.org/analysis/pgn/${line.map(encodeURIComponent).join("_")}${color}`
      : `https://lichess.org/analysis${color}`;
  }

  /** Every place the board's displayed position changes goes through here,
   * so re-running Stockfish on the new position (when the toggle is on),
   * and highlighting the move that actually led here, never gets forgotten
   * at one call site but not another. Takes the node rather than an
   * already-replayed Chess so it can look up that move for `lastMove` too —
   * without it, chessground keeps showing whichever squares were last
   * highlighted (e.g. from a different line entirely) instead of the
   * opponent's actual last move whenever the board jumps to a position via
   * `set()` rather than a real drag. */
  function setBoardPosition(nodeId: number, interactive: boolean): void {
    const chess = positionAt(tree, nodeId);
    currentChess = chess;
    lichessAnalysisLink.href = lichessAnalysisUrl(nodeId);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      lastMove: lastMoveAt(tree, nodeId),
      movable: interactive ? { color: toColor(chess), dests: computeDests(chess) } : { color: undefined, dests: new Map() },
    });
    void updateEngine(chess);
  }

  // `playedSan` null: the answer was shown before any move.
  function addHistoryEntry(nodeId: number, expectedSan: string, correct: boolean, playedSan: string | null, knowledgePct: number | null): void {
    const pct = knowledgePct === null ? "" : `<span class="practice-history__knowledge">${knowledgePct}%</span>`;
    const detail = correct
      ? escapeHtml(expectedSan)
      : playedSan === null
        ? `${escapeHtml(expectedSan)} <span class="practice-history__expected">(answer shown)</span>`
        : `${escapeHtml(playedSan)} <span class="practice-history__expected">→ ${escapeHtml(expectedSan)}</span>`;
    const analysisUrl = lichessAnalysisUrl(nodeId);
    const item = document.createElement("li");
    item.className = `practice-history__item ${correct ? "practice-history__item--correct" : "practice-history__item--incorrect"}`;
    item.innerHTML = `
      <span class="practice-history__mark">${correct ? "✓" : "✗"}</span>
      <span class="practice-history__san">${detail}</span>
      ${pct}
      <a
        class="practice-history__analysis"
        href="${analysisUrl}"
        target="_blank"
        rel="noopener noreferrer"
        data-icon=""
        aria-label="Open position in Lichess analysis"
        title="Open position in Lichess analysis"
      ></a>
    `;
    historyEl.insertBefore(item, historyEl.firstChild);
  }

  async function refreshKnowledge(): Promise<number | null> {
    const aggregate = await loadAggregateKnowledge(study.id);
    knowledgeEl.textContent = aggregate === null ? "—" : `${Math.round(aggregate * 100)}%`;
    return aggregate;
  }

  /** The end of what's due: a summary, and more practice offered when
   * there is some (`more`: the next round, optional review), not started.
   * Without it, the study lost every one of its drill-item nodes
   * mid-session, a rare fallback. */
  async function stop(more: boolean): Promise<void> {
    const aggregate = await refreshKnowledge();
    const pct = aggregate === null ? "—" : `${Math.round(aggregate * 100)}%`;
    progressEl.textContent = more ? "Nothing due" : "Nothing left to practice here";
    promptEl.textContent = "";
    promptEl.className = "practice-prompt";
    summaryEl.hidden = false;
    summaryEl.innerHTML = `
      <p>${correctCount} / ${quizzesDone} right first time this session.</p>
      <p>"${escapeHtml(study.name)}" knowledge is now ${pct}.${more ? " More practice is optional." : ""}</p>
      <div class="practice-celebration__actions">
        <a class="btn ${more ? "btn-secondary" : "btn-primary"}" href="/practice.html">Done</a>
        ${more ? '<button class="btn btn-primary" type="button" id="practice-more-btn">Practice more</button>' : ""}
      </div>
    `;
    document.getElementById("practice-more-btn")?.addEventListener("click", () => {
      summaryEl.hidden = true;
      summaryEl.innerHTML = "";
      void advance();
    });
  }

  async function startNextRound(): Promise<void> {
    showAnswerBtn.hidden = true;
    promptEl.className = "practice-prompt practice-prompt--correct";
    promptEl.textContent = quizzesDone ? `${correctCount} / ${quizzesDone} right first time so far` : "";
    progressEl.textContent = "Round complete";

    let queue: Queue;
    try {
      queue = await loadQueue(study.id);
    } catch {
      promptEl.className = "practice-prompt practice-prompt--incorrect";
      promptEl.textContent = "Could not load the next round — check your connection and reload.";
      progressEl.textContent = "";
      return;
    }
    const nextSteps = buildSteps(tree, startNodeId, new Set(queue.nodeIds));
    steps = nextSteps;
    optional = queue.optional;
    totalQuizzes = steps.filter((step) => step.quiz).length;
    stepIndex = 0;
    roundDone = 0;
    if (nextSteps.length === 0 || optional) {
      await stop(nextSteps.length > 0);
      return;
    }
    window.setTimeout(() => void advance(), ROUND_PAUSE_MS);
  }

  function showPrompt(nodeId: number): void {
    const parentId = tree.nodes[nodeId].parentId as number;
    setBoardPosition(parentId, true);
    awaitingNodeId = nodeId;
    firstAttemptGraded = false;
    showAnswerBtn.hidden = false;
    progressEl.textContent = `${optional ? "Optional review: position" : "Position"} ${roundDone + 1} of ${totalQuizzes}`;
    promptEl.textContent = "Your move";
    promptEl.className = "practice-prompt";
  }

  async function advance(): Promise<void> {
    while (stepIndex < steps.length && !steps[stepIndex].quiz) {
      stepIndex++;
    }
    if (stepIndex >= steps.length) {
      await startNextRound();
      return;
    }
    showPrompt(steps[stepIndex].nodeId);
  }

  /** The current position is done being quizzed — either answered right
   * (first try or a retry) or revealed via "Show answer" — so lock the
   * board on the real move and auto-advance after a pause. `pauseMs: null`
   * locks the board and advances the step counter without scheduling that
   * auto-advance — used when a celebration is about to take over instead,
   * pausing the loop until the user picks what to do next. */
  function completeItem(nodeId: number, promptClass: string, message: string, pauseMs: number | null): void {
    awaitingNodeId = null;
    firstAttemptGraded = false;
    showAnswerBtn.hidden = true;
    setBoardPosition(nodeId, false);
    promptEl.className = `practice-prompt ${promptClass}`.trim();
    promptEl.textContent = message;
    stepIndex++;
    if (pauseMs !== null) window.setTimeout(() => void advance(), pauseMs);
  }

  /** A one-time celebration for reaching 100% knowledge (rounded, matching
   * what the header badge itself shows) — pauses the otherwise-infinite
   * practice loop (see startNextRound) at this milestone instead of
   * ploughing straight past it, and hands the choice of what happens next
   * back to the user explicitly. */
  function showCelebration(): void {
    progressEl.textContent = "Fully known!";
    const confetti = Array.from({ length: 16 }, () => {
      const left = Math.random() * 100;
      const delay = Math.random() * 0.5;
      const duration = 1.4 + Math.random() * 0.8;
      const hue = Math.round(Math.random() * 360);
      return `<span class="practice-confetti" style="left:${left}%; animation-delay:${delay}s; animation-duration:${duration}s; background:hsl(${hue} 75% 60%)"></span>`;
    }).join("");

    summaryEl.hidden = false;
    summaryEl.className = "practice-feedback practice-feedback--summary practice-celebration";
    summaryEl.innerHTML = `
      <div class="practice-confetti-field" aria-hidden="true">${confetti}</div>
      <div class="practice-celebration__badge">🏆</div>
      <p class="practice-celebration__title">100% known!</p>
      <p>Every position in "${escapeHtml(study.name)}" is fully fresh right now.</p>
      <div class="practice-celebration__actions">
        <a class="btn btn-secondary" href="/practice.html">End session</a>
        <button class="btn btn-primary" type="button" id="practice-continue-btn">Continue practicing</button>
      </div>
    `;
    document.getElementById("practice-continue-btn")?.addEventListener("click", () => {
      summaryEl.hidden = true;
      summaryEl.className = "practice-feedback practice-feedback--summary";
      summaryEl.innerHTML = "";
      void advance();
    });
  }

  function retryAtSamePrompt(nodeId: number, message: string): void {
    const parentId = tree.nodes[nodeId].parentId as number;
    setBoardPosition(parentId, true);
    promptEl.className = "practice-prompt practice-prompt--incorrect";
    promptEl.textContent = message;
  }

  // `playedSan` null: the answer was shown before any move, recorded as a
  // miss.
  async function handleFirstAttempt(nodeId: number, correct: boolean, playedSan: string | null): Promise<void> {
    firstAttemptGraded = true;
    showAnswerBtn.hidden = true;
    roundDone++;
    quizzesDone++;
    if (correct) correctCount++;

    const result = await recordAttempt(study.id, nodeId, correct);
    // A null result means the save itself failed (network blip, expired
    // session, server error) — surfaced explicitly rather than silently
    // proceeding as if this attempt had been recorded, which would leave
    // the user believing their progress was saved when it wasn't.
    saveWarningEl.hidden = result !== null;
    const expectedSan = tree.nodes[nodeId].san as string;
    const knowledgePct = result ? Math.round(result.knowledge * 100) : null;
    addHistoryEntry(nodeId, expectedSan, correct, playedSan, knowledgePct);

    if (correct) {
      const aggregate = await refreshKnowledge();
      const reachedFull = !celebrated && aggregate !== null && Math.round(aggregate * 100) >= 100;
      if (reachedFull) celebrated = true;
      completeItem(nodeId, "practice-prompt--correct", "Correct!", reachedFull ? null : CORRECT_PAUSE_MS);
      if (reachedFull) showCelebration();
    } else if (playedSan === null) {
      void refreshKnowledge();
      completeItem(nodeId, "", `The move was ${expectedSan}`, INCORRECT_PAUSE_MS);
    } else {
      void refreshKnowledge();
      // Allow another try instead of moving straight on — a single slip
      // shouldn't end the position, only a second miss (or giving up) does.
      showAnswerBtn.hidden = false;
      retryAtSamePrompt(nodeId, "Not quite — try again");
    }
  }

  function handleRetry(nodeId: number, correct: boolean): void {
    if (correct) {
      // Only the first answer counts: this position was recorded as a miss.
      completeItem(nodeId, "", "Got it on retry — recorded as a miss", CORRECT_PAUSE_MS);
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
    playMoveSound(move, chess);
    const expectedSan = tree.nodes[nodeId].san as string;
    const correct = move.san === expectedSan;
    if (!firstAttemptGraded) {
      // Freeze the board while the answer is saved: no second move until
      // then (handleFirstAttempt sets firstAttemptGraded at once, too).
      board.set({ movable: { color: undefined, dests: new Map() } });
      void handleFirstAttempt(nodeId, correct, move.san);
    } else {
      handleRetry(nodeId, correct);
    }
  }

  board = createBoard(boardEl, onMove, boardOrientation);
  board.set({ animation: { duration: PRACTICE_ANIMATION_MS } });

  function flipBoard(): void {
    boardOrientation = boardOrientation === "white" ? "black" : "white";
    board.set({ orientation: boardOrientation });
    setLichessOrientation(lichessAnalysisLink, boardOrientation);
  }

  flipBoardBtn.addEventListener("click", flipBoard);
  const focusMode = setupFocusMode({ main, button: document.getElementById("focus-btn") as HTMLButtonElement });

  // Same "f" shortcut as the Study editor and lichess.org's own analysis
  // board, and the same focus mode (Space, Z, Esc).
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (focusMode.handleKey(e)) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      flipBoard();
    }
  });

  showAnswerBtn.addEventListener("click", () => {
    if (awaitingNodeId === null) return;
    const nodeId = awaitingNodeId;
    const expectedSan = tree.nodes[nodeId].san as string;
    // Before any answer: recorded as a miss, as a wrong move would be.
    if (!firstAttemptGraded) {
      board.set({ movable: { color: undefined, dests: new Map() } });
      void handleFirstAttempt(nodeId, false, null);
      return;
    }
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

  void refreshKnowledge();
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

  // ?mode=bullet: Bullet practice instead (see bullet.ts).
  if (new URLSearchParams(window.location.search).get("mode") === "bullet") {
    let study: Study | null;
    let stats: BulletStats | null = null;
    try {
      const [loaded, , summaryRes] = await Promise.all([
        loadStudy(studyId),
        applyBoardTheme(),
        fetch("/api/practice/summary", { credentials: "same-origin" }),
      ]);
      study = loaded;
      if (summaryRes.ok) stats = (await summaryRes.json())[String(studyId)]?.bullet ?? null;
    } catch {
      main.innerHTML = `<div class="empty-state"><p>Could not load this study. Please try again.</p></div>`;
      return;
    }
    if (!study) {
      main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
      return;
    }
    const start = study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId;
    document.title = `Bullet · ${study.name} · lirep.org`;
    renderBullet(main, study, start, stats);
    return;
  }

  let study: Study | null;
  let queue: Queue;
  try {
    [study, , queue] = await Promise.all([loadStudy(studyId), applyBoardTheme(), loadQueue(studyId)]);
  } catch {
    // Network error / backend not running — same fallback practice.ts uses,
    // rather than leaving an unhandled rejection and a permanently blank page.
    main.innerHTML = `<div class="empty-state"><p>Could not load this study. Please try again.</p></div>`;
    return;
  }
  if (!study) {
    main.innerHTML = `<div class="empty-state"><p>Study not found.</p></div>`;
    return;
  }

  const startNodeId =
    study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId;
  const steps = buildSteps(study.tree, startNodeId, new Set(queue.nodeIds));
  renderSession(main, study, startNodeId, steps, queue.optional);
}

init();
