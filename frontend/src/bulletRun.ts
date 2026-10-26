// A Bullet run's game (see doc/bullet.md), apart from any page: shared by the
// website's Bullet page (bullet.ts) and the mobile app's.
//
// From the study's starting point, the computer plays the opponent's replies
// the study has, weighted by how often each is played in the Opening
// Explorer, and you play your prepared moves against a clock: 1 minute,
// plus 2 seconds for each correct move. A run succeeds when it reaches the
// end of a line in time; a wrong move or the clock running out ends it.
// Runs are recorded for the Practice page's stats.
//
// The Explorer data is what this browser already holds (its cache, see
// explorerClient.ts), read before a run: a position without it gets a
// uniform choice among the study's replies, until loadMissing() fetches it.
//
// Options, remembered in the browser: auto-restart after a success, and how
// the line is chosen after a success: by the Explorer's frequencies,
// uniformly among the study's replies, or cycling through the lines (each
// once, in random order, before any repeats; the cycle is kept per study).
// A failed run is retried on the same line whatever the choice.

import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import { computeDests, playMoveSound, toColor } from "./board";
import type { BulletStats } from "./bulletStats";
import { Engine } from "./engine";
import { evaluatePosition, getSavedEvalDepth, openEvaluationCache, type EvaluationCache } from "./evalCache";
import type { ExplorerData, ExplorerSettings } from "./explorer";
import { cachedExplorerData, errorMessage, fetchExplorerData } from "./explorerClient";
import { fetchMe } from "./layout";
import { lastMoveAt, lichessAnalysisUrl, pathTo, positionAt, sanPathTo, type StudyTree } from "./tree";

export interface BulletStudy {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  startNodeId: number | null;
  explorerSettings?: ExplorerSettings | null;
}

export const BASE_MS = 60_000;
export const INCREMENT_MS = 2_000;
export const LOW_TIME_MS = 10_000;
// The computer's moves come after this pause, the clock stopped, so you see
// them land.
const COMPUTER_DELAY_MS = 250;
// After a success with auto-restart on, the success screen stays this long.
export const AUTO_RESTART_MS = 2_000;

export type EndReason = "finished" | "time" | "wrong";

/** How the computer chooses its replies for a new line (see above). */
export type LineSelection = "explorer" | "uniform" | "cycle";
export const SELECTION_LABELS: Record<LineSelection, [string, string]> = {
  explorer: ["Explorer frequencies", "Each reply as often as it is played in the Explorer."],
  uniform: ["Uniform frequencies", "Each of your study's replies equally often."],
  cycle: ["Cycle", "Every line once, in random order, before any comes back."],
};
const AUTO_RESTART_KEY = "bullet-auto-restart";
const SELECTION_KEY = "bullet-line-selection";

function readOption(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeOption(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the choice for this page even when browser storage is blocked.
  }
}

/** How a run ended. */
export interface RunEnd {
  reason: EndReason;
  moves: number; // your correct moves
  usedMs: number; // the time you spent
  nodeId: number; // where it ended
  played?: string; // a wrong move
  expected?: string; // the prepared move instead
  analysisUrl: string; // the run on Lichess's analysis board
  line: string[]; // its moves from the initial position, a wrong one included
}

/** What a run's end shows: the evaluation there, and the last move's
 * Explorer results. */
export interface EndInfo {
  evaluation: { cp: number; depth: number } | { pending: true; depth: number } | { none: true; depth: number };
  explorer:
    | { san: string; games: number; white: number; draws: number; black: number }
    | { san: string; missing: "data" | "unlisted" }
    | null;
}

export interface BulletCallbacks {
  /** Every frame, and when the clock changes: what's left, and whether it's
   * running (your turn, in a run). */
  onClock(ms: number, ticking: boolean): void;
  onEnd(end: RunEnd): void;
  /** The study's Bullet stats, updated after a run is recorded. */
  onStats?(stats: BulletStats): void;
  /** How a run reaches the server (the mobile app keeps it while offline):
   * the updated stats, or null. By default, it's posted at once. */
  sendRun?(studyId: number, run: object): Promise<BulletStats | null>;
}

