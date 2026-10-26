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

const MOVE_SOUND_URLS = {
  move: "https://lichess1.org/assets/sound/standard/Move.mp3",
  capture: "https://lichess1.org/assets/sound/standard/Capture.mp3",
  check: "https://lichess1.org/assets/sound/standard/Check.mp3",
} as const;
type MoveSound = keyof typeof MOVE_SOUND_URLS;

// Keep an HTMLAudio fallback, but normally use decoded Web Audio buffers:
// starting a network-backed audio element on every move can lag behind the
// board animation on mobile. These tiny Lichess sounds are cached by the CDN.
const MOVE_SOUNDS: Record<MoveSound, HTMLAudioElement> = {
  move: new Audio(MOVE_SOUND_URLS.move),
  capture: new Audio(MOVE_SOUND_URLS.capture),
  check: new Audio(MOVE_SOUND_URLS.check),
};
for (const sound of Object.values(MOVE_SOUNDS)) {
  sound.preload = "auto";
  sound.load();
}

let audioContext: AudioContext | null = null;
try {
  if (typeof AudioContext !== "undefined") audioContext = new AudioContext();
} catch {
  // The HTMLAudio fallback still works if Web Audio is unavailable.
}
const moveBuffers = new Map<MoveSound, AudioBuffer>();

// A phone lets Web Audio start only from a user's gesture: the page's
// first taps (Start, an answer, any button) turn it on, so that every move
// sound, the computer's first ones included, plays at once rather than
// through the slower HTMLAudio fallback until your own first move.
if (audioContext) {
  const context = audioContext;
  const events = ["pointerdown", "touchend", "click", "keydown"] as const;
  const stop = () => events.forEach((name) => document.removeEventListener(name, unlock, true));
  const unlock = () => {
    if (context.state === "running") return stop();
    void context.resume().then(() => {
      if (context.state === "running") stop();
    }, () => {});
  };
  events.forEach((name) => document.addEventListener(name, unlock, true));
}
if (audioContext) {
  for (const [name, url] of Object.entries(MOVE_SOUND_URLS) as [MoveSound, string][]) {
    void fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Move sound: HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => audioContext.decodeAudioData(data))
      .then((buffer) => moveBuffers.set(name, buffer))
      .catch(() => {
        // Keep using the HTMLAudio fallback if Web Audio preload fails.
      });
  }
}

function playFallbackSound(kind: MoveSound): void {
  const sound = MOVE_SOUNDS[kind];
  sound.currentTime = 0;
  void sound.play().catch(() => {
    // Browsers may block sound until the user interacts with the page.
  });
}

function startMoveBuffer(audioContext: AudioContext, kind: MoveSound): void {
  const source = audioContext.createBufferSource();
  source.buffer = moveBuffers.get(kind) as AudioBuffer;
  source.connect(audioContext.destination);
  source.start();
}

export function playMoveSound(move: ReturnType<Chess["move"]>, chess: Chess): void {
  const kind: MoveSound = chess.isCheck() ? "check" : move.isCapture() ? "capture" : "move";
  if (!audioContext) return playFallbackSound(kind);
  if (audioContext.state === "running" && moveBuffers.has(kind)) return startMoveBuffer(audioContext, kind);
  // Not running yet: ask it to resume (from the move gesture when there is
  // one; later sounds then use Web Audio), but play this one now. Without a
  // gesture, resume() can stay pending until the next tap, and a sound
  // played then would come late.
  if (audioContext.state !== "running") void audioContext.resume().catch(() => {});
  playFallbackSound(kind);
}

/** A bare chessground board. Position/turn/dests are pushed in via api.set() by the caller. */
export function createBoard(el: HTMLElement, onMove: (orig: Key, dest: Key) => void, orientation: Color = "white"): Api {
  return Chessground(el, {
    orientation,
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

// The theme last read, kept in this browser: applied at once, before the
// board is first drawn, while the server asks Lichess for the current one
// (which takes a moment, and would show chessground's default meanwhile).
const BOARD_THEME_STORAGE_KEY = "lirep-board-theme";

export async function applyBoardTheme(): Promise<void> {
  let kept: string | null = null;
  try {
    kept = localStorage.getItem(BOARD_THEME_STORAGE_KEY);
    if (kept) {
      const { theme, pieceSet } = JSON.parse(kept);
      applyLichessBoardTheme(theme, pieceSet);
    }
  } catch {
    // Blocked storage or a bad entry: wait for the server's.
  }
  try {
    const res = await fetch("/api/board-theme", { credentials: "same-origin" });
    if (!res.ok) return;
    const { theme, pieceSet } = await res.json();
    const current = JSON.stringify({ theme, pieceSet });
    if (current === kept) return;
    applyLichessBoardTheme(theme, pieceSet);
    try {
      localStorage.setItem(BOARD_THEME_STORAGE_KEY, current);
    } catch {
      // Applied for this page all the same.
    }
  } catch {
    // Network error / backend not running: chessground's bundled default look stays.
  }
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
