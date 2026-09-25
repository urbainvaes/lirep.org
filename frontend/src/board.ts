import { Chessground } from "@lichess-org/chessground";
import type { Api } from "@lichess-org/chessground/api";
import type { Color, Dests, Key } from "@lichess-org/chessground/types";
import { Chess } from "chess.js";

import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";

export function toColor(chess: Chess): Color {
  return chess.turn() === "w" ? "white" : "black";
}

export function computeDests(chess: Chess): Dests {
  const dests: Dests = new Map();
  for (const move of chess.moves({ verbose: true })) {
    const from = move.from as Key;
    const to = move.to as Key;
    const list = dests.get(from);
    if (list) list.push(to);
    else dests.set(from, [to]);
  }
  return dests;
}

/** A bare chessground board. Position/turn/dests are pushed in via api.set() by the caller. */
export function createBoard(el: HTMLElement, onMove: (orig: Key, dest: Key) => void): Api {
  return Chessground(el, {
    movable: {
      free: false,
      events: { after: onMove },
    },
  });
}

// Lichess CDN (same host lichess.org's own client loads these from). Board theme
// filenames don't all match their theme name, so this mirrors lila's own table:
// https://github.com/lichess-org/lila/blob/master/modules/pref/src/main/Theme.scala
const LICHESS_CDN = "https://lichess1.org/assets";

const BOARD_THEME_FILES: Record<string, string> = {
  brown: "brown.png",
  wood: "wood.jpg",
  wood2: "wood2.jpg",
  wood3: "wood3.jpg",
  wood4: "wood4.jpg",
  maple: "maple.jpg",
  maple2: "maple2.jpg",
  horsey: "horsey.jpg",
  leather: "leather.jpg",
  blue: "blue.png",
  blue2: "blue2.jpg",
  blue3: "blue3.jpg",
  canvas: "canvas2.jpg",
  "blue-marble": "blue-marble.jpg",
  ic: "ic.png",
  green: "green.png",
  marble: "marble.jpg",
  "green-plastic": "green-plastic.png",
  olive: "olive.jpg",
  grey: "grey.jpg",
  metal: "metal.jpg",
  newspaper: "svg/newspaper.svg",
  purple: "purple.png",
  "purple-diag": "purple-diag.png",
  pink: "pink-pyramid.png",
};

const PIECE_LETTERS: { cssClass: string; letter: string }[] = [
  { cssClass: "pawn", letter: "P" },
  { cssClass: "knight", letter: "N" },
  { cssClass: "bishop", letter: "B" },
  { cssClass: "rook", letter: "R" },
  { cssClass: "queen", letter: "Q" },
  { cssClass: "king", letter: "K" },
];

/**
 * Overrides chessground's bundled brown/cburnett look with the signed-in
 * player's actual Lichess board theme and piece set, hotlinked from
 * lichess1.org (the same CDN lichess.org itself serves them from).
 */
export function applyLichessBoardTheme(theme: string, pieceSet: string): void {
  const boardFile = BOARD_THEME_FILES[theme] ?? BOARD_THEME_FILES.brown;
  const rules = [`cg-board { background-image: url("${LICHESS_CDN}/images/board/${boardFile}"); }`];

  for (const color of ["white", "black"] as const) {
    const prefix = color === "white" ? "w" : "b";
    for (const { cssClass, letter } of PIECE_LETTERS) {
      const url = `${LICHESS_CDN}/piece/${pieceSet}/${prefix}${letter}.svg`;
      rules.push(`.cg-wrap piece.${cssClass}.${color} { background-image: url("${url}"); }`);
    }
  }

  let styleEl = document.getElementById("lichess-board-theme") as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "lichess-board-theme";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = rules.join("\n");
}

export function formatMoves(moves: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    const moveNumber = i / 2 + 1;
    const white = moves[i];
    const black = moves[i + 1];
    parts.push(black ? `${moveNumber}. ${white} ${black}` : `${moveNumber}. ${white}`);
  }
  return parts.join(" ");
}
