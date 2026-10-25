#!/usr/bin/env python3
"""The best repertoire for a number of memorized moves, one move at a time.

Given an opening (moves from the initial position), the side it is for and
an opening explorer, builds a repertoire by adding your moves one at a time,
each time the one raising the value most, printing the value after each,
until it has added a given number of moves (--moves-budget) or reaches a
target value (--target). A memorized move is one of your moves in the tree.

Three objectives (--objective), as on Lirep's Stats page. Walking the
tree, the opponent's replies are weighted by how often they are played in the
explorer, and the value where preparation ends is:
  score       the explorer's score (the default): where preparation stops on
              your move, that position's score; after an opponent reply you
              haven't prepared, that reply's own score. As a percentage.
  evaluation  Stockfish's evaluation of those same positions, in pawns from
              your side's point of view. Stockfish's own best moves are then
              candidates at your turn too, played or not, and evaluations are
              cached in a file, so a second run on the same opening is fast.
  hybrid      the explorer's score where the move has at least 100 games
              (MIN_LEAF_GAMES), Stockfish's evaluation as an expected score
              where it has fewer (Lirep's "Hybrid" end-of-prep value). As a
              percentage. Stockfish's best moves are candidates too, as
              with the evaluation.

Each added move answers an opponent reply the repertoire leaves unanswered:
after one of your moves inside a line, or after a line's last move
(extending it). Your candidates there are your most played moves (and
Stockfish's best, with the evaluation or the hybrid); replies reached by few
games are left out. --max-loss leaves out your moves that Stockfish finds
unsound: losing more than so many centipawns against its best. Only the
positions next to the repertoire are needed, so it is fast, but not always
optimal: a move worth little alone, but much with the next one, is missed.

--lookahead K looks further: each unanswered reply is answered in the best
way with up to K of your moves (in the reply's own subtree: moves in
different branches add up independently, so they are found one after the
other anyway), and the addition with the most gain per move is made, all
its moves at once. --lookahead 1 (the default) is the plain greedy; each
step up needs the explorer a little deeper under each reply looked at.

All the parameters, with their defaults and what they mean, are in the
PARAMETERS block below; each can be changed on the command line.

The data comes from Lichess's opening explorer (explorer.lichess.org), one
request at a time, at least --delay seconds apart; after a 429 (rate
limited) it waits a minute and tries again. Lichess's explorer needs a
token: create one (no scope needed) at https://lichess.org/account/oauth/token
and put it in the LICHESS_TOKEN environment variable, or in the file
~/.config/lirep/lichess-token. Answers are kept in a
cache file for 30 days (--explorer-cache), so a second run, or a run with a
bigger budget, asks only for the positions it hasn't seen. --explorer
http://127.0.0.1:9002 uses the local explorer instead (explorer/start-server.sh).

It prints the parameters, the value after each added move and the
repertoire; while it works, a line counts the explorer requests and
Stockfish evaluations so far. --verbose prints each explorer request and
Stockfish evaluation, and the next best moves after each added one.

Needs python-chess and, for the evaluation, Stockfish.

Examples, mostly for the Alapin (1.e4 c5 2.c3) as White (with
export LICHESS_TOKEN=lip_..., or the token in ~/.config/lirep/lichess-token):
  # A repertoire by expected score with 20 memorized moves:
  tools/optimal_repertoire.py --moves "e4 c5 c3" --side white --moves-budget 20
  # The same by expected Stockfish evaluation (Stockfish from Guix):
  guix shell stockfish -- tools/optimal_repertoire.py --moves "e4 c5 c3" \\
      --side white --moves-budget 20 --objective evaluation
  # Moves added one at a time to a study until it reaches 59%, with Lirep's
  # Hybrid values:
  guix shell stockfish -- tools/optimal_repertoire.py --moves "e4 e5 Nc3" \\
      --side white --base vienna.lirep.json --objective hybrid \\
      --target 0.59 --out vienna-59.lirep.json
  # 20 moves, each good or better for Stockfish (losing at most 50 cp):
  guix shell stockfish -- tools/optimal_repertoire.py --moves "e4 c5 c3" \\
      --side white --moves-budget 20 --max-loss good
  # Moves added until the repertoire reaches 56%, written as a Lirep study file:
  tools/optimal_repertoire.py --moves "e4 c5 c3" --side white --target 0.56 \\
      --out alapin.lirep.json
  # 20 moves, each addition looking two moves ahead:
  tools/optimal_repertoire.py --moves "e4 c5 c3" --side white --moves-budget 20 \\
      --lookahead 2
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import chess
import chess.engine

# =============================================================================
# PARAMETERS: the defaults; each can be changed on the command line (--help).
# =============================================================================

OBJECTIVE = "score"   # --objective: "score" (the explorer's), "evaluation"
                      # (Stockfish's) or "hybrid"; see the top of this file
MIN_LEAF_GAMES = 100  # hybrid: fewer games than this, and Stockfish values a
                      # line's end (also the candidates' minimum, by default)

# ---- The data ---------------------------------------------------------------
EXPLORER = "https://explorer.lichess.org"  # --explorer: Lichess's explorer, or
                                    # the local one (http://127.0.0.1:9002)
DELAY = 1.0                         # --delay: seconds between two requests to
                                    # Lichess (Lirep's browser client waits 0.5)
RATE_LIMIT_PAUSE = 60               # after a 429, seconds before trying again
RETRIES = 5                         # other failures (timeouts, 5xx): tries, with
                                    # waits doubling from 5 s
EXPLORER_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "lirep" / "explorer.json"
                                    # --explorer-cache: answers kept between runs
TOKEN_FILE = Path.home() / ".config" / "lirep" / "lichess-token"  # the token, if
                                    # LICHESS_TOKEN isn't set
CACHE_DAYS = 30                     # --cache-days: how long an answer is kept
SPEEDS = "blitz,rapid,classical"    # --speeds: time controls counted
MIN_RATING = 1800                   # --min-rating: the player pool, by rating. A
                                    # game belongs to a rating group by the
                                    # average of both players' ratings; groups
                                    # start at RATING_GROUPS, and the pool is
                                    # every group starting at MIN_RATING or above
                                    # (as on Lirep: 2100 means 2200+, 1800 means
                                    # games averaging 1800 or more)
RATING_GROUPS = (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500)
# (--ratings "1800,2000" picks exact groups instead: here 1800-2199.)

# ---- The candidates ---------------------------------------------------------
CANDIDATES = 6      # --candidates: your most played moves considered in a position
MIN_REACH = 0.002   # --min-reach: a reply reached by fewer than this share of the
                    # games at the start isn't answered (0.002 = 0.2%)
MAX_MOVES = 150     # --max-moves: with --target, the most moves added
LOOKAHEAD = 1       # --lookahead: your moves an addition may have (1: the plain
                    # greedy, one move at a time)
MAX_LOSS = None     # --max-loss: leave out your moves losing more than this
                    # many centipawns against Stockfish's best (evaluations
                    # within +/- MATE_CAP); None: any move (Stockfish then
                    # runs whatever the objective)
LOSS_LEVELS = {"best": 10, "excellent": 25, "good": 50, "inaccuracy": 100}
                    # --max-loss by name, as in Lirep's suggested moves
                    # (Lichess once called a loss of 50 an inaccuracy, of
                    # 100 a mistake)

# ---- Safeguards against small samples ---------------------------------------
# An explorer score from N games is uncertain by roughly +/-(50 / sqrt N)
# points: about +/-5 at 100 games, +/-1.6 at 1,000. Without these, the search
# picks moves that scored well in a handful of games, by luck.
MIN_GAMES = 100     # --min-games: games a move needs to be one of your
                    # candidates (a hard minimum; your moves only)
PRIOR_GAMES = 20    # --prior-games: every score used (your moves, the
                    # opponent's replies, positions where preparation ends) is
                    # pulled toward 50% as if this many more games had been
                    # drawn: with 20 games a sample's own score counts half,
                    # with 2,000 almost fully (a soft minimum, everywhere)
# --no-safeguards sets both to off (1 game, no prior) unless they're given.
MIN_GAMES_EVALUATION = 30  # with --objective evaluation, MIN_GAMES's default:
                    # evaluations don't come from the games, but the opponent's
                    # replies after your move are weighted by them, which still
                    # needs a few games (PRIOR_GAMES isn't used)

# ---- Stockfish (--objective evaluation) --------------------------------------
STOCKFISH = "stockfish"   # --stockfish: the engine's command
DEPTH = 12                # --depth: search depth per position (12 is Lirep's
                          # "Balanced"; each step up costs more time)
ENGINE_CANDIDATES = 1     # --engine-candidates: Stockfish's best moves added to
                          # your candidates at each of your turns
MATE_CAP = 10.0           # --mate-cap: evaluations are capped at +/- this many
                          # pawns, forced mates included, so that one rare mating
                          # line can't dominate an average (Lirep counts a mate
                          # as +/-1000 pawns)
CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "lirep" / "stockfish-evals.json"
                          # --cache: where evaluations are kept between runs

NEG = float("-inf")


# ---- Explorer ---------------------------------------------------------------


START = time.monotonic()


VERBOSE = False  # --verbose: detail() prints too
_status = False  # a progress line is showing (to be cleared)


def log(message: str) -> None:
    """One line of output, after the time since the start."""
    global _status
    if _status and sys.stdout.isatty():
        print("\r\033[K", end="")
    _status = False
    print(f"[{time.monotonic() - START:7.1f}s] {message}", flush=True)


def detail(message: str) -> None:
    """A line printed only with --verbose."""
    if VERBOSE:
        log(message)


COUNTS = {"requests": 0, "evaluations": 0}
_doing = ""  # what it is doing, for the status line


def _show() -> None:
    global _status
    text = f"[{time.monotonic() - START:7.1f}s] {_doing}"
    if COUNTS["requests"] or COUNTS["evaluations"]:
        text += f"  ({COUNTS['requests']:,} explorer requests, {COUNTS['evaluations']:,} Stockfish evaluations)"
    width = shutil.get_terminal_size().columns
    print(f"\r\033[K{text[: width - 1]}", end="", flush=True)
    _status = True


def doing(message: str, milestone: bool = False) -> None:
    """What it is doing now: without --verbose, one status line that keeps
    being rewritten (in a terminal; elsewhere, only `milestone`s print)."""
    global _doing
    _doing = message
    if VERBOSE:
        return
    if sys.stdout.isatty():
        _show()
    elif milestone:
        print(f"[{time.monotonic() - START:7.1f}s] {message}", flush=True)


def progress(kind: str) -> None:
    """Counts a request or an evaluation, on the status line."""
    COUNTS[kind] += 1
    if not VERBOSE and sys.stdout.isatty() and _doing:
        _show()


def line_of(board: chess.Board) -> str:
    """The moves leading to `board`, numbered, e.g. '1. e4 c5 2. c3'."""
    return chess.Board().variation_san(board.move_stack) if board.move_stack else "(start)"


def games_of(row: dict) -> int:
    return row["white"] + row["draws"] + row["black"]


class Explorer:
    """Lichess's opening explorer (or another speaking its API), one request
    at a time, `delay` seconds apart, with its answers kept in a file."""

    def __init__(self, url: str, speeds: str, ratings: str, delay: float, token: str | None,
                 cache_path: Path | None, cache_days: float):
        self.url, self.speeds, self.ratings = url.rstrip("/"), speeds, ratings
        self.delay, self.token = delay, token
        self.cache_path, self.max_age = cache_path, cache_days * 86400
        self.disk: dict[str, dict] = {}
        if cache_path and cache_path.exists():
            self.disk = json.loads(cache_path.read_text())
        self.memo: dict[str, dict] = {}
        self.queries = self.from_cache = self.unsaved = 0
        self.last = 0.0  # time.monotonic() of the last request

    def get(self, board: chess.Board) -> dict:
        fen = board.fen()
        if fen in self.memo:  # already seen in this run: no request, nothing to say
            return self.memo[fen]
        key = f"{self.url}|{self.speeds}|{self.ratings}|{fen}"
        entry = self.disk.get(key)
        if entry and time.time() - entry["t"] < self.max_age:
            self.from_cache += 1
            data = entry["data"]
            detail(f"explorer: {line_of(board)}: {games_of(data):,} games, {len(data['moves'])} moves "
                f"(cache, {(time.time() - entry['t']) / 86400:.0f} days old)")
        else:
            data = self._fetch(board, fen)
            self.disk[key] = {"t": time.time(), "data": data}
            self.unsaved += 1
            if self.unsaved >= 20:
                self.save()
        self.memo[fen] = data
        return data

    def _fetch(self, board: chess.Board, fen: str) -> dict:
        params = {"fen": fen, "speeds": self.speeds, "ratings": self.ratings, "topGames": 0, "recentGames": 0}
        request = urllib.request.Request(f"{self.url}/lichess?{urllib.parse.urlencode(params)}",
                                         headers={"User-Agent": "lirep optimal_repertoire.py"})
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        failures = 0
        while True:
            wait = self.last + self.delay - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            try:
                with urllib.request.urlopen(request, timeout=60) as resp:
                    data = json.load(resp)
                break
            except urllib.error.HTTPError as err:
                if err.code == 429:
                    log(f"explorer: rate limited (429), waiting {RATE_LIMIT_PAUSE} s")
                    time.sleep(RATE_LIMIT_PAUSE)
                    continue
                if err.code == 401:
                    sys.exit(f"The explorer answered 401 (unauthorized): put a Lichess token in LICHESS_TOKEN or {TOKEN_FILE}, "
                             "created at https://lichess.org/account/oauth/token (no scope needed).")
                if err.code < 500:
                    raise
                problem = f"HTTP {err.code}"
            except (urllib.error.URLError, TimeoutError) as err:
                problem = str(getattr(err, "reason", err))
            failures += 1
            if failures >= RETRIES:
                sys.exit(f"The explorer failed {failures} times in a row ({problem}); giving up. "
                         "What was fetched is in the cache: run again to go on from there.")
            pause = 5 * 2 ** (failures - 1)
            log(f"explorer: {problem}, trying again in {pause} s")
            time.sleep(pause)
        self.queries += 1
        progress("requests")
        detail(f"explorer: {line_of(board)}: {games_of(data):,} games, {len(data['moves'])} moves "
            f"(request {self.queries}, {time.monotonic() - self.last:.1f} s)")
        return data

    def save(self) -> None:
        if not self.cache_path or not self.unsaved:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.disk))
        tmp.replace(self.cache_path)
        self.unsaved = 0


def score_from_cp(cp: float) -> float:
    """Centipawns (your side's point of view) as an expected score, on the
    curve Lichess uses for its winning chances (as Lirep does)."""
    return 1 / (1 + math.exp(-0.00368208 * cp))


def score(white: int, draws: int, black: int, side: chess.Color, prior: float) -> float:
    """Expected score for `side`, shrunk toward 0.5 by `prior` games."""
    n = white + draws + black
    points = (white if side == chess.WHITE else black) + draws / 2
    return (points + prior / 2) / (n + prior) if n + prior else 0.5


# ---- The objectives ---------------------------------------------------------


class Objective:
    """The expected explorer score, with Lirep's definition: a line ends with
    its last answered move and counts with that move's own results, as listed
    in the position before it; an opponent move without a prepared answer
    counts with its own results. A subclass can replace value() (what an
    unanswered reply, or a position without games, is worth), end_value()
    (what a line ending with one of your moves is worth) and
    extra_candidates()."""

    name = "expected score"

    def __init__(self, explorer: Explorer, side: chess.Color, args: argparse.Namespace,
                 evaluator: Evaluator | None = None):
        self.explorer, self.side, self.a, self.evaluator = explorer, side, args, evaluator

    def fmt(self, v: float) -> str:
        return f"{v:.2%}"

    def change(self, g: float) -> str:
        """A change of the value."""
        return f"{100 * g:+.2f} points"

    def value(self, board: chess.Board, white: int, draws: int, black: int) -> float:
        """An unanswered move's worth, from its white/draws/black results."""
        return score(white, draws, black, self.side, self.a.prior_games)

    def end_value(self, row: dict | None, after: chess.Board) -> float | None:
        """A line ending with your move: that move's own results (`row`, from
        the position before it). None: what the opponent's replies at `after`
        give (here, when the move is too rare to be listed)."""
        if row and games_of(row):
            return score(row["white"], row["draws"], row["black"], self.side, self.a.prior_games)
        return None

    def extra_candidates(self, board: chess.Board) -> list[str]:
        """Moves (UCI) to consider at your turn besides the most played."""
        return []

    def cp(self, board: chess.Board) -> float:
        """Stockfish's evaluation at `board`, in centipawns for your side,
        within +/- --mate-cap (a mate counts as that)."""
        cp = self.evaluator.get(board)["cp"]
        cap = 100 * self.a.mate_cap
        return max(-cap, min(cap, cp if self.side == chess.WHITE else -cp))


class Evaluator:
    """Stockfish evaluations (White's point of view, in centipawns, mates as
    +/-100000) and best moves, cached by position and depth."""

    def __init__(self, command: str, depth: int, lines: int, cache: Path):
        self.engine = chess.engine.SimpleEngine.popen_uci(command)
        self.depth, self.lines, self.cache_path = depth, max(1, lines), cache
        self.cache: dict[str, dict] = json.loads(cache.read_text()) if cache.exists() else {}
        self.computed = 0

    def get(self, board: chess.Board) -> dict:
        key = f"{board.fen()}|{self.depth}"
        entry = self.cache.get(key)
        if entry is None or len(entry["best"]) < min(self.lines, board.legal_moves.count()):
            if board.is_game_over():
                outcome = board.outcome()
                cp = 0 if outcome.winner is None else (100000 if outcome.winner == chess.WHITE else -100000)
                entry = {"cp": cp, "best": []}
            else:
                infos = self.engine.analyse(board, chess.engine.Limit(depth=self.depth), multipv=self.lines)
                entry = {
                    "cp": infos[0]["score"].white().score(mate_score=100000),
                    "best": [info["pv"][0].uci() for info in infos if info.get("pv")],
                }
            self.cache[key] = entry
            self.computed += 1
            best = ", ".join(board.san(chess.Move.from_uci(u)) for u in entry["best"]) or "none"
            progress("evaluations")
            detail(f"stockfish: {line_of(board)}: {entry['cp'] / 100:+.2f} (White's view), best {best} "
                f"(depth {self.depth}, evaluation {self.computed})")
            if self.computed % 200 == 0:
                self.save()
        return entry

    def save(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.cache))
        tmp.replace(self.cache_path)

    def close(self) -> None:
        self.save()
        self.engine.quit()


