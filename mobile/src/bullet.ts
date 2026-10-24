// Bullet on one study, as on the website (bullet.md): the game is the
// website's (bulletRun.ts); this is its screen for a phone. The board across
// the screen; under it the clock and Start; two toggles for the options; the
// result of each run.

import type { Api } from "@lichess-org/chessground/api";

import { createBoard } from "@web/board";
import { AUTO_RESTART_MS, BASE_MS, BulletGame, LOW_TIME_MS, type EndInfo, type LineSelection, type RunEnd } from "@web/bulletRun";
import { escapeHtml } from "@web/layout";

import { practiceSummary, study as loadStudy } from "./api";

const SELECTIONS: LineSelection[] = ["explorer", "uniform", "cycle"];
const SELECTION_SHORT: Record<LineSelection, string> = { explorer: "Explorer", uniform: "Uniform", cycle: "Cycle" };

// 0:58, and the tenths under 10 seconds: 0:07.4.
function clockText(ms: number): string {
  const tenths = Math.max(0, Math.ceil(ms / 100));
  const text = `${Math.floor(tenths / 600)}:${String(Math.floor((tenths % 600) / 10)).padStart(2, "0")}`;
  return ms < LOW_TIME_MS ? `${text}.${tenths % 10}` : text;
}

function evaluationText(info: EndInfo): string {
  const e = info.evaluation;
  if (!("cp" in e)) return "pending" in e ? "…" : "";
  if (Math.abs(e.cp) > 90_000) return e.cp > 0 ? "White mates" : "Black mates";
  return `${e.cp > 0 ? "+" : ""}${(e.cp / 100).toFixed(2)}`;
}

