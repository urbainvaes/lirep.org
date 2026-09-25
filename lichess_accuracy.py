#!/usr/bin/env python3
"""Compute Lichess accuracy scores from PGN files or database dumps.

Reads PGN games containing [%eval ...] annotations (as found in
database.lichess.org dumps for server-analysed games, or in API exports
made with evals=1) and reproduces the accuracy numbers shown on
lichess.org analysis pages.

The algorithm is a faithful port of lichess-org/lila's
modules/analyse/src/main/AccuracyPercent.scala and scalachess'
WinPercent / Maths helpers:

  win%      = 50 + 50 * (2/(1+exp(-0.00368208*cp)) - 1),  cp clamped to [-1000,1000]
              (mate annotations become +/-1000)
  move acc. = 100 if win% did not drop for the mover, else
              clamp(103.1668100711649*exp(-0.04354415386753951*drop) - 2.166924740191411, 0, 100)
  game acc. = average of a volatility-weighted mean and the harmonic mean of
              the mover's move accuracies (weights = stddev of win% over a
              sliding window of size clamp(#moves/10, 2, 8), squeezed to [0.5,12])

Usage:
  ./lichess_accuracy.py games.pgn
  zstdcat lichess_db_standard_rated_2024-01.pgn.zst | ./lichess_accuracy.py -
  ./lichess_accuracy.py games.pgn --csv

Games without any [%eval ...] annotation are skipped.
"""

from __future__ import annotations

import argparse
import bz2
import csv
import gzip
import io
import lzma
import math
import re
import sys

try:
    from compression.zstd import ZstdFile
except ImportError:
    ZstdFile = None

CP_CEILING = 1000
INITIAL_CP = 15
WIN_CHANCES_MULT = -0.00368208
ACC_A = 103.1668100711649
ACC_B = 0.04354415386753951
ACC_C = -3.166924740191411

HEADER_RE = re.compile(r'^\[(\w+)\s+"(.*)"\]$')
EVAL_RE = re.compile(r"\[%eval\s+(\S+?)\]")
TOKEN_RE = re.compile(r"\{[^}]*\}|\$\d+|1-0|0-1|1/2-1/2|\*|\d+\.{1,3}|[()]|[^\s{}]+")
LEADING_NUM_RE = re.compile(r"^\d+\.{1,3}")
RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def win_percent(cp: int) -> float:
    chances = clamp(2.0 / (1.0 + math.exp(WIN_CHANCES_MULT * cp)) - 1.0, -1.0, 1.0)
    return 50.0 + 50.0 * chances


def move_accuracy(before: float, after: float) -> float:
    if after >= before:
        return 100.0
    drop = before - after
    return clamp(ACC_A * math.exp(-ACC_B * drop) + ACC_C + 1.0, 0.0, 100.0)


def pop_std(values):
    m = sum(values) / len(values)
    return math.sqrt(sum((v - m) ** 2 for v in values) / len(values))


def game_accuracy(cps, start_white=True):
    """Port of lila AccuracyPercent.gameAccuracy.

    cps: centipawn evaluations (white POV, mate -> +/-1000) after each ply;
         entries may be None when a ply has no [%eval] annotation.
    Returns {'white': float, 'black': float} or None.
    """
    if not cps:
        return None
    wps = [
        win_percent(clamp(c, -CP_CEILING, CP_CEILING)) if c is not None else None
        for c in [INITIAL_CP] + list(cps)
    ]
    n = len(wps)
    window = clamp(len(cps) // 10, 2, 8)
    pad = max(min(window, n) - 2, 0)
    windows = [wps[:window]] * pad
    if window >= n:
        windows.append(wps)
    else:
        windows.extend(wps[j : j + window] for j in range(n - window + 1))
    weights = [
        None if any(v is None for v in w) else clamp(pop_std(w), 0.5, 12.0)
        for w in windows
    ]
    entries = ([], [])
    for i in range(n - 1):
        prev, nxt, wt = wps[i], wps[i + 1], weights[i]
        if prev is None or nxt is None or wt is None:
            continue
        white_move = (i % 2 == 0) == start_white
        before, after = (prev, nxt) if white_move else (nxt, prev)
        entries[0 if white_move else 1].append((move_accuracy(before, after), wt))
    out = {}
    for color, es in enumerate(entries):
        if not es:
            return None
        total_w = sum(w for _, w in es)
        if total_w == 0:
            return None
        weighted = sum(a * w for a, w in es) / total_w
        harmonic = len(es) / sum(1.0 / max(1.0, a) for a, _ in es)
        out["white" if color == 0 else "black"] = (weighted + harmonic) / 2
    return out


def parse_eval(token: str):
    if token.startswith("#"):
        try:
            return CP_CEILING if int(token[1:]) >= 0 else -CP_CEILING
        except ValueError:
            return None
    try:
        return int(round(float(token) * 100))
    except ValueError:
        return None


def extract_evals(movetext: str):
    evals = {}
    ply = 0
    depth = 0
    for m in TOKEN_RE.finditer(movetext):
        tok = m.group(0)
        c = tok[0]
        if c == "{":
            if depth == 0 and ply:
                em = EVAL_RE.search(tok)
                if em:
                    cp = parse_eval(em.group(1))
                    if cp is not None:
                        evals[ply] = cp
        elif c == "(":
            depth += 1
        elif c == ")":
            depth = max(depth - 1, 0)
        elif c == "$":
            pass
        elif tok in RESULTS:
            break
        elif depth:
            continue
        elif LEADING_NUM_RE.sub("", tok):
            ply += 1
    if not evals:
        return None
    return [evals.get(p) for p in range(1, max(evals) + 1)]


def iter_games(stream):
    headers = {}
    moves = []
    for raw in stream:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        line = raw.strip()
        if not line or line.startswith("%"):
            continue
        hm = HEADER_RE.match(line) if line.startswith("[") else None
        if hm:
            if moves:
                yield headers, "\n".join(moves)
                headers, moves = {}, []
            headers[hm.group(1)] = hm.group(2)
        else:
            moves.append(line)
    if headers and moves:
        yield headers, "\n".join(moves)


def open_input(path: str):
    if path == "-":
        return sys.stdin
    if path.endswith(".zst"):
        if ZstdFile is None:
            sys.exit("error: .zst needs Python 3.14+, or pipe through zstdcat")
        return io.TextIOWrapper(ZstdFile(path, "rb"), encoding="utf-8", errors="replace")
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    if path.endswith(".bz2"):
        return bz2.open(path, "rt", encoding="utf-8", errors="replace")
    if path.endswith((".xz", ".lzma")):
        return lzma.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, encoding="utf-8", errors="replace")