class EvaluationObjective(Objective):
    """The expected Stockfish evaluation where preparation ends."""

    name = "expected evaluation"

    def fmt(self, v: float) -> str:
        return f"{v:+.2f}"

    def change(self, g: float) -> str:
        return f"{g:+.2f} pawns"

    def value(self, board: chess.Board, white: int, draws: int, black: int) -> float:
        cp = self.evaluator.get(board)["cp"]
        pawns = (cp if self.side == chess.WHITE else -cp) / 100
        return max(-self.a.mate_cap, min(self.a.mate_cap, pawns))

    def end_value(self, row: dict | None, after: chess.Board) -> float | None:
        """A line ending with your move: as on Lirep, the evaluations after
        the opponent's replies, weighted by how often each is played."""
        return None

    def extra_candidates(self, board: chess.Board) -> list[str]:
        if self.a.engine_candidates <= 0:
            return []
        return self.evaluator.get(board)["best"][: self.a.engine_candidates]


class HybridObjective(Objective):
    """The expected score, valuing a line's end by the explorer's results
    where they count at least MIN_LEAF_GAMES games, by Stockfish's
    evaluation (as an expected score) where they count fewer."""

    def stockfish(self, board: chess.Board) -> float:
        cp = self.evaluator.get(board)["cp"]
        return score_from_cp(cp if self.side == chess.WHITE else -cp)

    def value(self, board: chess.Board, white: int, draws: int, black: int) -> float:
        if white + draws + black >= MIN_LEAF_GAMES:
            return score(white, draws, black, self.side, self.a.prior_games)
        return self.stockfish(board)

    def end_value(self, row: dict | None, after: chess.Board) -> float | None:
        """A line ending with your move: its own results, or, under
        MIN_LEAF_GAMES games (or not listed), Stockfish's value after it."""
        if row and games_of(row) >= MIN_LEAF_GAMES:
            return score(row["white"], row["draws"], row["black"], self.side, self.a.prior_games)
        return self.stockfish(after)

    def extra_candidates(self, board: chess.Board) -> list[str]:
        if self.a.engine_candidates <= 0:
            return []
        return self.evaluator.get(board)["best"][: self.a.engine_candidates]


