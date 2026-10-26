#!/usr/bin/env python3
"""Builds the Browse page's openings (frontend/public/openings/) from the
PGN files in openings/.

Each openings/<slug>.pgn is one opening: its standard moves, the main line
with the usual variations in parentheses, and these tags:

  Opening      its name ("Caro-Kann Defence"; "Sicilian Defence: Najdorf
               Variation" for a variation, as Lirep splits names at ":")
  Side         the side the repertoire is for, "white" or "black"
  ECO          its ECO codes ("B10-B19")
  Start        the moves that define it, from the initial position: the
               study's starting point
  Description  a sentence or two for its card

The moves are checked: legal, starting with Start, and one move for the
repertoire's side in each position (as a Lirep study requires). Each
becomes a Lirep study file, frontend/public/openings/<slug>.lirep.json
(what Import reads), and frontend/public/openings/index.json lists them, in
the order of OPENINGS_ORDER, for the page.

  tools/build_browse_openings.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import chess
import chess.pgn

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "openings"
OUT = ROOT / "frontend" / "public" / "openings"

# The cards' order within a side: by White's first move, then as listed.
OPENINGS_ORDER = [
    "italian", "ruy-lopez", "scotch", "queens-gambit", "london", "english",
    "najdorf", "french", "caro-kann", "petroff", "scandinavian",
    "qgd", "kings-indian", "nimzo-indian",
]

# The Explorer settings an imported study gets (Lirep's defaults).
EXPLORER_SETTINGS = {"source": "lichess", "database": "lichess", "minRating": None, "speeds": ["blitz", "rapid", "classical"]}


class Invalid(Exception):
    pass


def line(node: chess.pgn.GameNode, side: chess.Color, where: str) -> list[dict]:
    """The moves from `node` on, as a study file's line: each position's
    first move, with the others as its variations."""
    moves: list[dict] = []
    while node.variations:
        board = node.board()
        if board.turn == side and len(node.variations) > 1:
            names = ", ".join(board.san(v.move) for v in node.variations)
            raise Invalid(f"{where}: two moves for the repertoire's side after {board.fen()} ({names})")
        main, *others = node.variations
        move: dict = {"san": board.san(main.move)}
        if others:
            move["variations"] = [[{"san": board.san(v.move)}, *line(v, side, where)] for v in others]
        if main.comment.strip():
            move["comment"] = main.comment.strip()
        moves.append(move)
        node = main
    return moves


def count(node: chess.pgn.GameNode, side: chess.Color) -> tuple[int, int]:
    """The repertoire side's moves, and the lines (the tree's ends)."""
    if not node.variations:
        return 0, 1
    own = int(node.board().turn == side) * len(node.variations)
    lines = 0
    for v in node.variations:
        o, l = count(v, side)
        own += o
        lines += l
    return own, lines


def build(path: Path) -> tuple[dict, dict]:
    with path.open() as f:
        game = chess.pgn.read_game(f)
    if game is None or game.errors:
        raise Invalid(f"{path.name}: unreadable PGN ({game.errors if game else 'empty'})")
    tags = game.headers
    for tag in ("Opening", "Side", "ECO", "Start", "Description"):
        if not tags.get(tag):
            raise Invalid(f"{path.name}: no {tag} tag")
    if tags["Side"] not in ("white", "black"):
        raise Invalid(f'{path.name}: Side must be "white" or "black"')
    side = chess.WHITE if tags["Side"] == "white" else chess.BLACK

    # The start: a prefix of the main line.
    start = tags["Start"].split()
    node = game
    for san in start:
        if not node.variations or node.board().san(node.variations[0].move) != san:
            raise Invalid(f"{path.name}: the main line doesn't begin with Start ({tags['Start']})")
        node = node.variations[0]
    if node.board().turn == side and not node.variations:
        raise Invalid(f"{path.name}: no move for the repertoire's side after Start")
    main_line = []
    rest = node
    while rest.variations:
        main_line.append(rest.board().san(rest.variations[0].move))
        rest = rest.variations[0]
    moves, lines = count(node, side)

    slug = path.stem
    study = {
        "format": "lirep-study",
        "version": 1,
        "name": tags["Opening"],
        "side": tags["Side"],
        "start": start,
        "explorerSettings": EXPLORER_SETTINGS,
        "moves": line(game, side, path.name),
    }
    entry = {
        "slug": slug,
        "file": f"{slug}.lirep.json",
        "name": tags["Opening"],
        "side": tags["Side"],
        "eco": tags["ECO"],
        "group": f"1.{start[0]}",
        "start": start,
        "mainLine": main_line,
        "moves": moves,
        "lines": lines,
        "description": tags["Description"],
    }
    return study, entry


def main() -> None:
    sources = {p.stem: p for p in sorted(SOURCE.glob("*.pgn"))}
    unknown = set(sources) - set(OPENINGS_ORDER)
    missing = set(OPENINGS_ORDER) - set(sources)
    if unknown or missing:
        sys.exit(f"OPENINGS_ORDER and openings/*.pgn differ: not listed {sorted(unknown)}, no file {sorted(missing)}")
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.lirep.json"):
        old.unlink()
    entries = []
    try:
        for slug in OPENINGS_ORDER:
            study, entry = build(sources[slug])
            (OUT / entry["file"]).write_text(json.dumps(study, indent=2, ensure_ascii=False) + "\n")
            entries.append(entry)
    except Invalid as err:
        sys.exit(str(err))
    (OUT / "index.json").write_text(json.dumps({"version": 1, "openings": entries}, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(entries)} openings to {OUT.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
