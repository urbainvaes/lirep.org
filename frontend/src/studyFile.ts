import { Chess } from "chess.js";

import type { ExplorerSettings } from "./explorer";
import { parseGame } from "./pgnGames";
import { createEmptyTree, sanPathTo, type StudyTree, type TreeNode } from "./tree";

// Lirep's study file (".lirep.json"): what Export downloads and Import
// reads, one study per file, documented in doc/studies.html#study-files.
// The tree is written as lines, like PGN: a line is a list of moves, and a
// move's "variations" are the alternative lines played instead of it. The
// study's games (its Games page) are listed in page order, each with its
// section.

export const STUDY_FILE_FORMAT = "lirep-study";
export const STUDY_FILE_VERSION = 1;

export interface FileGame {
  section: string;
  pgn: string;
  comment?: string;
}

interface FileMove {
  san: string;
  comment?: string;
  variations?: FileMove[][];
}

export interface StudyFile {
  format: typeof STUDY_FILE_FORMAT;
  version: number;
  name: string;
  side: "white" | "black";
  start?: string[];
  explorerSettings?: Partial<ExplorerSettings>;
  moves: FileMove[];
  games?: FileGame[];
}

/** What a study needs to be created from a file (POST /api/studies). */
export interface ImportedStudy {
  name: string;
  side: "white" | "black";
  tree: StudyTree;
  startNodeId: number | null;
  explorerSettings?: Partial<ExplorerSettings>;
  games: FileGame[];
}

export interface ExportableStudy {
  name: string;
  side: "white" | "black";
  tree: StudyTree;
  startNodeId: number | null;
  explorerSettings: ExplorerSettings;
  games?: FileGame[];
}

export function studyToFile(study: ExportableStudy): StudyFile {
  const { nodes } = study.tree;

  // The line starting at `nodeId`: it, then each first child; a node's other
  // siblings become the variations of the line's move at that point.
  function line(nodeId: number): FileMove[] {
    const moves: FileMove[] = [];
    for (let id: number | undefined = nodeId; id !== undefined; id = nodes[id].children[0]) {
      const node: TreeNode = nodes[id];
      const move: FileMove = { san: node.san as string };
      if (node.comment) move.comment = node.comment;
      const siblings: number[] = nodes[node.parentId as number].children;
      if (siblings[0] === id && siblings.length > 1) move.variations = siblings.slice(1).map(line);
      moves.push(move);
    }
    return moves;
  }

  const first = nodes[study.tree.rootId].children[0];
  const start = study.startNodeId !== null && study.startNodeId in nodes ? sanPathTo(study.tree, study.startNodeId) : [];
  const { enabled: _enabled, ...explorerSettings } = study.explorerSettings;
  return {
    format: STUDY_FILE_FORMAT,
    version: STUDY_FILE_VERSION,
    name: study.name,
    side: study.side,
    ...(start.length ? { start } : {}),
    explorerSettings,
    moves: first === undefined ? [] : line(first),
    ...(study.games?.length
      ? { games: study.games.map((g) => ({ section: g.section, pgn: g.pgn, ...(g.comment ? { comment: g.comment } : {}) })) }
      : {}),
  };
}