# ---- Greedy -----------------------------------------------------------------


class Greedy:
    """Adds your moves one at a time, each time the one that raises the
    expected value most, printing the value after each, until the target
    (or the number of moves) is reached. Not always optimal, but it needs
    only the positions next to the repertoire, and has an answer after
    every move.

    The repertoire is a tree {san: subtree} from the start. An addition is
    one of your moves answering an opponent reply the tree leaves
    unanswered: after one of your moves inside a line, or after a line's
    last move (extending it). Values are Lirep's, as in Objective: a line ends
    with its last answered move, and an unanswered reply counts with its
    own results."""

    def __init__(self, objective: Objective, board: chess.Board, side: chess.Color, tree: dict, a: argparse.Namespace):
        self.s, self.board, self.side, self.tree, self.a = objective, board, side, tree, a
        self.upper = a.mate_cap if isinstance(objective, EvaluationObjective) else 1.0  # the best value possible
        self.options: dict[str, list[tuple[float, str]]] = {}  # FEN -> your candidates' values, best first
        self.ahead: dict[tuple[str, float], Node] = {}  # --lookahead: (FEN, reach) -> its search

    # -- Values ---------------------------------------------------------------

    def listed(self, board: chess.Board) -> tuple[dict, list[dict]]:
        data = self.s.explorer.get(board)
        return data, [m for m in data["moves"] if games_of(m) > 0]

    def unanswered(self, board: chess.Board, row: dict) -> float:
        """An opponent's move left unanswered (`board`: after it)."""
        return self.s.value(board, row["white"], row["draws"], row["black"])

    def end_value(self, row: dict | None, after: chess.Board) -> float:
        """A line ending with your move (`row`: its explorer row, `after`:
        the position it leads to)."""
        value = self.s.end_value(row, after)
        return self.opponent(after, {}) if value is None else value

    def opponent(self, board: chess.Board, sub: dict) -> float:
        """The opponent to move, with the tree's replies `sub`."""
        data, moves = self.listed(board)
        total = sum(games_of(m) for m in moves)
        if not total:
            return self.s.value(board, data["white"], data["draws"], data["black"])
        value = 0.0
        for m in moves:
            after = board.copy()
            after.push_uci(m["uci"])
            child = sub.get(m["san"])
            value += games_of(m) / total * (self.own(after, child) if child else self.unanswered(after, m))
        return value

    def own(self, board: chess.Board, sub: dict) -> float:
        """Your move, the tree's being the first key of `sub`."""
        san = next(iter(sub))
        after = board.copy()
        after.push_san(san)
        if self.goes_on(sub[san]):
            return self.opponent(after, sub[san])
        _, moves = self.listed(board)
        return self.end_value(next((m for m in moves if m["san"] == san), None), after)

    @staticmethod
    def goes_on(sub: dict) -> bool:
        """After your move: one of the opponent's replies is answered."""
        return any(child for child in sub.values())

    def total(self) -> float:
        if self.board.turn == self.side:
            if self.tree:
                return self.own(self.board, self.tree)
            data = self.s.explorer.get(self.board)
            return self.s.value(self.board, data["white"], data["draws"], data["black"])
        return self.opponent(self.board, self.tree)

    # -- The additions --------------------------------------------------------

    def positions(self):
        """The opponent's turns in the tree: (board, its replies in the tree
        (the dict itself, to add to), share of the games reaching it, the
        value of the line ending before it if no reply is answered, else
        None). At the start, the opponent's turn always counts."""
        out = []

        def opp(board, sub, reach, ended):
            doing(f"Looking for the next move: valuing the repertoire's position {line_of(board)}")
            out.append((board, sub, reach, ended))
            _, moves = self.listed(board)
            total = sum(games_of(m) for m in moves)
            for m in moves:
                child = sub.get(m["san"])
                if child:
                    after = board.copy()
                    after.push_uci(m["uci"])
                    own(after, child, reach * games_of(m) / total)

        def own(board, sub, reach):
            san = next(iter(sub))
            after = board.copy()
            after.push_san(san)
            ended = None
            if not self.goes_on(sub[san]):
                _, moves = self.listed(board)
                ended = self.end_value(next((m for m in moves if m["san"] == san), None), after)
            opp(after, sub[san], reach, ended)

        if self.board.turn == self.side:
            if self.tree:
                own(self.board, self.tree, 1.0)
        else:
            opp(self.board, self.tree, 1.0, None)
        return out

    def candidates(self, board: chess.Board) -> list[tuple[float, str]]:
        """Your candidate moves at `board`, with the value of a line ending
        with each, best first."""
        fen = board.fen()
        if fen not in self.options:
            _, moves = self.listed(board)
            rows = {m["uci"]: m for m in moves}
            values = []
            for uci in self.candidate_moves(board):
                after = board.copy()
                after.push_uci(uci)
                values.append((self.end_value(rows.get(uci), after), board.san(chess.Move.from_uci(uci))))
            self.options[fen] = sorted(values, reverse=True)
        return self.options[fen]

    def candidate_moves(self, board: chess.Board) -> list[str]:
        """Your candidate moves at `board` (UCI): your most played, sound
        ones, and the objective's extra ones."""
        _, moves = self.listed(board)
        played = sorted((m for m in moves if games_of(m) >= self.a.min_games), key=lambda m: -games_of(m))
        ucis = []
        for m in played:
            if len(ucis) == self.a.candidates:
                break
            if not self.unsound(board, m["uci"]):
                ucis.append(m["uci"])
        return ucis + [u for u in self.s.extra_candidates(board) if u not in ucis and not self.unsound(board, u)]

    def answers(self, after: chess.Board, reach: float, row: dict, left: int) -> list[tuple[int, float, dict]]:
        """The ways to answer the opponent's move that led to `after` (its
        explorer row `row`, reached by `reach` of the games): (your moves,
        the value there, the moves as {san: subtree}), with at most `left`
        moves. Plain greedy: your best candidate, the line ending with it.
        With --lookahead K: the best answer with 1, 2, ... K moves."""
        if self.a.lookahead <= 1:
            return [(1, value, {san: {}}) for value, san in self.candidates(after)[:1]]
        key = (after.fen(), reach)
        if key not in self.ahead:
            self.ahead[key] = Lookahead(self, self.a.lookahead).own(
                after, reach, self.a.lookahead, (row["white"], row["draws"], row["black"]))
        node = self.ahead[key]
        best = _prefix_max(node.answered)[0]
        out = []
        for c in range(1, min(self.a.lookahead, left) + 1):
            tree = own_solution(node, c)
            moves = count_own(tree, True)
            if tree and moves == c:  # with fewer moves, already listed
                out.append((moves, best[c], tree))
        return out

    def unsound(self, board: chess.Board, uci: str) -> bool:
        """Your move `uci` loses more than --max-loss against Stockfish's best."""
        if self.a.max_loss is None:
            return False
        after = board.copy()
        after.push_uci(uci)
        loss = self.s.cp(board) - self.s.cp(after)
        if loss > self.a.max_loss:
            detail(f"left out: {line_of(after)} loses {loss:.0f} centipawns")
            return True
        return False

    def best_addition(self, left: int):
        """The addition with the most gain per move (with the plain greedy,
        one move: the most gain): (gain, position's replies dict, reply's
        san, your moves as {san: subtree}, board after the reply, number of
        moves), and how many replies were examined out of how many. The
        replies are looked at by their best possible gain, stopping when it
        can't beat the best found (only those need explorer data). At the
        start, your move with nothing prepared yet: your first move (reply
        None). At most `left` moves."""
        if self.board.turn == self.side and not self.tree:
            doing("Looking for the next move: trying your first moves")
            now = self.total()
            best, ranked = None, []
            for value, san in self.candidates(self.board):  # best first
                done = self.board.copy()
                done.push_san(san)
                ranked.append((value - now, done))
                best = best or (value - now, self.tree, None, {san: {}}, self.board, 1)
            return best, ranked[:3], 1, 1
        frontier = []
        for board, sub, reach, ended in self.positions():
            _, moves = self.listed(board)
            total = sum(games_of(m) for m in moves)
            if not total:
                continue
            values, ps = {}, {}
            for m in moves:
                after = board.copy()
                after.push_uci(m["uci"])
                child = sub.get(m["san"])
                values[m["san"]] = self.own(after, child) if child else self.unanswered(after, m)
                ps[m["san"]] = games_of(m) / total
            now = sum(ps[s] * values[s] for s in values)
            for m in moves:
                if sub.get(m["san"]):
                    continue  # answered already
                p = ps[m["san"]]
                if reach * p < self.a.min_reach:
                    continue
                # Answering m changes this position's value by p * (yours - m's).
                # A line ended before it: it goes on, worth this position.
                base = now - p * values[m["san"]]
                old = now if ended is None else ended
                frontier.append((reach * (base + p * self.upper - old), reach, p, base, old, board, sub, m))
        frontier.sort(key=lambda f: -f[0])
        doing(f"Looking for the next move: {len(frontier)} unanswered replies, most promising first")
        # A reply's bound is on its gain, so on its gain per move too.
        best, rate, ranked, examined = None, NEG, [], 0
        for bound, reach, p, base, old, board, sub, m in frontier:
            if best and bound <= rate:
                break
            examined += 1
            after = board.copy()
            after.push_uci(m["uci"])
            doing(f"Looking for the next move: trying answers to {line_of(after)} "
                  f"(reply {examined} of at most {len(frontier)})")
            for moves, value, tree in self.answers(after, reach * p, m, left):
                gain = reach * (base + p * value - old)
                done = after.copy()
                done.push_san(next(iter(tree)))
                ranked.append((gain / moves, done))
                if best is None or gain / moves > rate:
                    best, rate = (gain, sub, m["san"], tree, after, moves), gain / moves
        ranked.sort(key=lambda r: -r[0])
        return best, ranked[:3], examined, len(frontier)

    def run(self, target: float | None, budget: int) -> int:
        fmt, name, change = self.s.fmt, self.s.name, self.s.change
        doing("Valuing the base repertoire: reading the explorer for each of its positions", milestone=True)
        value = self.total()
        log(f"start: {name} {fmt(value)}"
            + (f"; target {fmt(target)}" if target is not None else f"; adding up to {budget} moves"))
        added = 0
        while (target is None or value < target - 1e-12) and added < budget:
            doing(f"Looking for move {added + 1}: listing the replies the repertoire leaves unanswered", milestone=True)
            best, ranked, examined, size = self.best_addition(budget - added)
            if best is None or best[0] <= 1e-12:
                log("no addition raises the value any more: stopping")
                break
            gain, sub, reply, tree, after, moves = best
            if reply is None:
                sub.update(tree)
            else:
                sub[reply] = tree
            added += moves
            new = self.total()
            label = f"move {added}" if moves == 1 else f"moves {added - moves + 1}-{added}"
            log(f"{label}: {'; '.join(own_lines(after, tree))}  ->  {name} {fmt(new)} ({change(new - value)})")
            if len(ranked) > 1:
                detail("         next best (per move): " + "; ".join(f"{line_of(b)} {change(g)}" for g, b in ranked[1:]))
            if abs(new - value - gain) > 1e-9:
                log(f"         (the gain was expected to be {change(gain)})")
            value = new
        if target is not None and value >= target - 1e-12:
            log(f"target reached: {fmt(value)} with {added} new moves")
        return added