/** Renders the screen; returns what to undo on leaving it. */
export async function renderBullet(app: HTMLElement, id: number): Promise<() => void> {
  const [study, summaries] = await Promise.all([loadStudy(id), practiceSummary().catch(() => null)]);
  const start = study.startNodeId !== null && study.startNodeId in study.tree.nodes ? study.startNodeId : study.tree.rootId;
  let stats = summaries?.[String(id)]?.bullet ?? null;

  app.innerHTML = `
    <div class="session bullet">
      <header class="bar">
        <a class="bar__back" href="#/practice" aria-label="Back">‹</a>
        <h1 class="bar__title">${escapeHtml(study.name)}</h1>
        <span class="bar__aside" id="stats" title="Successes in the last month"></span>
      </header>
      <div class="session__above">
        <div class="session__status">
          <span class="session__prompt" id="result" aria-live="polite"></span>
          <span class="session__progress" id="eval"></span>
        </div>
      </div>
      <div class="session__board"><div id="board" class="board"></div></div>
      <div class="session__below">
        <div class="clock" id="clock" role="timer" aria-label="Your clock">
          <span class="clock__time" id="clock-time">${clockText(BASE_MS)}</span>
          <button class="button button--primary clock__start" type="button" id="start">Start</button>
          <div class="clock__bar"><div class="clock__fill" id="clock-fill"></div></div>
        </div>
      </div>
      <div class="session__toolbar bullet__options">
        <button class="chip" type="button" id="selection" title="How the computer chooses the next line"></button>
        <button class="chip" type="button" id="auto" title="Start the next run by itself after a success" aria-pressed="false">↻ Auto</button>
        <button class="chip" type="button" id="load" hidden title="Fetch the Explorer's frequencies this browser lacks"></button>
        <a class="chip" id="analysis" target="_blank" rel="noopener" hidden>Analysis</a>
      </div>
      <div class="done" id="done" hidden>
        <div class="done__mark">✓</div>
        <div class="done__time" id="done-time"></div>
      </div>
    </div>
  `;
  const el = (id: string) => document.getElementById(id) as HTMLElement;
  const clockEl = el("clock");
  const timeEl = el("clock-time");
  const fillEl = el("clock-fill");
  const startBtn = el("start") as HTMLButtonElement;
  const resultEl = el("result");
  const evalEl = el("eval");
  const selectionBtn = el("selection") as HTMLButtonElement;
  const autoBtn = el("auto") as HTMLButtonElement;
  const loadBtn = el("load") as HTMLButtonElement;
  const analysisLink = el("analysis") as HTMLAnchorElement;
  const doneEl = el("done");
  let restartTimer: number | undefined;
  let endRun = 0;

  const showStats = () => {
    el("stats").textContent = stats ? `${stats.monthSuccesses}/${stats.monthRuns}` : "";
  };

  function onClock(ms: number, ticking: boolean): void {
    timeEl.textContent = clockText(ms);
    clockEl.classList.toggle("clock--running", ticking);
    clockEl.classList.toggle("clock--low", game.running && ms <= LOW_TIME_MS);
    fillEl.style.width = `${Math.max(0, Math.min(1, ms / BASE_MS)) * 100}%`;
  }

  function onEnd(end: RunEnd): void {
    const seconds = (end.usedMs / 1000).toFixed(1);
    resultEl.textContent = end.reason === "finished"
      ? `✓ ${seconds} s`
      : end.reason === "time"
        ? `Time · ${end.moves} moves`
        : `${end.played} → ${end.expected}`;
    resultEl.className = `session__prompt session__prompt--${end.reason === "finished" ? "good" : "bad"}`;
    analysisLink.href = end.analysisUrl;
    analysisLink.hidden = false;
    startBtn.hidden = false;
    startBtn.textContent = end.reason === "finished" ? "Start" : "Again";
    showOptions();
    const run = endRun;
    void game.endInfo(end.nodeId, (info) => {
      if (run === endRun) evalEl.textContent = evaluationText(info);
    });
    if (end.reason === "finished") {
      el("done-time").textContent = `${seconds} s`;
      doneEl.hidden = false;
      restartTimer = window.setTimeout(() => {
        doneEl.hidden = true;
        if (game.autoRestart) void startRun();
      }, game.autoRestart ? AUTO_RESTART_MS : 1200);
    }
  }

  const game = new BulletGame(study, start, {
    onClock,
    onEnd,
    onStats: (updated) => {
      stats = updated;
      showStats();
    },
  });

  function showOptions(): void {
    selectionBtn.textContent = game.selection === "cycle"
      ? `Cycle ${game.cycleLine}/${game.lineEnds.length}`
      : SELECTION_SHORT[game.selection];
    autoBtn.setAttribute("aria-pressed", String(game.autoRestart));
    loadBtn.hidden = game.missing.size === 0;
    loadBtn.textContent = `Load ${game.missing.size}`;
  }

  async function startRun(): Promise<void> {
    if (game.running) return;
    window.clearTimeout(restartTimer);
    doneEl.hidden = true;
    endRun += 1;
    startBtn.hidden = true;
    resultEl.textContent = "";
    evalEl.textContent = "";
    analysisLink.hidden = true;
    await game.start();
  }

  selectionBtn.addEventListener("click", () => {
    game.setSelection(SELECTIONS[(SELECTIONS.indexOf(game.selection) + 1) % SELECTIONS.length]);
    showOptions();
  });
  autoBtn.addEventListener("click", () => {
    game.setAutoRestart(!game.autoRestart);
    showOptions();
  });
  loadBtn.addEventListener("click", async () => {
    loadBtn.disabled = true;
    await game.loadMissing((done, total) => {
      loadBtn.textContent = `Loading ${done}/${total}`;
    });
    loadBtn.disabled = false;
    showOptions();
  });
  startBtn.addEventListener("click", () => void startRun());
  doneEl.addEventListener("click", () => {
    window.clearTimeout(restartTimer);
    doneEl.hidden = true;
  });

  const board: Api = createBoard(el("board"), game.onMove, study.side);
  game.attach(board);
  showStats();
  showOptions();
  void game.dataReady.then(showOptions);

  return () => {
    window.clearTimeout(restartTimer);
    game.destroy();
    board.destroy();
  };
}