/** A study's Bullet game, playing on `board` (whose moves must reach
 * `onMove`). */
export class BulletGame {
  readonly study: BulletStudy;
  readonly startNodeId: number;
  private readonly tree: StudyTree;
  private board: Api | null = null;
  private readonly cb: BulletCallbacks;

  // Options.
  autoRestart = readOption(AUTO_RESTART_KEY) === "on";
  selection: LineSelection = (() => {
    const saved = readOption(SELECTION_KEY);
    return saved === "uniform" || saved === "cycle" ? saved : "explorer";
  })();

  // The Explorer's weights, for each position where the computer moves: its
  // replies' games, in the tree's order; null without data (uniform then).
  private readonly weights = new Map<number, number[] | null>();
  /** The positions where the computer moves. */
  readonly opponentNodes: number[] = [];
  /** Those whose Explorer data this browser doesn't hold yet. */
  readonly missing = new Set<number>();
  /** Resolves once the browser's Explorer data has been read. */
  readonly dataReady: Promise<void>;

  // The cycle: the study's lines, by the move each ends with, and those
  // played since the cycle began (kept per study in this browser).
  readonly lineEnds: number[] = [];
  private cycleDone: Set<number>;
  /** All the lines had been played: the cycle began again. */
  cycleRestarted = false;
  private readonly cycleKey: string;
  private targetPath = new Set<number>(); // towards the cycle's line

  // After a failed run, the next one follows the same line: it replays that
  // run's replies, then picks as usual past them. A success ends the replay.
  private runReplies: number[] = [];
  private replay: number[] = [];

  running = false;
  private starting = false;
  private nodeId: number;
  private clockMs = BASE_MS; // what's left, as of the start of your turn
  private turnStartedAt: number | null = null; // while your clock runs
  private moves = 0;
  private usedMs = 0;
  private frame = 0;
  private replyTimer = 0;
  private evaluationCache: Promise<EvaluationCache> | null = null;

  constructor(study: BulletStudy, startNodeId: number, callbacks: BulletCallbacks) {
    this.study = study;
    this.tree = study.tree;
    this.startNodeId = startNodeId;
    this.nodeId = startNodeId;
    this.cb = callbacks;

    const visit = (nodeId: number): void => {
      const node = this.tree.nodes[nodeId];
      if (!node.children.length) {
        this.lineEnds.push(nodeId);
        return;
      }
      if (!this.yourTurn(nodeId)) this.opponentNodes.push(nodeId);
      // Only your prepared move is followed; the computer's every reply.
      for (const childId of this.yourTurn(nodeId) ? node.children.slice(0, 1) : node.children) visit(childId);
    };
    visit(startNodeId);

    this.cycleKey = `bullet-cycle-${study.id}`;
    this.cycleDone = (() => {
      try {
        const saved = JSON.parse(readOption(this.cycleKey) ?? "[]");
        return new Set((Array.isArray(saved) ? saved : []).filter((id: unknown) => this.lineEnds.includes(id as number)));
      } catch {
        return new Set<number>();
      }
    })();

    const settings = study.explorerSettings;
    this.dataReady = settings
      ? Promise.all(
          this.opponentNodes.map(async (nodeId) => {
            let data;
            try {
              data = await cachedExplorerData(positionAt(this.tree, nodeId).fen(), settings, study.side);
            } catch {
              data = undefined;
            }
            if (data) this.setWeights(nodeId, data);
            else {
              this.weights.set(nodeId, null);
              this.missing.add(nodeId);
            }
          }),
        ).then(() => undefined)
      : Promise.resolve();
  }