# ---- Lookahead --------------------------------------------------------------


@dataclass
class Node:
    """A position in a lookahead search. Values are for c = 0..K: the best
    value with at most c of your moves from here on.

    Your turn (own): `stop` if the opponent's move that led here stays
    unanswered (worth its own results), `answered[c]` if you answer it with
    one of your moves (NEG if impossible), through `moves` (san, explorer
    row, the opponent's turn after it or None) and, for each c, `choice`
    (move index, "end" or "go", moves for the opponent's turn).

    The opponent's turn: `none` if none of the replies is answered,
    `going[c]` if at least one is, through `replies` (san, share, your
    turn after it) and, for each reply and c, `steps` (moves given to it,
    the previous state "none"/"some", the reply "ans"/"unans")."""

    board: chess.Board
    own: bool
    stop: float = NEG
    answered: list[float] = field(default_factory=list)
    moves: list[tuple[str, dict | None, "Node | None"]] = field(default_factory=list)
    choice: list[tuple[int, str, int] | None] = field(default_factory=list)
    none: float = NEG
    going: list[float] = field(default_factory=list)
    replies: list[tuple[str, float, "Node"]] = field(default_factory=list)
    steps: list[list[tuple[int, str, str] | None]] = field(default_factory=list)


def _prefix_max(values: list[float]) -> tuple[list[float], list[int]]:
    """Best with at most c moves, and which c achieves it."""
    out, arg = list(values), list(range(len(values)))
    for c in range(1, len(values)):
        if out[c - 1] > out[c]:
            out[c], arg[c] = out[c - 1], arg[c - 1]
    return out, arg


