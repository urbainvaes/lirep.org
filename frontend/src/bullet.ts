// Bullet practice, the website's page (see bullet.md and doc/bullet.html):
// the game itself (the clock, the computer's replies, the options, the
// runs' recording) is bulletRun.ts, shared with the mobile app; this is
// its page: the board and clock, the options, the Explorer data's note, the
// end of a run, the history and the keys.

import type { Api } from "@lichess-org/chessground/api";

import { createBoard } from "./board";
import type { BulletStats } from "./bulletStats";
import {
  AUTO_RESTART_MS,
  BASE_MS,
  BulletGame,
  LOW_TIME_MS,
  SELECTION_LABELS,
  type BulletStudy,
  type EndInfo,
  type LineSelection,
  type RunEnd,
} from "./bulletRun";
import { FOCUS_BUTTON_HTML, setupFocusMode } from "./focusMode";
import { escapeHtml } from "./layout";

export type { BulletStudy } from "./bulletRun";

// Centipawns from White's point of view, as Lichess shows them.
function formatEvaluation(cp: number): string {
  if (Math.abs(cp) > 90_000) return cp > 0 ? "White mates" : "Black mates";
  return `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;
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
            <button id="bullet-options-btn" class="bullet-options-btn" type="button" aria-expanded="false" aria-controls="bullet-options" title="Options" aria-label="Options"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
            <span id="bullet-cycle" class="bullet-cycle" hidden></span>
            <span class="bullet-stats" title="Runs that reached the end of the preparation, out of all runs, in the last 30 days">Successes in the last month: <strong id="bullet-stats">—</strong></span>
          </div>
          <div id="bullet-options" class="bullet-options" hidden>
            <button id="bullet-auto-restart" class="study-switch" type="button" role="switch" aria-checked="false"><span class="study-switch__track" aria-hidden="true"></span>Auto-restart after a success</button>
            <fieldset class="bullet-options__lines">
              <legend>After a success, the next line</legend>
              ${(Object.keys(SELECTION_LABELS) as LineSelection[])
                .map(
                  (key) => `<label class="tool-settings__radio" title="${SELECTION_LABELS[key][1]}"><input type="radio" name="bullet-selection" value="${key}" />${SELECTION_LABELS[key][0]}<span class="bullet-options__hint">${SELECTION_LABELS[key][1]}</span></label>`,
                )
                .join("")}
            </fieldset>
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
          <div id="bullet-end-info" class="bullet-end-info" hidden></div>
          <a id="bullet-analysis" class="bullet-analysis-link" target="_blank" rel="noopener noreferrer" hidden>Analyse this run on Lichess</a>
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
          <div id="bullet-done-info" class="bullet-end-info bullet-end-info--done"></div>
          <p id="bullet-done-restart" class="bullet-done__restart" hidden></p>
          <div class="bullet-done__actions">
            <button id="bullet-done-again" class="btn btn-primary" type="button">New run</button>
            <a id="bullet-done-analysis" class="btn btn-secondary" target="_blank" rel="noopener noreferrer">Analysis</a>
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
  const analysisLink = document.getElementById("bullet-analysis") as HTMLAnchorElement;
  const doneAnalysisLink = document.getElementById("bullet-done-analysis") as HTMLAnchorElement;
  const endInfoEl = document.getElementById("bullet-end-info") as HTMLElement;
  const doneInfoEl = document.getElementById("bullet-done-info") as HTMLElement;
  const doneRestartEl = document.getElementById("bullet-done-restart") as HTMLElement;
  const cycleEl = document.getElementById("bullet-cycle") as HTMLElement;
  const optionsBtn = document.getElementById("bullet-options-btn") as HTMLButtonElement;
  const optionsEl = document.getElementById("bullet-options") as HTMLElement;
  const autoRestartBtn = document.getElementById("bullet-auto-restart") as HTMLButtonElement;

  let stats = initialStats;
  const showStats = () => {
    statsEl.textContent = `${stats?.monthSuccesses ?? 0} / ${stats?.monthRuns ?? 0}`;
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
    doneRestartEl.hidden = !game.autoRestart;
    if (game.autoRestart) {
      doneRestartEl.textContent = "Next run in 2 seconds… (Esc to stay here)";
      restartTimer = window.setTimeout(() => void startRun(), AUTO_RESTART_MS);
    }
  }

  let restartTimer = 0;
  function hideDone(): void {
    window.clearTimeout(restartTimer);
    doneEl.hidden = true;
    doneConfettiEl.innerHTML = "";
  }

  // --- The clock -------------------------------------------------------
  let drawnClock = "";
  function drawClock(left: number, ticking: boolean): void {
    const html = clockHtml(left, ticking && Math.floor(left / 500) % 2 === 1);
    if (html !== drawnClock) clockTimeEl.innerHTML = drawnClock = html;
    clockEl.classList.toggle("bullet-clock--running", ticking);
    clockEl.classList.toggle("bullet-clock--low", game.running && left <= LOW_TIME_MS);
    clockFillEl.style.width = `${Math.max(0, Math.min(1, left / BASE_MS)) * 100}%`;
  }

  // --- The end of a run ------------------------------------------------
  let endInfoRun = 0;
  function renderEndInfo(info: EndInfo, run: number): void {
    if (run !== endInfoRun) return;
    const e = info.evaluation;
    const evaluation = "cp" in e
      ? `<strong>${formatEvaluation(e.cp)}</strong> (depth ${e.depth})`
      : "pending" in e
        ? `Stockfish is evaluating (depth ${e.depth})…`
        : "Stockfish gave none";
    const x = info.explorer;
    const explorerLine = !x
      ? ""
      : "missing" in x
        ? `${escapeHtml(x.san)}: ${x.missing === "data" ? "no Explorer data for this position in this browser" : "too rare to be listed in the Explorer"}`
        : (() => {
            const pct = (n: number) => `${Math.round((n / x.games) * 100)}%`;
            return `<strong>${escapeHtml(x.san)}</strong>: ${x.games.toLocaleString()} games · White ${pct(x.white)} · draws ${pct(x.draws)} · Black ${pct(x.black)}`;
          })();
    endInfoEl.innerHTML = doneInfoEl.innerHTML = `<p>Evaluation: ${evaluation}</p>${explorerLine ? `<p>Explorer: ${explorerLine}</p>` : ""}`;
    endInfoEl.hidden = false;
  }

  function onEnd(end: RunEnd): void {
    const { reason, moves } = end;
    const seconds = (end.usedMs / 1000).toFixed(1);
    const message = reason === "finished"
      ? `End of preparation reached in ${seconds} s`
      : reason === "time"
        ? `Out of time after ${moves} move${moves === 1 ? "" : "s"}`
        : `${end.played} — the prepared move was ${end.expected}`;
    statusEl.className = `practice-prompt bullet-status practice-prompt--${reason === "finished" ? "correct" : "incorrect"}`;
    statusEl.textContent = message;
    statusEl.hidden = false;
    analysisLink.href = doneAnalysisLink.href = end.analysisUrl;
    analysisLink.hidden = false;
    startBtn.hidden = false;
    showCycle();
    const run = endInfoRun;
    void game.endInfo(end.nodeId, (info) => renderEndInfo(info, run));
    startBtn.innerHTML = reason === "finished" ? `New run <kbd>Enter</kbd>` : `Retry this line <kbd>Enter</kbd>`;
    if (reason === "finished") showDone(`Reached in ${seconds} s, ${moves} move${moves === 1 ? "" : "s"} played.`);
    else startBtn.focus({ preventScroll: true });

    const item = document.createElement("li");
    item.className = `practice-history__item practice-history__item--${reason === "finished" ? "correct" : "incorrect"}`;
    item.textContent = message;
    historyEl.prepend(item);
  }

  const game = new BulletGame(study, startNodeId, {
    onClock: drawClock,
    onEnd,
    onStats: (updated: BulletStats) => {
      stats = updated;
      showStats();
    },
  });

  // --- Options ---------------------------------------------------------
  autoRestartBtn.setAttribute("aria-checked", String(game.autoRestart));
  autoRestartBtn.addEventListener("click", () => {
    game.setAutoRestart(!game.autoRestart);
    autoRestartBtn.setAttribute("aria-checked", String(game.autoRestart));
  });
  optionsEl.querySelectorAll<HTMLInputElement>('input[name="bullet-selection"]').forEach((input) => {
    input.checked = input.value === game.selection;
    input.addEventListener("change", () => {
      game.setSelection(input.value as LineSelection);
      showCycle();
    });
  });
  optionsBtn.addEventListener("click", () => {
    optionsEl.hidden = !optionsEl.hidden;
    optionsBtn.setAttribute("aria-expanded", String(!optionsEl.hidden));
  });
  showStats();

  function showCycle(): void {
    cycleEl.hidden = game.selection !== "cycle";
    cycleEl.textContent = `Line ${game.cycleLine} / ${game.lineEnds.length}`;
    cycleEl.title = game.cycleRestarted ? "All the lines were played: a new cycle began" : "Lines played in this cycle";
  }
  showCycle();

  // --- The Explorer data -------------------------------------------------
  function showDataNote(): void {
    const total = game.opponentNodes.length;
    const known = total - game.missing.size;
    dataNoteEl.textContent = total === 0
      ? "The computer has no replies to choose from here."
      : game.missing.size === 0
        ? `The Explorer's frequencies are known for all ${known} positions where the computer moves.`
        : `The Explorer's frequencies are known for ${known} of the ${total} positions where the computer moves; in the others it picks uniformly among your study's replies.`;
    loadExplorerBtn.hidden = game.missing.size === 0;
    loadExplorerBtn.textContent = `Calculate the missing Explorer moves (${game.missing.size})`;
  }
  if (study.explorerSettings) {
    void game.dataReady.then(showDataNote);
    loadExplorerBtn.addEventListener("click", async () => {
      loadExplorerBtn.disabled = true;
      const failure = await game.loadMissing((done, total, resumeAt) => {
        loadExplorerBtn.textContent = resumeAt
          ? `Lichess asks to wait: resuming at ${new Date(resumeAt).toLocaleTimeString()}…`
          : `Calculating… ${done} of ${total}`;
      });
      loadExplorerBtn.disabled = false;
      showDataNote();
      if (failure) dataNoteEl.textContent += ` ${failure}`;
    });
  } else {
    dataNoteEl.textContent = "No Explorer settings: the computer picks uniformly among your study's replies.";
  }

  // --- Starting a run ------------------------------------------------------
  async function startRun(): Promise<void> {
    if (game.running) return;
    endInfoRun += 1;
    endInfoEl.hidden = true;
    hideDone();
    startBtn.hidden = true;
    statusEl.hidden = true;
    analysisLink.hidden = true;
    await game.start();
  }

  const board: Api = createBoard(boardEl, game.onMove, study.side);
  game.attach(board);

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
    if (e.key === "Enter" && !game.running && !target.closest("a")) {
      e.preventDefault();
      void startRun();
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      flipBoard();
    }
  });
}