  /** The board to play on: its moves must reach onMove(). */
  attach(board: Api): void {
    this.board = board;
    this.setBoard(this.startNodeId, false);
    this.drawClock();
  }

  // Whose move it is after `nodeId`: yours when the number of moves played
  // to reach it leaves your colour to move.
  private yourTurn(nodeId: number): boolean {
    return (sanPathTo(this.tree, nodeId).length % 2 === 0) === (this.study.side === "white");
  }

  private setWeights(nodeId: number, data: ExplorerData): void {
    const games = this.tree.nodes[nodeId].children.map((childId) => {
      const row = data.moves.find((m) => m.san === this.tree.nodes[childId].san);
      return row ? row.white + row.draws + row.black : 0;
    });
    this.weights.set(nodeId, games.some((g) => g > 0) ? games : null);
  }

  /** Fetches the missing positions from the Explorer, one after another
   * (paced, see explorerClient.ts); a run started meanwhile uses what has
   * arrived. Returns a failure's message, or null. */
  async loadMissing(onProgress: (done: number, total: number, resumeAt?: number) => void): Promise<string | null> {
    const settings = this.study.explorerSettings;
    if (!settings) return null;
    const total = this.missing.size;
    let done = 0;
    for (const nodeId of [...this.missing]) {
      onProgress(done, total);
      try {
        const data = await fetchExplorerData(positionAt(this.tree, nodeId).fen(), settings, this.study.side, {
          priority: "background",
          onRateLimited: (resumeAt) => onProgress(done, total, resumeAt),
        });
        this.setWeights(nodeId, data);
        this.missing.delete(nodeId);
      } catch (err) {
        return errorMessage(err) ?? "The Explorer is unavailable right now. Please try again.";
      }
      done += 1;
    }
    return null;
  }

  // --- Options -------------------------------------------------------------

  setAutoRestart(on: boolean): void {
    this.autoRestart = on;
    writeOption(AUTO_RESTART_KEY, on ? "on" : "off");
  }

  setSelection(selection: LineSelection): void {
    this.selection = selection;
    writeOption(SELECTION_KEY, selection);
  }

  /** The cycle's next line, 1-based. */
  get cycleLine(): number {
    return Math.min(this.cycleDone.size + 1, this.lineEnds.length);
  }

  /** The next run retries the line that failed. */
  get retrying(): boolean {
    return this.replay.length > 0;
  }

  // --- The computer's replies ----------------------------------------------

  private pickReply(nodeId: number): number {
    const children = this.tree.nodes[nodeId].children;
    const replayed = this.replay[this.runReplies.length];
    const reply = replayed !== undefined && children.includes(replayed) ? replayed : this.drawReply(nodeId);
    this.runReplies.push(reply);
    return reply;
  }