class Lookahead:
    """--lookahead K: the best way to answer one of the opponent's moves
    with up to K of your moves, from the leaves up: for each position, the
    best value with at most c of your moves. At your turn: leave the move
    unanswered, or answer it with one of your candidates (one move), the
    line ending there or going on. At the opponent's: split the moves
    between the replies (a knapsack over them, weighted by how often each
    is played). Values and candidates are Greedy's; replies reached by
    fewer than --min-reach of the games aren't answered."""

    def __init__(self, greedy: Greedy, budget: int):
        self.g, self.budget = greedy, budget

    def own(self, board: chess.Board, reach: float, depth: int, games: tuple[int, int, int]) -> Node:
        """Your turn, after an opponent's move with results `games`, reached
        by `reach` of the games; `depth`: your moves that may still follow
        in a line, this one included."""
        g, B = self.g, self.budget
        node = Node(board, True, stop=g.s.value(board, *games))
        if depth > 0 and reach >= g.a.min_reach:
            _, listed = g.listed(board)
            rows = {m["uci"]: m for m in listed}
            for uci in g.candidate_moves(board):
                after = board.copy()
                after.push_uci(uci)
                child = self.opponent(after, reach, depth - 1) if depth > 1 else None
                node.moves.append((board.san(chess.Move.from_uci(uci)), rows.get(uci), child))
        answered, choice = [NEG] * (B + 1), [None] * (B + 1)
        for i, (san, row, child) in enumerate(node.moves):
            after = board.copy()
            after.push_san(san)
            end = g.end_value(row, after)
            going = _prefix_max(child.going)[0] if child else [NEG] * (B + 1)
            for c in range(1, B + 1):
                if end > answered[c]:
                    answered[c], choice[c] = end, (i, "end", 0)
                if going[c - 1] > answered[c]:
                    answered[c], choice[c] = going[c - 1], (i, "go", c - 1)
        node.answered, node.choice = answered, choice
        return node

    def opponent(self, board: chess.Board, reach: float, depth: int) -> Node:
        """The opponent's turn, after one of your moves."""
        g, B = self.g, self.budget
        node = Node(board, False)
        data, listed = g.listed(board)
        total = sum(games_of(m) for m in listed)
        if not total:  # no games here: the position's worth, nothing to answer
            node.none = g.s.value(board, data["white"], data["draws"], data["black"])
            node.going = [NEG] * (B + 1)
            return node
        for m in listed:
            p = games_of(m) / total
            after = board.copy()
            after.push_uci(m["uci"])
            node.replies.append((m["san"], p, self.own(after, reach * p, depth, (m["white"], m["draws"], m["black"]))))
        # Knapsack over the replies, keeping "none answered" apart.
        none, some = 0.0, [NEG] * (B + 1)
        for _, p, child in node.replies:
            unans, ans = child.stop, child.answered
            nxt, step = [NEG] * (B + 1), [None] * (B + 1)
            for c in range(B + 1):
                if some[c] > NEG and some[c] + p * unans > nxt[c]:
                    nxt[c], step[c] = some[c] + p * unans, (0, "some", "unans")
                for k in range(c + 1):
                    if ans[k] > NEG and some[c - k] > NEG and some[c - k] + p * ans[k] > nxt[c]:
                        nxt[c], step[c] = some[c - k] + p * ans[k], (k, "some", "ans")
                if ans[c] > NEG and none + p * ans[c] > nxt[c]:
                    nxt[c], step[c] = none + p * ans[c], (c, "none", "ans")
            some = nxt
            none += p * unans
            node.steps.append(step)
        node.none, node.going = none, some
        return node


