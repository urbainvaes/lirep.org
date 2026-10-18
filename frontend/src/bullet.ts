// Bullet practice (see bullet.md): from the study's starting point, the
// computer plays the opponent's replies the study has, weighted by how often
// each is played in the Opening Explorer, and you play your prepared moves
// against a clock: 1 minute, plus 2 seconds for each correct move. A run
// succeeds when it reaches the end of a line in time; a wrong move or the
// clock running out ends it. Runs are recorded for the Practice page's
// stats, apart from the spaced-repetition knowledge.
//
// The Explorer data is what this browser already holds (its cache, see
// explorerClient.ts), read before a run: a position without it gets a
// uniform choice among the study's replies, until the info box's button
// fetches what's missing.

import type { Api } from "@lichess-org/chessground/api";
import type { Color, Key } from "@lichess-org/chessground/types";

import { computeDests, createBoard, playMoveSound, toColor } from "./board";
import type { ExplorerData, ExplorerSettings } from "./explorer";
import type { BulletStats } from "./bulletStats";
import { cachedExplorerData, errorMessage, fetchExplorerData } from "./explorerClient";
import { FOCUS_BUTTON_HTML, setupFocusMode } from "./focusMode";
import { escapeHtml } from "./layout";
import { lastMoveAt, positionAt, sanPathTo, type StudyTree } from "./tree";

export interface BulletStudy {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  startNodeId: number | null;
  explorerSettings?: ExplorerSettings | null;
}

const BASE_MS = 60_000;
const INCREMENT_MS = 2_000;
// The computer's moves come after this pause, the clock stopped, so you see
// them land.
const COMPUTER_DELAY_MS = 250;
const LOW_TIME_MS = 10_000;

type EndReason = "finished" | "time" | "wrong";