  // A reply for a new line: towards the cycle's chosen line, else drawn by
  // the Explorer's weights (uniformly without them), or uniformly.
  private drawReply(nodeId: number): number {
    const children = this.tree.nodes[nodeId].children;
    const towards = children.find((id) => this.targetPath.has(id));
    if (towards !== undefined) return towards;
    const w = this.selection === "uniform" ? children.map(() => 1) : (this.weights.get(nodeId) ?? children.map(() => 1));
    const total = w.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < children.length; i++) {
      r -= w[i];
      if (r < 0) return children[i];
    }
    return children[children.length - 1];
  }

  // A line not yet played in this cycle, at random; a new cycle once all were.
  private chooseCycleLine(): number {
    let left = this.lineEnds.filter((id) => !this.cycleDone.has(id));
    this.cycleRestarted = false;
    if (!left.length) {
      this.cycleDone = new Set();
      left = [...this.lineEnds];
      this.cycleRestarted = true;
    }
    return left[Math.floor(Math.random() * left.length)];
  }

  // --- The run ---------------------------------------------------------------

  private remaining(): number {
    return this.turnStartedAt === null ? this.clockMs : this.clockMs - (performance.now() - this.turnStartedAt);
  }

  private drawClock(): void {
    this.cb.onClock(this.remaining(), this.running && this.turnStartedAt !== null);
  }

  private tick = (): void => {
    if (!this.running) return;
    if (this.remaining() <= 0) {
      this.end("time");
      return;
    }
    this.drawClock();
    this.frame = requestAnimationFrame(this.tick);
  };

  private setBoard(at: number, interactive: boolean): void {
    const chess = positionAt(this.tree, at);
    this.board?.set({
      fen: chess.fen(),
      turnColor: toColor(chess),
      check: chess.isCheck(),
      lastMove: lastMoveAt(this.tree, at),
      movable: interactive ? { color: toColor(chess), dests: computeDests(chess) } : { color: undefined, dests: new Map() },
      drawable: { autoShapes: [] },
    });
  }

  // On to the next move: yours (the clock runs), the computer's, or the end.
  private proceed(): void {
    if (!this.running) return;
    const children = this.tree.nodes[this.nodeId].children;
    if (!children.length) return this.end("finished");
    if (this.yourTurn(this.nodeId)) {
      this.setBoard(this.nodeId, true);
      this.turnStartedAt = performance.now();
      return;
    }
    this.setBoard(this.nodeId, false);
    this.replyTimer = window.setTimeout(() => {
      if (!this.running) return;
      const replyId = this.pickReply(this.nodeId);
      const chess = positionAt(this.tree, this.nodeId);
      const move = chess.move(this.tree.nodes[replyId].san as string);
      this.nodeId = replyId;
      this.setBoard(this.nodeId, false);
      if (move) playMoveSound(move);
      this.proceed();
    }, COMPUTER_DELAY_MS);
  }

  /** Your move on the board. */
  onMove = (orig: Key, dest: Key): void => {
    if (!this.running || this.turnStartedAt === null) return;
    const spent = performance.now() - this.turnStartedAt;
    this.clockMs -= spent;
    this.usedMs += spent;
    this.turnStartedAt = null;
    if (this.clockMs <= 0) return this.end("time");
    const chess = positionAt(this.tree, this.nodeId);
    const move = chess.move({ from: orig, to: dest, promotion: "q" });
    if (!move) return;
    playMoveSound(move);
    const preparedId = this.tree.nodes[this.nodeId].children[0];
    if (move.san !== this.tree.nodes[preparedId].san) {
      // Show the prepared move, as an arrow from the position before.
      this.setBoard(this.nodeId, false);
      const prepared = positionAt(this.tree, this.nodeId).move(this.tree.nodes[preparedId].san as string);
      this.board?.set({ drawable: { autoShapes: [{ orig: prepared.from as Key, dest: prepared.to as Key, brush: "green" }] } });
      return this.end("wrong", move.san, this.tree.nodes[preparedId].san as string);
    }
    this.clockMs += INCREMENT_MS;
    this.moves += 1;
    this.nodeId = preparedId;
    this.proceed();
  };

  /** Starts a run: a new line, or the failed one again. */
  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.starting = true;
    await this.dataReady;
    this.starting = false;
    this.running = true;
    this.nodeId = this.startNodeId;
    this.clockMs = BASE_MS;
    this.turnStartedAt = null;
    this.moves = 0;
    this.usedMs = 0;
    this.runReplies = [];
    // A new line (not a retry, which keeps its line): the cycle chooses it;
    // otherwise replies are drawn as they come.
    if (!this.replay.length) {
      this.targetPath = new Set();
      if (this.selection === "cycle") for (const node of pathTo(this.tree, this.chooseCycleLine())) this.targetPath.add(node.id);
    }
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(this.tick);
    this.proceed();
  }

  private end(reason: EndReason, played?: string, expected?: string): void {
    if (!this.running) return;
    if (this.turnStartedAt !== null) {
      const spent = performance.now() - this.turnStartedAt;
      this.clockMs -= spent;
      this.usedMs += spent;
      this.turnStartedAt = null;
    }
    this.running = false;
    window.clearTimeout(this.replyTimer);
    cancelAnimationFrame(this.frame);
    if (reason === "time") this.clockMs = 0;
    this.drawClock();
    if (reason !== "wrong") this.setBoard(this.nodeId, false);
    this.replay = reason === "finished" ? [] : [...this.runReplies];
    if (reason === "finished" && this.selection === "cycle") {
      this.cycleDone.add(this.nodeId);
      writeOption(this.cycleKey, JSON.stringify([...this.cycleDone]));
    }
    // The run's moves on Lichess's analysis board, up to where it ended (the
    // wrong move included).
    const line = [...sanPathTo(this.tree, this.nodeId), ...(reason === "wrong" && played ? [played] : [])];
    this.cb.onEnd({
      reason,
      moves: this.moves,
      usedMs: this.usedMs,
      nodeId: this.nodeId,
      played,
      expected,
      analysisUrl: lichessAnalysisUrl(line, line.length, this.study.side),
      line,
    });
    void this.record(reason);
  }

  private async record(reason: EndReason): Promise<void> {
    const run = {
      success: reason === "finished",
      reason,
      moves: this.moves,
      timeMs: Math.round(this.usedMs),
      selection: this.selection,
      finishedAt: new Date().toISOString(),
    };
    if (this.cb.sendRun) {
      const stats = await this.cb.sendRun(this.study.id, run);
      if (stats) this.cb.onStats?.(stats);
      return;
    }
    try {
      const res = await fetch(`/api/studies/${this.study.id}/bullet/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(run),
      });
      if (res.ok) this.cb.onStats?.((await res.json()) as BulletStats);
    } catch {
      // The run just isn't counted.
    }
  }

  // --- A run's end: the evaluation and the last move's Explorer results --

  /** Calls `show` with what's known at `at`, then again once Stockfish has
   * evaluated it, if this browser hadn't already. */
  async endInfo(at: number, show: (info: EndInfo) => void): Promise<void> {
    const node = this.tree.nodes[at];
    const fen = positionAt(this.tree, at).fen();
    let explorer: EndInfo["explorer"] = null;
    if (node.san !== null && node.parentId !== null && this.study.explorerSettings) {
      let data;
      try {
        data = await cachedExplorerData(positionAt(this.tree, node.parentId).fen(), this.study.explorerSettings, this.study.side);
      } catch {
        data = undefined;
      }
      const row = data?.moves.find((m) => m.san === node.san);
      explorer = !data
        ? { san: node.san, missing: "data" }
        : !row
          ? { san: node.san, missing: "unlisted" }
          : { san: node.san, games: row.white + row.draws + row.black, white: row.white, draws: row.draws, black: row.black };
    }
    const depth = getSavedEvalDepth();
    this.evaluationCache ??= fetchMe().then((me) => openEvaluationCache(me.username ?? ""));
    const cache = await this.evaluationCache;
    const saved = await cache.get(fen, depth);
    if (saved !== undefined) return show({ evaluation: { cp: saved, depth }, explorer });
    // Not evaluated in this browser yet: Stockfish does it now, the clock
    // being stopped, and saves it for the editor and the Stats page.
    show({ evaluation: { pending: true, depth }, explorer });
    const engine = new Engine();
    try {
      const cp = await evaluatePosition(engine, new Chess(fen), depth);
      if (cp === null) return show({ evaluation: { none: true, depth }, explorer });
      await cache.set(fen, depth, cp);
      show({ evaluation: { cp, depth }, explorer });
    } finally {
      engine.terminate();
    }
  }

  /** Stops a run in progress without recording it (leaving the page). */
  destroy(): void {
    this.running = false;
    window.clearTimeout(this.replyTimer);
    cancelAnimationFrame(this.frame);
  }
}