def own_solution(node: Node, budget: int) -> dict:
    """Your moves answering at `node` with at most `budget` of them, as
    {san: subtree}; {} if leaving it unanswered is as good."""
    values, arg = _prefix_max(node.answered)
    if values[budget] <= node.stop or node.choice[arg[budget]] is None:
        return {}
    i, mode, k = node.choice[arg[budget]]
    san, _, child = node.moves[i]
    return {san: {} if mode == "end" else _opponent_solution(child, k)}


def _opponent_solution(node: Node, budget: int) -> dict:
    budget = _prefix_max(node.going)[1][budget]
    out: dict = {}
    state = "some"
    for (san, _, child), step in reversed(list(zip(node.replies, node.steps))):
        if state == "none":
            continue  # earlier replies: all unanswered
        k, state, mode = step[budget]
        budget -= k
        if mode == "ans":
            sub = own_solution(child, k)
            if sub:
                out[san] = sub
    return out


def own_lines(board: chess.Board, tree: dict) -> list[str]:
    """The lines to each of your moves in `tree` ({san: subtree}, your turn
    at `board`)."""
    out = []
    for san, sub in tree.items():
        after = board.copy()
        after.push_san(san)
        out.append(line_of(after))
        for reply, deeper in sub.items():
            next_board = after.copy()
            next_board.push_san(reply)
            out += own_lines(next_board, deeper)
    return out


# ---- The repertoire ---------------------------------------------------------


def count_own(tree: dict, own: bool) -> int:
    return sum((1 if own else 0) + count_own(sub, not own) for sub in tree.values())


def print_tree(tree: dict, board: chess.Board, indent: int, replies: dict[str, float],
               base: dict | None = None, side: chess.Color | None = None) -> None:
    """With `base`, your moves that aren't in it are marked as new."""
    for san, sub in sorted(tree.items(), key=lambda kv: -replies.get(kv[0], 0)):
        ply = board.ply()
        number = f"{ply // 2 + 1}." if board.turn == chess.WHITE else f"{ply // 2 + 1}..."
        share = f"  ({replies[san]:.0%})" if san in replies else ""
        new = "   <- new" if base is not None and board.turn == side and san not in base else ""
        print("  " * indent + f"{number} {san}{share}{new}")
        child = board.copy()
        child.push_san(san)
        print_tree(sub, child, indent + 1, {}, None if base is None else base.get(san, {}), side)


def count_new(tree: dict, base: dict, own: bool) -> int:
    """Your moves in `tree` that aren't in `base`."""
    return sum((1 if own and san not in base else 0) + count_new(sub, base.get(san, {}), not own)
               for san, sub in tree.items())