export function downloadStudyFile(study: ExportableStudy): void {
  const json = JSON.stringify(studyToFile(study), null, 2) + "\n";
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${study.name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "study"}.lirep.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Reads a study file; throws an Error whose message says what is wrong. */
export function studyFromFile(text: string): ImportedStudy {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON.");
  }
  const file = data as Partial<StudyFile>;
  if (typeof file !== "object" || file === null || file.format !== STUDY_FILE_FORMAT) {
    throw new Error("This isn't a Lirep study file.");
  }
  if (file.version !== STUDY_FILE_VERSION) {
    throw new Error(`This study file has version ${String(file.version)}; this site reads version ${STUDY_FILE_VERSION}.`);
  }
  if (typeof file.name !== "string" || !file.name.trim()) throw new Error("The study has no name.");
  if (file.side !== "white" && file.side !== "black") throw new Error('"side" must be "white" or "black".');
  if (!Array.isArray(file.moves)) throw new Error('"moves" must be a list of moves.');
  const side = file.side;

  const tree = createEmptyTree();

  // Adds `moves` as a line from `parentId` (whose position is `chess`);
  // each move's variations branch from the same parent.
  function addLine(moves: unknown, parentId: number, chess: Chess, where: string): void {
    if (!Array.isArray(moves)) throw new Error(`${where}: a line must be a list of moves.`);
    let parent = parentId;
    for (const raw of moves) {
      const move = raw as Partial<FileMove>;
      if (typeof move !== "object" || move === null || typeof move.san !== "string") {
        throw new Error(`${where}: every move needs a "san".`);
      }
      if (move.comment !== undefined && typeof move.comment !== "string") {
        throw new Error(`${where}: a comment must be text.`);
      }
      if (move.variations !== undefined && !Array.isArray(move.variations)) {
        throw new Error(`${where}: "variations" must be a list of lines.`);
      }
      const before = chess.fen();
      const ownMove = (chess.turn() === "w") === (side === "white");
      let played;
      try {
        played = chess.move(move.san);
      } catch {
        throw new Error(`${where}: ${move.san} is not a legal move here.`);
      }
      const siblings = tree.nodes[parent].children;
      if (siblings.some((id) => tree.nodes[id].san === played.san)) {
        throw new Error(`${where}: ${played.san} appears twice in the same position.`);
      }
      if (ownMove && siblings.length) {
        throw new Error(
          `${where}: two moves for ${side === "white" ? "White" : "Black"} in the same position ` +
            `(${tree.nodes[siblings[0]].san} and ${played.san}); a study has one prepared move per position.`,
        );
      }
      const id = tree.nextId++;
      tree.nodes[id] = { id, san: played.san, parentId: parent, children: [], ...(move.comment ? { comment: move.comment } : {}) };
      siblings.push(id);
      // The alternatives to this move, after it among the children, in order.
      for (const variation of move.variations ?? []) {
        addLine(variation, parent, new Chess(before), `${where}, variation of ${played.san}`);
      }
      parent = id;
    }
  }
  addLine(file.moves, tree.rootId, new Chess(), "Main line");

  let startNodeId: number | null = null;
  if (file.start !== undefined) {
    if (!Array.isArray(file.start)) throw new Error('"start" must be a list of moves.');
    let id = tree.rootId;
    const chess = new Chess();
    for (const san of file.start) {
      let played;
      try {
        played = chess.move(String(san));
      } catch {
        throw new Error(`"start": ${String(san)} is not a legal move here.`);
      }
      const child = tree.nodes[id].children.find((c) => tree.nodes[c].san === played.san);
      if (child === undefined) throw new Error(`"start": ${played.san} is not in the study's moves.`);
      id = child;
    }
    startNodeId = id === tree.rootId ? null : id;
  }

  const games: FileGame[] = [];
  if (file.games !== undefined) {
    if (!Array.isArray(file.games)) throw new Error('"games" must be a list of games.');
    file.games.forEach((raw, i) => {
      const game = raw as Partial<FileGame>;
      const where = `Game ${i + 1}`;
      if (typeof game !== "object" || game === null || typeof game.pgn !== "string") throw new Error(`${where}: it needs a "pgn".`);
      if (typeof game.section !== "string" || !game.section.trim() || game.section.trim().length > 60) {
        throw new Error(`${where}: "section" must be a name of 1 to 60 characters.`);
      }
      if (game.comment !== undefined && typeof game.comment !== "string") throw new Error(`${where}: a comment must be text.`);
      try {
        parseGame(game.pgn);
      } catch (err) {
        throw new Error(`${where}: ${err instanceof Error ? err.message : "unreadable PGN"}`);
      }
      games.push({ section: game.section.trim(), pgn: game.pgn, ...(game.comment ? { comment: game.comment } : {}) });
    });
  }

  return {
    name: file.name.trim(),
    side,
    tree,
    startNodeId,
    games,
    ...(file.explorerSettings && typeof file.explorerSettings === "object" ? { explorerSettings: file.explorerSettings } : {}),
  };
}