SELFTEST_CASES = [
    ("empty game", [], None, None),
    ("single move", [15], None, None),
    ("two good moves", [15, 15], (100, 1), (100, 1)),
    ("white blunders on first move", [-900, -900], (10, 5), (100, 1)),
    ("black blunders on first move", [15, 900], (100, 1), (10, 5)),
    ("both blunder on first move", [-900, 0], (10, 5), (10, 5)),
    ("20 perfect moves", [15] * 20, (100, 1), (100, 1)),
    ("20 perfect moves + white blunder", [15] * 20 + [-900], (50, 5), (100, 1)),
    ("21 perfect moves + black blunder", [15] * 21 + [900], (100, 1), (50, 5)),
    ("5 avg moves (65cpl)", [x for _ in range(5) for x in (-50, 15)], (76, 8), (76, 8)),
    ("50 avg moves (65cpl)", [x for _ in range(50) for x in (-50, 15)], (76, 8), (76, 8)),
    ("50 mediocre moves (150cpl)", [x for _ in range(50) for x in (-135, 15)], (54, 8), (54, 8)),
    ("50 terrible moves (500cpl)", [x for _ in range(50) for x in (-435, 15)], (20, 8), (20, 8)),
]

BLACK_FIRST_CASES = [
    ("bf empty game", [], None, None),
    ("bf single move", [15], None, None),
    ("bf two good moves", [15, 15], (100, 1), (100, 1)),
    ("bf black blunders first", [900, 900], (100, 1), (10, 5)),
    ("bf white blunders first", [15, -900], (10, 5), (100, 1)),
    ("bf both blunder first", [900, 0], (10, 5), (10, 5)),
]


def selftest():
    failures = 0
    cases = [(name, cps, w, b, True) for name, cps, w, b in SELFTEST_CASES] + [
        (name, cps, w, b, False) for name, cps, w, b in BLACK_FIRST_CASES
    ]
    for name, cps, wt, bt, start_white in cases:
        got = game_accuracy(cps, start_white=start_white)
        if wt is None:
            ok = got is None
            detail = f"got {got}"
        elif got is None:
            ok, detail = False, "got None"
        else:
            ok = (
                abs(got["white"] - wt[0]) <= wt[1]
                and abs(got["black"] - bt[0]) <= bt[1]
            )
            detail = (
                f"got W={got['white']:.2f} B={got['black']:.2f}, "
                f"want W={wt[0]}+/-{wt[1]} B={bt[0]}+/-{bt[1]}"
            )
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
        failures += 0 if ok else 1
    print(f"\n{len(cases) - failures}/{len(cases)} passed")
    sys.exit(1 if failures else 0)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Compute Lichess accuracy scores from PGN dumps.",
        epilog="Only games containing [%eval ...] annotations can be scored.",
    )
    ap.add_argument(
        "input",
        nargs="?",
        help="PGN file (.pgn/.zst/.gz/.bz2/.xz) or '-' for stdin",
    )
    ap.add_argument("--csv", action="store_true", help="CSV output instead of a table")
    ap.add_argument(
        "--selftest",
        action="store_true",
        help="run against official AccuracyPercentTest vectors and exit",
    )
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()

    if args.input is None:
        if sys.stdin.isatty():
            ap.error("the following arguments are required: input")
        args.input = "-"

    rows = []
    total = scored = 0
    acc_sum = {"white": 0.0, "black": 0.0}
    for headers, movetext in iter_games(open_input(args.input)):
        total += 1
        acc = game_accuracy(extract_evals(movetext)) if "[%eval" in movetext else None
        if acc is None:
            continue
        scored += 1
        acc_sum["white"] += acc["white"]
        acc_sum["black"] += acc["black"]
        rows.append(
            (
                headers.get("White", "?"),
                headers.get("Black", "?"),
                headers.get("Result", "*"),
                headers.get("UTCDate", headers.get("Date", "")),
                round(acc["white"], 2),
                round(acc["black"], 2),
            )
        )

    if args.csv:
        w = csv.writer(sys.stdout)
        w.writerow(["white", "black", "result", "date", "white_accuracy", "black_accuracy"])
        w.writerows(rows)
    else:
        hdr = f"{'White':<24} {'Black':<24} {'Result':<8} {'Date':<12} {'AccW':>6} {'AccB':>6}"
        print(hdr)
        print("-" * len(hdr))
        for r in rows:
            print(f"{r[0][:23]:<24} {r[1][:23]:<24} {r[2]:<8} {r[3]:<12} {r[4]:>6.2f} {r[5]:>6.2f}")

    print(
        f"\n{scored}/{total} games scored",
        file=sys.stderr,
    )
    if scored:
        print(
            f"mean accuracy: white {acc_sum['white'] / scored:.2f}  "
            f"black {acc_sum['black'] / scored:.2f}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
