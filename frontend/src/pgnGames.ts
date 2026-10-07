import { Chess } from "chess.js";

// Games for a study's Games page, read from PGN with chess.js: the moves of
// the game itself (variations inside a game are dropped) and its comments.

export interface GameMove {
  san: string;
  fen: string; // after the move
  from: string;
  to: string;
  comment?: string;
}

export interface ParsedGame {
  headers: Record<string, string>;
  startFen: string;
  startComment?: string;
  moves: GameMove[];
}

/** Splits pasted PGN into its games: a game starts at a header line
 * ("[Tag ...]") that follows move text, or at move text that follows a
 * game's result (1-0, 0-1, 1/2-1/2 or *) ending a line. */
export function splitPgnGames(text: string): string[] {
  const games: string[] = [];
  let current: string[] = [];
  let inMoves = false;
  let ended = false;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const isHeader = /^\s*\[\w+\s+".*"\]\s*$/.test(line);
    if ((isHeader && inMoves) || (!isHeader && line.trim() && ended)) {
      games.push(current.join("\n"));
      current = [];
      inMoves = false;
      ended = false;
    }
    if (!isHeader && line.trim()) {
      inMoves = true;
      ended = /(^|\s)(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(line);
    }
    current.push(line);
  }
  if (current.some((line) => line.trim())) games.push(current.join("\n"));
  return games.map((game) => game.trim()).filter(Boolean);
}

/** Reads one game; throws an Error saying what is wrong. */
export function parseGame(pgn: string): ParsedGame {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "Unreadable PGN.");
  }
  const comments = new Map(chess.getComments().map((c) => [c.fen, c.comment]));
  const history = chess.history({ verbose: true });
  const startFen = history.length ? history[0].before : chess.fen();
  return {
    headers: chess.getHeaders(),
    startFen,
    startComment: comments.get(startFen),
    moves: history.map((m) => ({ san: m.san, fen: m.after, from: m.from, to: m.to, comment: comments.get(m.after) })),
  };
}

const known = (value: string | undefined): string | null => (value && value !== "?" && !/^\?+$/.test(value) ? value : null);

/** "Carlsen, M. – Anand, V." */
export function gameTitle(headers: Record<string, string>): string {
  return `${known(headers.White) ?? "?"} – ${known(headers.Black) ?? "?"}`;
}

/** "1-0 · Candidates · 2014" */
export function gameDetails(headers: Record<string, string>): string {
  const year = known(headers.Date)?.slice(0, 4).replace(/\?/g, "");
  return [known(headers.Result) === "*" ? null : known(headers.Result), known(headers.Event), year || null]
    .filter(Boolean)
    .join(" · ");
}
