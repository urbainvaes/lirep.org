import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

// Small boards on cards (a study's games, the leaderboards): created when a
// card scrolls into view, showing a position at rest, and playing a line
// while the mouse is over the card.

/** A move as it's shown: the position after it, and its squares. */
export interface PlayedMove {
  fen: string;
  from: string;
  to: string;
}

export interface MiniBoard {
  orientation: "white" | "black";
  /** Where the line starts, and its moves. */
  startFen: string;
  moves: PlayedMove[];
  /** Shown at rest: by default, the start. */
  rest?: { fen: string; lastMove?: PlayedMove };
  /** The last move before the start, marked on the board there. */
  startLastMove?: PlayedMove;
  /** What the mouse goes over to play the line. */
  hoverEl: HTMLElement;
}

// The replay on hover: a move every PLAYBACK_MS.
const PLAYBACK_MS = 220;

const lastMove = (move: PlayedMove | undefined) => (move ? ([move.from, move.to] as Key[]) : undefined);

/** The positions and squares of `sans` played from `fen`; it stops at the
 * first move that isn't legal there. */
export function playSans(sans: string[], fen?: string): { startFen: string; moves: PlayedMove[] } {
  const chess = new Chess(fen);
  const startFen = chess.fen();
  const moves: PlayedMove[] = [];
  for (const san of sans) {
    try {
      const move = chess.move(san);
      moves.push({ fen: chess.fen(), from: move.from, to: move.to });
    } catch {
      break;
    }
  }
  return { startFen, moves };
}

/** Mounts the boards in `root`'s `[data-mini-board]` elements as they
 * scroll into view, with what `spec` gives for each (null: none). Returns
 * the function that takes them down, before `root` is rendered again. */
export function observeMiniBoards(root: HTMLElement, spec: (el: HTMLElement) => MiniBoard | null): () => void {
  const boards: Api[] = [];
  const timers = new Set<number>();

  function mount(el: HTMLElement): void {
    const b = spec(el);
    if (!b) return;
    const rest = () =>
      b.rest
        ? { fen: b.rest.fen, lastMove: lastMove(b.rest.lastMove) }
        : { fen: b.startFen, lastMove: lastMove(b.startLastMove) };
    const board = Chessground(el, {
      viewOnly: true,
      coordinates: false,
      orientation: b.orientation,
      animation: { duration: 120 },
      ...rest(),
    });
    boards.push(board);

    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timers.delete(timer);
      }
      timer = null;
    };
    b.hoverEl.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || !b.moves.length) return;
      stop();
      let ply = 0;
      board.set({ fen: b.startFen, lastMove: lastMove(b.startLastMove) });
      timer = window.setInterval(() => {
        const move = b.moves[ply++];
        board.set({ fen: move.fen, lastMove: lastMove(move) });
        if (ply >= b.moves.length) stop();
      }, PLAYBACK_MS);
      timers.add(timer);
    });
    b.hoverEl.addEventListener("pointerleave", () => {
      stop();
      board.set(rest());
    });
  }

  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        mount(entry.target as HTMLElement);
      }),
    { rootMargin: "200px" },
  );
  root.querySelectorAll<HTMLElement>("[data-mini-board]").forEach((el) => observer.observe(el));

  return () => {
    observer.disconnect();
    timers.forEach((timer) => window.clearInterval(timer));
    boards.forEach((board) => board.destroy());
  };
}