async function recordRun(studyId: number, reason: EndReason, moves: number, timeMs: number): Promise<BulletStats | null> {
  try {
    const res = await fetch(`/api/studies/${studyId}/bullet/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ success: reason === "finished", reason, moves, timeMs: Math.round(timeMs) }),
    });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

// As on Lichess: minutes and seconds, and the tenths under 10 seconds.
// `dimSep`: the colon's off half of each second while the clock runs.
function clockHtml(ms: number, dimSep = false): string {
  const tenths = Math.max(0, Math.ceil(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const sep = `<span class="bullet-clock__sep${dimSep ? " bullet-clock__sep--dim" : ""}">:</span>`;
  const tail = ms < LOW_TIME_MS ? `<span class="bullet-clock__tenths">.${tenths % 10}</span>` : "";
  return `${minutes}${sep}${String(seconds).padStart(2, "0")}${tail}`;
}

export function renderBullet(main: HTMLElement, study: BulletStudy, startNodeId: number, initialStats: BulletStats | null): void {
  const tree = study.tree;
  let stats = initialStats;

  main.innerHTML = `
    <div class="practice-session bullet">
      <div class="practice-session__header">
        <h1 class="page-title">${escapeHtml(study.name)} <span class="bullet-title-tag">Bullet</span></h1>
        <div class="practice-session__header-right">
          <a class="btn btn-secondary" href="/practice-session.html?id=${study.id}">Practice instead</a>
          <a class="btn btn-secondary" href="/practice.html">Back to Practice</a>
        </div>
      </div>
      <div class="practice-layout">
        <div class="bullet-board-col">
          <div class="practice-session__tools">
            <button id="flip-board-btn" class="board-flip-btn" type="button" data-icon="&#xe07b;" title="Flip board (f)" aria-label="Flip board"></button>
            ${FOCUS_BUTTON_HTML}
            <span class="bullet-stats">Successes in the last month: <strong id="bullet-stats">—</strong></span>
          </div>
          <div class="study-card study-card--board">
            <div id="board" class="study-board"></div>
          </div>
          <div class="bullet-controls">
            <button id="bullet-start" class="btn btn-primary bullet-start" type="button">Start <kbd>Enter</kbd></button>
            <div id="bullet-clock" class="bullet-clock" role="timer" aria-live="off" aria-label="Your clock">
              <span id="bullet-clock-time" class="bullet-clock__time">${clockHtml(BASE_MS)}</span>
              <div class="bullet-clock__bar"><div id="bullet-clock-fill" class="bullet-clock__fill"></div></div>
            </div>
          </div>
          <p id="bullet-status" class="practice-prompt bullet-status" hidden></p>
        </div>
        <div class="bullet-side-col">
          <div class="study-card bullet-info" role="note">
            <p>
              Reach the end of your preparation before the clock runs out: 1 minute, plus 2 seconds for each correct
              move. The computer answers as players do in the Explorer; a wrong move ends the run.
            </p>
            <p id="bullet-data-note">Reading the Explorer data in this browser…</p>
            <button id="bullet-load-explorer" class="btn btn-primary bullet-info__btn" type="button" hidden></button>
          </div>
          <ul id="bullet-history" class="practice-history"></ul>
        </div>
      </div>
      <div id="bullet-done" class="bullet-done" role="dialog" aria-modal="true" aria-labelledby="bullet-done-title" hidden>
        <div id="bullet-done-confetti" class="bullet-done__confetti" aria-hidden="true"></div>
        <div class="bullet-done__box">
          <h2 id="bullet-done-title" class="bullet-done__title">End of preparation!</h2>
          <p id="bullet-done-detail" class="bullet-done__detail"></p>
          <div class="bullet-done__actions">
            <button id="bullet-done-again" class="btn btn-primary" type="button">New run</button>
            <a class="btn btn-secondary" href="/practice.html">Back to practice</a>
          </div>
        </div>
      </div>
    </div>
  `;

  const boardEl = document.getElementById("board") as HTMLElement;
  const clockEl = document.getElementById("bullet-clock") as HTMLElement;
  const clockTimeEl = document.getElementById("bullet-clock-time") as HTMLElement;
  const clockFillEl = document.getElementById("bullet-clock-fill") as HTMLElement;
  const statusEl = document.getElementById("bullet-status") as HTMLElement;
  const startBtn = document.getElementById("bullet-start") as HTMLButtonElement;
  const statsEl = document.getElementById("bullet-stats") as HTMLElement;
  const dataNoteEl = document.getElementById("bullet-data-note") as HTMLElement;
  const loadExplorerBtn = document.getElementById("bullet-load-explorer") as HTMLButtonElement;
  const historyEl = document.getElementById("bullet-history") as HTMLElement;
  const doneEl = document.getElementById("bullet-done") as HTMLElement;
  const doneConfettiEl = document.getElementById("bullet-done-confetti") as HTMLElement;
  const doneDetailEl = document.getElementById("bullet-done-detail") as HTMLElement;
  const doneAgainBtn = document.getElementById("bullet-done-again") as HTMLButtonElement;

  const showStats = () => {
    statsEl.textContent = String(stats?.monthSuccesses ?? 0);
  };

  // A run that reached the end: a popup over the page, with confetti.
  function showDone(detail: string): void {
    doneDetailEl.textContent = detail;
    doneConfettiEl.innerHTML = Array.from({ length: 60 }, (_, i) => {
      const style = [
        `--x: ${Math.random() * 100}vw`,
        `--drift: ${(Math.random() - 0.5) * 30}vw`,
        `--spin: ${(Math.random() - 0.5) * 1440}deg`,
        `--delay: ${Math.random() * 0.6}s`,
        `--duration: ${2.2 + Math.random() * 1.6}s`,
        `--hue: ${(i * 47) % 360}`,
      ].join("; ");
      return `<span style="${style}"></span>`;
    }).join("");
    doneEl.hidden = false;
    doneAgainBtn.focus({ preventScroll: true });
  }

  function hideDone(): void {
    doneEl.hidden = true;
    doneConfettiEl.innerHTML = "";
  }
  showStats();

  // Whose move it is after `nodeId`: yours when the number of moves played
  // to reach it leaves your colour to move.
  const yourTurn = (nodeId: number) => (sanPathTo(tree, nodeId).length % 2 === 0) === (study.side === "white");

  // For each position where the computer moves, its replies' weights: games
  // in the Explorer, in the order of the tree's moves; null when there is no
  // Explorer data there (a uniform choice then).
  const weights = new Map<number, number[] | null>();
  // The positions whose Explorer data this browser doesn't hold yet.
  const missing = new Set<number>();
  const opponentNodes: number[] = [];
  let weightsReady: Promise<void> = Promise.resolve();

  function setWeights(nodeId: number, data: ExplorerData): void {
    const games = tree.nodes[nodeId].children.map((childId) => {
      const row = data.moves.find((m) => m.san === tree.nodes[childId].san);
      return row ? row.white + row.draws + row.black : 0;
    });
    weights.set(nodeId, games.some((g) => g > 0) ? games : null);
  }

  function showDataNote(): void {
    const known = opponentNodes.length - missing.size;
    dataNoteEl.textContent = opponentNodes.length === 0
      ? "The computer has no replies to choose from here."
      : missing.size === 0
        ? `The Explorer's frequencies are known for all ${known} positions where the computer moves.`
        : `The Explorer's frequencies are known for ${known} of the ${opponentNodes.length} positions where the computer moves; in the others it picks uniformly among your study's replies.`;
    loadExplorerBtn.hidden = missing.size === 0;
    loadExplorerBtn.textContent = `Calculate the missing Explorer moves (${missing.size})`;
  }

  if (study.explorerSettings) {
    const settings = study.explorerSettings;
    const visit = (nodeId: number): void => {
      const node = tree.nodes[nodeId];
      if (node.children.length && !yourTurn(nodeId)) opponentNodes.push(nodeId);
      // Only your prepared move is followed; the computer's every reply.
      const next = yourTurn(nodeId) ? node.children.slice(0, 1) : node.children;
      for (const childId of next) visit(childId);
    };
    visit(startNodeId);
    weightsReady = Promise.all(
      opponentNodes.map(async (nodeId) => {
        let data;
        try {
          data = await cachedExplorerData(positionAt(tree, nodeId).fen(), settings, study.side);
        } catch {
          data = undefined;
        }
        if (data) setWeights(nodeId, data);
        else {
          weights.set(nodeId, null);
          missing.add(nodeId);
        }
      }),
    ).then(showDataNote);

    // Fetches the missing positions from the Explorer, one after another
    // (paced, see explorerClient.ts); a run started meanwhile uses what has
    // arrived.
    loadExplorerBtn.addEventListener("click", async () => {
      loadExplorerBtn.disabled = true;
      const total = missing.size;
      let done = 0;
      let failure: string | null = null;
      for (const nodeId of [...missing]) {
        loadExplorerBtn.textContent = `Calculating… ${done} of ${total}`;
        try {
          const data = await fetchExplorerData(positionAt(tree, nodeId).fen(), settings, study.side, {
            priority: "background",
            onRateLimited: (resumeAt) => {
              loadExplorerBtn.textContent = `Lichess asks to wait: resuming at ${new Date(resumeAt).toLocaleTimeString()}…`;
            },
          });
          setWeights(nodeId, data);
          missing.delete(nodeId);
        } catch (err) {
          failure = errorMessage(err) ?? "The Explorer is unavailable right now. Please try again.";
          break;
        }
        done += 1;
      }
      loadExplorerBtn.disabled = false;
      showDataNote();
      if (failure) dataNoteEl.textContent += ` ${failure}`;
    });
  } else {
    dataNoteEl.textContent = "No Explorer settings: the computer picks uniformly among your study's replies.";
  }

  // The computer's reply after `nodeId`.
  function pickReply(nodeId: number): number {
    const children = tree.nodes[nodeId].children;
    const w = weights.get(nodeId) ?? children.map(() => 1);
    const total = w.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < children.length; i++) {
      r -= w[i];
      if (r < 0) return children[i];
    }
    return children[children.length - 1];
  }

  let board: Api;
  const orientation: Color = study.side;
  let running = false;
  let nodeId = startNodeId;
  let clockMs = BASE_MS; // what's left, as of the start of your current turn
  let turnStartedAt: number | null = null; // while your clock runs
  let moves = 0;
  let usedMs = 0;
  let frame = 0;
  let replyTimer = 0;

  const remaining = () => (turnStartedAt === null ? clockMs : clockMs - (performance.now() - turnStartedAt));

  let drawnClock = "";
  function drawClock(): void {
    const left = remaining();
    const ticking = running && turnStartedAt !== null;
    const html = clockHtml(left, ticking && Math.floor(left / 500) % 2 === 1);
    if (html !== drawnClock) clockTimeEl.innerHTML = drawnClock = html;
    clockEl.classList.toggle("bullet-clock--running", ticking);
    clockEl.classList.toggle("bullet-clock--low", running && left <= LOW_TIME_MS);
    clockFillEl.style.width = `${Math.max(0, Math.min(1, left / BASE_MS)) * 100}%`;
  }

  function tick(): void {
    if (!running) return;
    if (remaining() <= 0) {
      endRun("time");
      return;
    }
    drawClock();
    frame = requestAnimationFrame(tick);
  }

  function setBoard(at: number, interactive: boolean): void {
    const chess = positionAt(tree, at);
    board.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      lastMove: lastMoveAt(tree, at),
      movable: interactive ? { color: toColor(chess), dests: computeDests(chess) } : { color: undefined, dests: new Map() },
      drawable: { autoShapes: [] },
    });
  }

  // On to the next move: yours (the clock runs), the computer's, or the end.
  function proceed(): void {
    if (!running) return;
    const children = tree.nodes[nodeId].children;
    if (!children.length) return endRun("finished");
    if (yourTurn(nodeId)) {
      setBoard(nodeId, true);
      turnStartedAt = performance.now();
      return;
    }
    setBoard(nodeId, false);
    replyTimer = window.setTimeout(() => {
      if (!running) return;
      const replyId = pickReply(nodeId);
      const chess = positionAt(tree, nodeId);
      const move = chess.move(tree.nodes[replyId].san as string);
      nodeId = replyId;
      setBoard(nodeId, false);
      if (move) playMoveSound(move, chess);
      proceed();
    }, COMPUTER_DELAY_MS);
  }

  function onMove(orig: Key, dest: Key): void {
    if (!running || turnStartedAt === null) return;
    const spent = performance.now() - turnStartedAt;
    clockMs -= spent;
    usedMs += spent;
    turnStartedAt = null;
    if (clockMs <= 0) return endRun("time");
    const chess = positionAt(tree, nodeId);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    playMoveSound(move, chess);
    const preparedId = tree.nodes[nodeId].children[0];
    if (move.san !== tree.nodes[preparedId].san) {
      // Show the prepared move, as an arrow from the position before.
      setBoard(nodeId, false);
      const prepared = positionAt(tree, nodeId).move(tree.nodes[preparedId].san as string);
      board.set({ drawable: { autoShapes: [{ orig: prepared.from as Key, dest: prepared.to as Key, brush: "green" }] } });
      return endRun("wrong", move.san, tree.nodes[preparedId].san as string);
    }
    clockMs += INCREMENT_MS;
    moves += 1;
    nodeId = preparedId;
    proceed();
  }

  let starting = false;
  async function startRun(): Promise<void> {
    if (running || starting) return;
    starting = true;
    await weightsReady;
    starting = false;
    running = true;
    nodeId = startNodeId;
    clockMs = BASE_MS;
    turnStartedAt = null;
    moves = 0;
    usedMs = 0;
    hideDone();
    startBtn.hidden = true;
    statusEl.hidden = true;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
    proceed();
  }

  function endRun(reason: EndReason, played?: string, expected?: string): void {
    if (!running) return;
    if (turnStartedAt !== null) {
      const spent = performance.now() - turnStartedAt;
      clockMs -= spent;
      usedMs += spent;
      turnStartedAt = null;
    }
    running = false;
    window.clearTimeout(replyTimer);
    cancelAnimationFrame(frame);
    if (reason === "time") clockMs = 0;
    drawClock();
    if (reason !== "wrong") setBoard(nodeId, false);
    const seconds = (usedMs / 1000).toFixed(1);
    const message = reason === "finished"
      ? `End of preparation reached in ${seconds} s`
      : reason === "time"
        ? `Out of time after ${moves} move${moves === 1 ? "" : "s"}`
        : `${played} — the prepared move was ${expected}`;
    statusEl.className = `practice-prompt bullet-status practice-prompt--${reason === "finished" ? "correct" : "incorrect"}`;
    statusEl.textContent = message;
    statusEl.hidden = false;
    startBtn.hidden = false;
    startBtn.innerHTML = `Run again <kbd>Enter</kbd>`;
    if (reason === "finished") showDone(`Reached in ${seconds} s, ${moves} move${moves === 1 ? "" : "s"} played.`);
    else startBtn.focus({ preventScroll: true });

    const item = document.createElement("li");
    item.className = `practice-history__item practice-history__item--${reason === "finished" ? "correct" : "incorrect"}`;
    item.textContent = message;
    historyEl.prepend(item);

    void recordRun(study.id, reason, moves, usedMs).then((updated) => {
      if (updated) {
        stats = updated;
        showStats();
      }
    });
  }

  board = createBoard(boardEl, onMove, orientation);
  setBoard(startNodeId, false);
  drawClock();

  const flipBoard = () => board.set({ orientation: board.state.orientation === "white" ? "black" : "white" });
  startBtn.addEventListener("click", () => void startRun());
  doneAgainBtn.addEventListener("click", () => void startRun());
  doneEl.addEventListener("click", (e) => {
    if (e.target === doneEl) hideDone();
  });
  (document.getElementById("flip-board-btn") as HTMLButtonElement).addEventListener("click", flipBoard);
  const focusMode = setupFocusMode({ main, button: document.getElementById("focus-btn") as HTMLButtonElement });
  // Enter starts a run; f flips the board and Space, Z or Esc switch focus
  // mode, as elsewhere.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if (e.key === "Escape" && !doneEl.hidden) {
      e.preventDefault();
      hideDone();
      return;
    }
    if (focusMode.handleKey(e)) return;
    if (e.key === "Enter" && !running && !target.closest("a")) {
      e.preventDefault();
      void startRun();
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      flipBoard();
    }
  });
}
