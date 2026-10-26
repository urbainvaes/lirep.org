#!/usr/bin/env python3
"""Builds optimal-repertoires/: a repertoire per opening, by
optimal_repertoire.py, and optimal-repertoires/index.json, which lists them
with their numbers (the best expected score each opening reaches).

Each opening in OPENINGS is run with the same settings (SETTINGS: a budget
of 50 memorized moves, by the explorer's score, blitz and rapid games
averaging 2000+), its study file written to
optimal-repertoires/<side>/<slug>.lirep.json, the tool's output beside it
(<slug>.log: the moves in the order they were added), and its numbers to
the index. An opening whose file is already there is
skipped, so an interrupted build goes on where it stopped; delete a file to
rebuild it. The explorer's answers are cached (see optimal_repertoire.py),
so a build that was stopped asks Lichess again only for what it hadn't
seen.

Needs what optimal_repertoire.py needs (python-chess, a Lichess token).

  tools/build_optimal_repertoires.py              # build what's missing, then the index
  tools/build_optimal_repertoires.py --index-only # only rewrite the index
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "optimal-repertoires"
TOOL = ROOT / "tools" / "optimal_repertoire.py"

BUDGET = 50
SPEEDS = "blitz,rapid"
MIN_RATING = 2000
SETTINGS = ["--moves-budget", str(BUDGET), "--speeds", SPEEDS, "--min-rating", str(MIN_RATING)]

# (side, opening moves, slug, name)
OPENINGS = [
    ("black", "e4 e5", "open-games", "Open Games (1...e5)"),
    ("black", "e4 c5", "sicilian", "Sicilian Defence"),
    ("black", "e4 e6", "french", "French Defence"),
    ("black", "e4 c6", "caro-kann", "Caro-Kann Defence"),
    ("black", "e4 d5", "scandinavian", "Scandinavian Defence"),
    ("black", "e4 d6", "pirc", "Pirc Defence (1...d6)"),
    ("black", "e4 g6", "modern", "Modern Defence"),
    ("black", "e4 Nf6", "alekhine", "Alekhine's Defence"),
    ("black", "e4 Nc6", "nimzowitsch", "Nimzowitsch Defence"),
    ("black", "e4 b6", "owen", "Owen's Defence"),
    ("black", "d4 d5", "queens-pawn-d5", "Queen's Pawn, 1...d5"),
    ("black", "d4 Nf6", "indian-nf6", "Indian Defences (1...Nf6)"),
    ("black", "d4 e6", "d4-e6", "Horwitz Defence (1.d4 e6)"),
    ("black", "d4 f5", "dutch", "Dutch Defence"),
    ("black", "d4 d6", "d4-d6", "1.d4 d6"),
    ("black", "d4 g6", "d4-g6", "Modern Defence (1.d4 g6)"),
    ("black", "d4 c5", "d4-c5", "Old Benoni (1.d4 c5)"),
    ("black", "d4 e5", "englund", "Englund Gambit"),
    ("black", "c4 e5", "english-e5", "English, Reversed Sicilian (1...e5)"),
    ("black", "c4 c5", "english-symmetrical", "Symmetrical English (1...c5)"),
    ("black", "c4 Nf6", "english-nf6", "Anglo-Indian (1.c4 Nf6)"),
    ("black", "c4 e6", "english-e6", "English, 1...e6"),
    ("black", "Nf3 d5", "reti-d5", "Réti, 1...d5"),
    ("black", "Nf3 Nf6", "reti-nf6", "Réti, 1...Nf6"),
    ("black", "Nf3 c5", "reti-c5", "Réti, 1...c5"),
]


def numbers(output: str) -> dict:
    """The games at the start, the score before and after, from the tool's output."""
    games = re.search(r"games averaging \d+\+: ([\d,]+) games at the start", output)
    start = re.search(r"start: expected score ([\d.]+)%", output)
    scores = re.findall(r"->\s+expected score ([\d.]+)%", output)
    if not (games and start and scores):
        raise ValueError("unexpected output: no scores found")
    added = len(re.findall(r"^\[[ \d.]+s\] move \d+:", output, re.M))
    return {
        "games": int(games.group(1).replace(",", "")),
        "startScore": round(float(start.group(1)) / 100, 4),
        "expectedScore": round(float(scores[-1]) / 100, 4),
        "movesAdded": added,
    }


def main_line(moves: list[dict], plies: int = 10) -> list[str]:
    """The study's first line: each position's first move."""
    line: list[str] = []
    for move in moves[:plies]:
        line.append(move["san"])
    return line


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--index-only", action="store_true", help="Only rewrite the index, from the numbers kept.")
    a = parser.parse_args()

    index_path = OUT / "index.json"
    old = {e["slug"]: e for e in json.loads(index_path.read_text())["openings"]} if index_path.exists() else {}
    entries = []
    for side, opening, slug, name in OPENINGS:
        path = OUT / side / f"{slug}.lirep.json"
        log = path.with_suffix("").with_suffix(".log")
        found = None
        if not path.exists() and not a.index_only:
            path.parent.mkdir(parents=True, exist_ok=True)
            print(f"{opening} ({slug})", flush=True)
            run = subprocess.run([sys.executable, str(TOOL), "--moves", opening, "--side", side, *SETTINGS,
                                  "--out", str(path)], capture_output=True, text=True)
            if run.returncode:
                sys.exit(f"{slug}: optimal_repertoire.py failed:\n{run.stderr or run.stdout}")
            log.write_text(run.stdout)
            found = numbers(run.stdout)
        if not path.exists():
            continue
        study = json.loads(path.read_text())
        if study["name"] != name:
            study["name"] = name
            path.write_text(json.dumps(study, indent=2) + "\n")
        entry = old.get(slug, {})
        if "expectedScore" not in entry and log.exists():
            found = numbers(log.read_text())
        if found:
            entry = {**entry, **found, "builtAt": datetime.date.today().isoformat()}
        if "expectedScore" not in entry:
            print(f"{slug}: no numbers kept; rebuild it (delete {path.relative_to(ROOT)})", file=sys.stderr)
            continue
        entries.append({
            "slug": slug,
            "file": str(path.relative_to(OUT)),
            "name": name,
            "side": side,
            "opening": opening.split(),
            "group": f"1.{opening.split()[0]}",
            "mainLine": main_line(study["moves"]),
            "expectedScore": entry["expectedScore"],
            "startScore": entry["startScore"],
            "movesAdded": entry["movesAdded"],
            "games": entry["games"],
            "data": {"source": "lichess", "speeds": SPEEDS.split(","), "minRating": MIN_RATING},
            "builtAt": entry["builtAt"],
        })
    index_path.write_text(json.dumps({"version": 1, "openings": entries}, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {index_path.relative_to(ROOT)}: {len(entries)} openings.")


if __name__ == "__main__":
    main()