def file_tree(moves: list[dict]) -> dict:
    """A Lirep study file's lines as {san: subtree}."""
    tree: dict = {}

    def add(node: dict, line: list[dict]) -> None:
        if not line:
            return
        sub = node.setdefault(line[0]["san"], {})
        for variation in line[0].get("variations", []):
            add(node, variation)
        add(sub, line[1:])

    add(tree, moves)
    return tree


def study_moves(prefix: list[str], tree: dict) -> list[dict]:
    """Lirep's study-file lines: the main line, then each move's variations."""

    def line(san: str, sub: dict) -> list[dict]:
        moves = [{"san": san}]
        if sub:
            items = list(sub.items())
            first = line(*items[0])
            if len(items) > 1:
                first[0]["variations"] = [line(s, t) for s, t in items[1:]]
            moves += first
        return moves

    head = [{"san": s} for s in prefix]
    items = list(tree.items())
    if not items:
        return head
    rest = line(*items[0])
    if len(items) > 1:
        rest[0]["variations"] = [line(s, t) for s, t in items[1:]]
    return head + rest


def run(a: argparse.Namespace, make_objective, extra_parameters: list[str]) -> None:
    """Adds the moves, then prints the repertoire (and writes it as a study
    file with --out). `make_objective(explorer, side)` builds the Objective."""
    side = chess.WHITE if a.side == "white" else chess.BLACK
    board = chess.Board()
    prefix = a.moves.split()
    for san in prefix:
        board.push_san(san)

    base = None
    if a.base:
        base = file_tree(json.loads(a.base.read_text())["moves"])
        for san in prefix:
            if san not in base:
                sys.exit(f"{a.base} doesn't start with {a.moves}")
            base = base[san]
    local = urllib.parse.urlparse(a.explorer).hostname in ("127.0.0.1", "localhost")
    delay = a.delay if a.delay is not None else (0.0 if local else DELAY)
    token = os.environ.get("LICHESS_TOKEN")
    if not token and TOKEN_FILE.exists():
        token = TOKEN_FILE.read_text().strip()
    if not local and not token:
        print(f"Note: neither LICHESS_TOKEN nor {TOKEN_FILE} is set; Lichess's explorer may refuse the requests (401). Create a token "
              "at https://lichess.org/account/oauth/token (no scope needed).", flush=True)
    explorer = Explorer(a.explorer, a.speeds, a.ratings, delay, token,
                        None if a.no_explorer_cache else a.explorer_cache, a.cache_days)
    try:
        _run(a, make_objective, extra_parameters, board, prefix, side, base, explorer)
    finally:
        explorer.save()


def _run(a, make_objective, extra_parameters, board, prefix, side, base, explorer) -> None:
    start = explorer.get(board)
    print("Parameters:")
    print(f"  data:       {a.explorer}, speeds {a.speeds}, {a.pool}: "
          f"{start['white'] + start['draws'] + start['black']:,} games at the start")
    print(f"  requests:   {explorer.delay:g} s apart; cache "
          + ("off" if explorer.cache_path is None else f"{explorer.cache_path} ({len(explorer.disk):,} answers, "
             f"kept {a.cache_days:g} days)"))
    print(f"  candidates: {a.candidates} per position, replies down to {a.min_reach:.1%} of games"
          + (f"; looking {a.lookahead} moves ahead" if a.lookahead > 1 else ""))
    for line in extra_parameters:
        print(f"  {line}")
    if base is not None:
        print(f"  base:       {a.base}, {count_own(base, board.turn == side)} of your moves, kept")
    print(flush=True)
    objective = make_objective(explorer, side)
    tree = json.loads(json.dumps(base)) if base else {}
    greedy = Greedy(objective, board, side, tree, a)
    added = greedy.run(a.target, a.moves_budget if a.moves_budget is not None else a.max_moves)
    explorer.save()
    log("done")
    print(f"\n{added} moves added: {explorer.queries:,} explorer requests, {explorer.from_cache:,} answers "
          f"from the cache, in {time.monotonic() - START:.0f} s.\n")
    _, moves = greedy.listed(board) if board.turn != side else (None, [])
    total = sum(games_of(m) for m in moves)
    finish(a, tree, board, side, base, prefix, {m["san"]: games_of(m) / total for m in moves} if total else {},
           f"{a.moves or 'Repertoire'}, {objective.name} with {added} new moves")


def finish(a, tree: dict, board: chess.Board, side: chess.Color, base: dict | None, prefix: list[str],
           replies: dict[str, float], name: str) -> None:
    """Prints the repertoire, and writes it as a study file with --out: the
    base file's own, with these moves, if there is one."""
    own = board.turn == side
    print_tree(tree, board, 0, replies, base, side)
    total = count_own(tree, own)
    if base is None:
        print(f"\n({total} of your moves in this tree.)")
    else:
        print(f"\n({total} of your moves in this tree, {count_new(tree, base, own)} of them new.)")

    if a.out:
        if a.base:
            study = json.loads(a.base.read_text())
            study["name"] = f"{study.get('name', 'Repertoire')} ({name})"
        else:
            local = urllib.parse.urlparse(a.explorer).hostname in ("127.0.0.1", "localhost")
            study = {
                "format": "lirep-study",
                "version": 1,
                "name": name,
                "side": a.side,
                "explorerSettings": {"source": "lirep" if local else "lichess", "database": "lichess",
                                     "minRating": int(a.ratings.split(",")[0]), "speeds": a.speeds.split(",")},
            }
        study["moves"] = study_moves(prefix, tree)
        with open(a.out, "w") as f:
            json.dump(study, f, indent=2)
            f.write("\n")
        print(f"\nWrote {a.out} (import it on Lirep's home page).")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--moves", default="", help="The opening, in SAN from the initial position (e.g. 'b3').")
    parser.add_argument("--side", choices=["white", "black"], required=True)
    goal = parser.add_mutually_exclusive_group(required=True)
    goal.add_argument("--moves-budget", type=int, metavar="N", help="Add N moves.")
    goal.add_argument("--target", type=float,
                      help="Add moves until the value reaches this: an expected score (0 to 1) or, with "
                           "--objective evaluation, an expected evaluation in pawns (e.g. 0.5).")
    parser.add_argument("--objective", choices=["score", "evaluation", "hybrid"], default=OBJECTIVE,
                        help=f"The explorer's expected score, Stockfish's expected evaluation, or the expected "
                             f"score with Stockfish under {MIN_LEAF_GAMES} games (default {OBJECTIVE}).")
    parser.add_argument("--explorer", default=EXPLORER,
                        help=f"The explorer's URL (default {EXPLORER}; the local one: http://127.0.0.1:9002).")
    parser.add_argument("--delay", type=float,
                        help=f"Seconds between two explorer requests (default {DELAY:g}; 0 for a local explorer).")
    parser.add_argument("--explorer-cache", type=Path, default=EXPLORER_CACHE,
                        help=f"Where explorer answers are kept between runs (default {EXPLORER_CACHE}).")
    parser.add_argument("--cache-days", type=float, default=CACHE_DAYS,
                        help=f"Explorer answers older than this are asked again (default {CACHE_DAYS}).")
    parser.add_argument("--no-explorer-cache", action="store_true", help="Ask the explorer for everything.")
    parser.add_argument("--verbose", action="store_true",
                        help="Print each explorer request and Stockfish evaluation, and the next best moves.")
    parser.add_argument("--speeds", default=SPEEDS)
    pool = parser.add_mutually_exclusive_group()
    pool.add_argument("--min-rating", type=int,
                      help=f"Games whose players average at least this, by rating group (default {MIN_RATING}).")
    pool.add_argument("--ratings", help="Exact explorer rating groups instead, e.g. '1800,2000'.")
    parser.add_argument("--candidates", type=int, default=CANDIDATES, help="Your most played moves considered per position.")
    parser.add_argument("--min-reach", type=float, default=MIN_REACH,
                        help="Replies reached by fewer games than this share aren't answered.")
    parser.add_argument("--max-moves", type=int, default=MAX_MOVES, help="With --target: the most moves added.")
    parser.add_argument("--lookahead", type=int, default=LOOKAHEAD, metavar="K",
                        help=f"Answer each reply in the best way with up to K of your moves, and add the answer with "
                             f"the most gain per move (default {LOOKAHEAD}: one move at a time).")
    parser.add_argument("--max-loss", default=MAX_LOSS, metavar="CP",
                        help="Leave out your moves losing more than CP centipawns against Stockfish's best, or "
                             "by name: " + ", ".join(f"{k} ({v})" for k, v in LOSS_LEVELS.items())
                             + ", or any (the default: any move).")
    parser.add_argument("--base", type=Path,
                        help="A Lirep study file to build on: its moves are kept, and the moves are added to "
                             "it. It must start with --moves.")
    parser.add_argument("--out", help="Write the repertoire as a Lirep study file.")
    safety = parser.add_argument_group("safeguards against small samples")
    safety.add_argument("--min-games", type=int,
                        help=f"Games one of your played moves needs to be a candidate "
                             f"(default {MIN_GAMES}; {MIN_GAMES_EVALUATION} with --objective evaluation).")
    safety.add_argument("--prior-games", type=float,
                        help=f"Shrink explorer scores toward 50%% as if this many more games had been drawn "
                             f"(default {PRIOR_GAMES}; 0 with --objective evaluation).")
    safety.add_argument("--no-safeguards", action="store_true",
                        help="Trust the explorer's scores as they are: no shrinkage, and any move played at least "
                             "once can be a candidate (unless --min-games or --prior-games are given).")
    engine = parser.add_argument_group("Stockfish (--objective evaluation or hybrid, or --max-loss)")
    engine.add_argument("--stockfish", default=STOCKFISH)
    engine.add_argument("--depth", type=int, default=DEPTH)
    engine.add_argument("--engine-candidates", type=int, default=ENGINE_CANDIDATES,
                        help="Stockfish's best moves added to your candidates.")
    engine.add_argument("--mate-cap", type=float, default=MATE_CAP, help="Cap evaluations at +/- this many pawns.")
    engine.add_argument("--cache", type=Path, default=CACHE)
    a = parser.parse_args()
    global VERBOSE
    VERBOSE = a.verbose

    if a.ratings is None:
        floor = MIN_RATING if a.min_rating is None else a.min_rating
        groups = [g for g in RATING_GROUPS if g >= floor]
        if not groups:
            parser.error(f"no rating group starts at {floor} or above (the last starts at {RATING_GROUPS[-1]})")
        a.ratings = ",".join(map(str, groups))
        a.pool = f"games averaging {groups[0]}+"
        if groups[0] != floor:
            a.pool += f" ({floor} isn't a group boundary)"
    else:
        a.pool = f"rating groups {a.ratings}"
    if a.lookahead < 1:
        parser.error("--lookahead: at least 1")
    if a.max_loss == "any":
        a.max_loss = None
    if a.max_loss is not None:
        try:
            a.max_loss = LOSS_LEVELS[a.max_loss] if a.max_loss in LOSS_LEVELS else float(a.max_loss)
        except ValueError:
            parser.error(f"--max-loss: {a.max_loss} is neither {', '.join(LOSS_LEVELS)}, any nor a number")
    evaluation = a.objective == "evaluation"
    hybrid = a.objective == "hybrid"
    if a.min_games is None:
        a.min_games = 1 if a.no_safeguards else (
            MIN_GAMES_EVALUATION if evaluation else MIN_LEAF_GAMES if hybrid else MIN_GAMES)
    if a.prior_games is None:
        a.prior_games = 0 if a.no_safeguards or evaluation else PRIOR_GAMES

    soundness = ([] if a.max_loss is None else
                 [f"soundness:  your moves losing over {a.max_loss:g} centipawns against Stockfish's best "
                  f"(depth {a.depth}) left out"])
    evaluator = (Evaluator(a.stockfish, a.depth, a.engine_candidates, a.cache)
                 if evaluation or hybrid or a.max_loss is not None else None)
    try:
        if hybrid:
            run(a, lambda explorer, side: HybridObjective(explorer, side, a, evaluator),
                [f"leaves:     explorer results, Stockfish (depth {a.depth}) under {MIN_LEAF_GAMES} games; "
                 f"{a.engine_candidates} engine candidates per position",
                 f"safeguards: {a.min_games} games per played candidate move, scores shrunk by "
                 f"{a.prior_games:g} games"] + soundness)
        elif evaluation:
            run(a, lambda explorer, side: EvaluationObjective(explorer, side, a, evaluator),
                [f"stockfish:  depth {a.depth}, {a.engine_candidates} engine candidates per position, "
                 f"evaluations capped at ±{a.mate_cap:g} pawns",
                 f"safeguards: {a.min_games} games per played candidate move"] + soundness)
        else:
            run(a, lambda explorer, side: Objective(explorer, side, a, evaluator),
                [f"safeguards: {a.min_games} games per candidate move, scores shrunk by {a.prior_games:g} games"
                 + ("  (--no-safeguards)" if a.no_safeguards else "")] + soundness)
    finally:
        if evaluator:
            print(f"({evaluator.computed} new Stockfish evaluations; cache: {a.cache})")
            evaluator.close()


if __name__ == "__main__":
    main()
