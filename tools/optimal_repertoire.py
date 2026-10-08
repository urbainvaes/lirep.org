#!/usr/bin/env python3
"""The best repertoire for a number of memorized moves.

Given an opening (moves from the initial position), the side it is for and
an opening explorer, finds the repertoire tree with the best value for at
most a given number of your own moves to memorize (--moves-budget), or the
fewest moves reaching a target value (--target). A memorized move is one of
your moves in the tree.

Two objectives (--objective), both as on Lirep's Stats page. Walking the
tree, the opponent's replies are weighted by how often they are played in the
explorer, and the value where preparation ends is:
  score       the explorer's score (the default): where preparation stops on
              your move, that position's score; after an opponent reply you
              haven't prepared, that reply's own score. As a percentage.
  evaluation  Stockfish's evaluation of those same positions, in pawns from
              your side's point of view. Stockfish's own best moves are then
              candidates at your turn too, played or not, and evaluations are
              cached in a file, so a second run on the same opening is fast.

Both the cost and the value add up over the tree's branches, so the problem
is solved exactly, from the leaves up: for every position, the best value
reachable with 0, 1, 2, ... memorized moves. At your turn: stop, or play one
of the candidate moves (costing one move). At the opponent's turn: split the
budget between the replies (a knapsack over the replies, weighted by how
often each is played). To keep the search finite, only your most played
moves are candidates, and lines reached by few games, or too deep, end there.

All the parameters, with their defaults and what they mean, are in the
PARAMETERS block below; each can be changed on the command line.

Needs python-chess, an explorer speaking the Lichess explorer API (the local
one: explorer/start-server.sh) and, for the evaluation, Stockfish.

Examples, for the Alapin (1.e4 c5 2.c3) as White:
  # The best repertoire by expected score with at most 20 memorized moves:
  tools/optimal_repertoire.py --moves "e4 c5 c3" --side white --moves-budget 20
  # The same by expected Stockfish evaluation (Stockfish from Guix):
  guix shell stockfish -- tools/optimal_repertoire.py --moves "e4 c5 c3" \\
      --side white --moves-budget 20 --objective evaluation
  # The smallest repertoire reaching 56%, written as a Lirep study file:
  tools/optimal_repertoire.py --moves "e4 c5 c3" --side white --target 0.56 \\
      --out alapin.lirep.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import chess
import chess.engine

# =============================================================================
# PARAMETERS: the defaults; each can be changed on the command line (--help).
# =============================================================================

OBJECTIVE = "score"   # --objective: "score" (the explorer's) or "evaluation"
                      # (Stockfish's); see the top of this file

# ---- The data ---------------------------------------------------------------
EXPLORER = "http://127.0.0.1:9002"  # --explorer: the local explorer (Lichess API)
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

# ---- The search (what keeps it finite) --------------------------------------
CANDIDATES = 4      # --candidates: your most played moves considered in a position
MIN_REACH = 0.002   # --min-reach: a line reached by fewer than this share of the
                    # games at the start ends there (0.002 = 0.2%)
MAX_PLIES = 20      # --max-plies: deepest position searched, in plies from move 1
MAX_MOVES = 150     # --max-moves: with --target, the largest repertoire considered

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


class Explorer:
    def __init__(self, url: str, speeds: str, ratings: str):
        self.url, self.speeds, self.ratings = url.rstrip("/"), speeds, ratings
        self.cache: dict[str, dict] = {}
        self.queries = 0

    def get(self, board: chess.Board) -> dict:
        fen = board.fen()
        if fen not in self.cache:
            query = urllib.parse.urlencode({"fen": fen, "speeds": self.speeds, "ratings": self.ratings})
            with urllib.request.urlopen(f"{self.url}/lichess?{query}", timeout=60) as resp:
                self.cache[fen] = json.load(resp)
            self.queries += 1
        return self.cache[fen]


def score(white: int, draws: int, black: int, side: chess.Color, prior: float) -> float:
    """Expected score for `side`, shrunk toward 0.5 by `prior` games."""
    n = white + draws + black
    points = (white if side == chess.WHITE else black) + draws / 2
    return (points + prior / 2) / (n + prior) if n + prior else 0.5


# ---- The search -------------------------------------------------------------


@dataclass
class Node:
    """A position. best[c]: the best expected score with at most c of your
    moves memorized from here on."""

    board: chess.Board
    own: bool  # your move here
    stop: float  # the score if preparation ends here
    best: list[float] = field(default_factory=list)
    # Your turn: for each budget c, the chosen move's index (None: stop).
    choice: list[int | None] = field(default_factory=list)
    moves: list[tuple[str, "Node"]] = field(default_factory=list)  # your candidates
    # Opponent's turn: replies (san, probability, node), and for each reply
    # and budget, how much of the budget that reply got (for the solution).
    replies: list[tuple[str, float, "Node"]] = field(default_factory=list)
    split: list[list[int]] = field(default_factory=list)


class Search:
    """Maximizes the expected explorer score. A subclass can replace value()
    (what a position where preparation ends is worth) and extra_candidates()
    (moves of yours to consider besides the most played)."""

    def __init__(self, explorer: Explorer, side: chess.Color, args: argparse.Namespace):
        self.explorer, self.side, self.a = explorer, side, args
        self.budget = args.max_moves

    def value(self, board: chess.Board, white: int, draws: int, black: int) -> float:
        """What it's worth for preparation to end in `board`, reached in
        white/draws/black games: here, its explorer score."""
        return score(white, draws, black, self.side, self.a.prior_games)

    def extra_candidates(self, board: chess.Board) -> list[str]:
        """Moves (UCI) to consider at your turn besides the most played."""
        return []

    def node(self, board: chess.Board, reach: float, plies: int) -> Node:
        data = self.explorer.get(board)
        own = board.turn == self.side
        node = Node(board, own, self.value(board, data["white"], data["draws"], data["black"]))
        deep = reach < self.a.min_reach or plies >= self.a.max_plies
        listed = [m for m in data["moves"] if m["white"] + m["draws"] + m["black"] > 0]
        total = sum(m["white"] + m["draws"] + m["black"] for m in listed)

        if own:
            if not deep:
                candidates = sorted(listed, key=lambda m: -(m["white"] + m["draws"] + m["black"]))
                candidates = [m for m in candidates if m["white"] + m["draws"] + m["black"] >= self.a.min_games]
                ucis = [m["uci"] for m in candidates[: self.a.candidates]]
                ucis += [u for u in self.extra_candidates(board) if u not in ucis]
                for uci in ucis:
                    move = chess.Move.from_uci(uci)
                    san = board.san(move)
                    child = board.copy()
                    child.push(move)
                    node.moves.append((san, self.node(child, reach, plies + 1)))
            node.best, node.choice = [node.stop] * (self.budget + 1), [None] * (self.budget + 1)
            for c in range(1, self.budget + 1):
                node.best[c], node.choice[c] = node.best[c - 1], node.choice[c - 1]
                for i, (_, child) in enumerate(node.moves):
                    if child.best[c - 1] > node.best[c] + 1e-12:
                        node.best[c], node.choice[c] = child.best[c - 1], i
            return node

        # The opponent's turn: replies weighted by how often they're played.
        # A reply too rare to explore still counts, with its own score.
        for m in listed:
            p = (m["white"] + m["draws"] + m["black"]) / total
            child = board.copy()
            child.push_uci(m["uci"])
            if deep or reach * p < self.a.min_reach:
                leaf = Node(child, True, self.value(child, m["white"], m["draws"], m["black"]))
                leaf.best, leaf.choice = [leaf.stop] * (self.budget + 1), [None] * (self.budget + 1)
                node.replies.append((m["san"], p, leaf))
            else:
                node.replies.append((m["san"], p, self.node(child, reach * p, plies + 1)))
        if not node.replies:  # no games here: the position's own score
            node.best = [node.stop] * (self.budget + 1)
            return node
        # Knapsack over the replies.
        acc = [0.0] * (self.budget + 1)
        for _, p, child in node.replies:
            nxt, arg = [NEG] * (self.budget + 1), [0] * (self.budget + 1)
            for c in range(self.budget + 1):
                for k in range(c + 1):
                    v = acc[c - k] + p * child.best[k]
                    if v > nxt[c] + 1e-12:
                        nxt[c], arg[c] = v, k
            acc = nxt
            node.split.append(arg)
        node.best = acc
        return node


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
            if self.computed % 200 == 0:
                print(f"  {self.computed} positions evaluated…", file=sys.stderr, flush=True)
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


class EvaluationSearch(Search):
    """Maximizes the expected Stockfish evaluation where preparation ends."""

    def __init__(self, explorer: Explorer, side: chess.Color, args: argparse.Namespace, evaluator: Evaluator):
        super().__init__(explorer, side, args)
        self.evaluator = evaluator

    def value(self, board: chess.Board, white: int, draws: int, black: int) -> float:
        cp = self.evaluator.get(board)["cp"]
        pawns = (cp if self.side == chess.WHITE else -cp) / 100
        return max(-self.a.mate_cap, min(self.a.mate_cap, pawns))

    def extra_candidates(self, board: chess.Board) -> list[str]:
        if self.a.engine_candidates <= 0:
            return []
        return self.evaluator.get(board)["best"][: self.a.engine_candidates]


# ---- The solution -----------------------------------------------------------


def solution(node: Node, budget: int) -> dict:
    """The chosen tree with `budget` moves, as {san: subtree}, your moves and
    the opponent replies that are followed by one of yours."""
    if node.own:
        i = node.choice[budget]
        if i is None:
            return {}
        san, child = node.moves[i]
        return {san: solution(child, budget - 1)}
    # Undo the knapsack, last reply first.
    out: dict = {}
    for (san, _, child), arg in reversed(list(zip(node.replies, node.split))):
        k = arg[budget]
        budget -= k
        sub = solution(child, k)
        if sub:
            out[san] = sub
    return out


def count_own(tree: dict, own: bool) -> int:
    return sum((1 if own else 0) + count_own(sub, not own) for sub in tree.values())


def print_tree(tree: dict, board: chess.Board, indent: int, replies: dict[str, float]) -> None:
    for san, sub in sorted(tree.items(), key=lambda kv: -replies.get(kv[0], 0)):
        ply = board.ply()
        number = f"{ply // 2 + 1}." if board.turn == chess.WHITE else f"{ply // 2 + 1}..."
        share = f"  ({replies[san]:.0%})" if san in replies else ""
        print("  " * indent + f"{number} {san}{share}")
        child = board.copy()
        child.push_san(san)
        print_tree(sub, child, indent + 1, {})


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


def common_parser(description: str, objective: str, target_help: str) -> argparse.ArgumentParser:
    """The options shared by the tools built on this search."""
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--moves", default="", help="The opening, in SAN from the initial position (e.g. 'b3').")
    parser.add_argument("--side", choices=["white", "black"], required=True)
    goal = parser.add_mutually_exclusive_group(required=True)
    goal.add_argument("--moves-budget", type=int, metavar="N",
                      help=f"Maximize the {objective} with at most N memorized moves.")
    goal.add_argument("--target", type=float, help=target_help)
    parser.add_argument("--explorer", default=EXPLORER)
    parser.add_argument("--speeds", default=SPEEDS)
    pool = parser.add_mutually_exclusive_group()
    pool.add_argument("--min-rating", type=int,
                      help=f"Games whose players average at least this, by rating group (default {MIN_RATING}).")
    pool.add_argument("--ratings", help="Exact explorer rating groups instead, e.g. '1800,2000'.")
    parser.add_argument("--candidates", type=int, default=CANDIDATES, help="Your most played moves considered per position.")
    parser.add_argument("--min-reach", type=float, default=MIN_REACH, help="Lines reached by fewer games than this share end.")
    parser.add_argument("--max-plies", type=int, default=MAX_PLIES)
    parser.add_argument("--max-moves", type=int, default=MAX_MOVES, help="With --target: the largest repertoire considered.")
    parser.add_argument("--out", help="Write the repertoire as a Lirep study file.")
    return parser


def resolve_common(parser: argparse.ArgumentParser, a: argparse.Namespace) -> None:
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
    # The search computes the best value for every repertoire size up to this.
    a.max_moves = a.moves_budget if a.moves_budget is not None else a.max_moves


def run(a: argparse.Namespace, make_search, objective: str, fmt, extra_parameters: list[str]) -> None:
    """Searches, then prints the best value for each repertoire size and the
    chosen tree (and writes it as a study file with --out). `fmt` formats a
    value; `make_search(explorer, side)` builds the Search."""
    side = chess.WHITE if a.side == "white" else chess.BLACK
    board = chess.Board()
    prefix = a.moves.split()
    for san in prefix:
        board.push_san(san)
    own_prefix = sum(1 for i in range(len(prefix)) if (i % 2 == 0) == (side == chess.WHITE))

    explorer = Explorer(a.explorer, a.speeds, a.ratings)
    start = explorer.get(board)
    print("Parameters:")
    print(f"  data:       {a.explorer}, speeds {a.speeds}, {a.pool}: "
          f"{start['white'] + start['draws'] + start['black']:,} games at the start")
    print(f"  search:     {a.candidates} candidates per position, lines down to {a.min_reach:.1%} of games, "
          f"{a.max_plies} plies deep")
    for line in extra_parameters:
        print(f"  {line}")
    sys.stdout.flush()
    root = make_search(explorer, side).node(board, 1.0, len(prefix))
    print(f"\n{explorer.queries} explorer positions searched.\n")
    print(f"Best {objective} by number of memorized moves (after the opening's own moves):")
    shown = [c for c in range(len(root.best)) if c <= 10 or c % 5 == 0 or c == len(root.best) - 1]
    for c in shown:
        print(f"  {c:3d} moves: {fmt(root.best[c])}")

    if a.moves_budget is not None:
        size = a.moves_budget
        print(f"\nBest repertoire with at most {size} memorized moves "
              f"(+{own_prefix} for the opening itself): {objective} {fmt(root.best[size])}.\n")
        name = f"{a.moves or 'Repertoire'}, best {objective} with {size} moves"
    else:
        size = next((c for c, v in enumerate(root.best) if v >= a.target - 1e-12), None)
        if size is None:
            print(f"\n{fmt(a.target)} isn't reachable within {a.max_moves} moves "
                  f"(best: {fmt(root.best[-1])}). Try more candidates, a larger --max-moves or --max-plies.")
            sys.exit(1)
        print(f"\nSmallest repertoire reaching {fmt(a.target)}: {size} memorized moves "
              f"(+{own_prefix} for the opening itself), {objective} {fmt(root.best[size])}.\n")
        name = f"{a.moves or 'Repertoire'}, smallest for {objective} {fmt(a.target)}"
    tree = solution(root, size)
    replies = {san: p for san, p, _ in root.replies} if not root.own else {}
    print_tree(tree, board, 0, replies)
    print(f"\n({count_own(tree, root.own)} of your moves in this tree.)")

    if a.out:
        study = {
            "format": "lirep-study",
            "version": 1,
            "name": name,
            "side": a.side,
            "explorerSettings": {"source": "lirep", "database": "lichess",
                                 "minRating": int(a.ratings.split(",")[0]), "speeds": a.speeds.split(",")},
            "moves": study_moves(prefix, tree),
        }
        with open(a.out, "w") as f:
            json.dump(study, f, indent=2)
            f.write("\n")
        print(f"\nWrote {a.out} (import it on Lirep's home page).")


def main() -> None:
    parser = common_parser(
        __doc__.split("\n\n")[0],
        "value",
        "Find the fewest memorized moves reaching this value: an expected score (0 to 1) or, "
        "with --objective evaluation, an expected evaluation in pawns (e.g. 0.5).",
    )
    parser.add_argument("--objective", choices=["score", "evaluation"], default=OBJECTIVE,
                        help=f"The explorer's expected score, or Stockfish's expected evaluation (default {OBJECTIVE}).")
    safety = parser.add_argument_group("safeguards against small samples")
    safety.add_argument("--min-games", type=int,
                        help=f"Games one of your played moves needs to be a candidate "
                             f"(default {MIN_GAMES}; {MIN_GAMES_EVALUATION} with --objective evaluation).")
    safety.add_argument("--prior-games", type=float,
                        help=f"Shrink scores toward 50%% by this many games (default {PRIOR_GAMES}; score only).")
    safety.add_argument("--no-safeguards", action="store_true",
                        help="Trust the explorer's scores as they are: no shrinkage, and any move played at least "
                             "once can be a candidate (unless --min-games or --prior-games are given).")
    engine = parser.add_argument_group("Stockfish (--objective evaluation)")
    engine.add_argument("--stockfish", default=STOCKFISH)
    engine.add_argument("--depth", type=int, default=DEPTH)
    engine.add_argument("--engine-candidates", type=int, default=ENGINE_CANDIDATES,
                        help="Stockfish's best moves added to your candidates.")
    engine.add_argument("--mate-cap", type=float, default=MATE_CAP, help="Cap evaluations at +/- this many pawns.")
    engine.add_argument("--cache", type=Path, default=CACHE)
    a = parser.parse_args()
    resolve_common(parser, a)
    evaluation = a.objective == "evaluation"
    if a.min_games is None:
        a.min_games = 1 if a.no_safeguards else (MIN_GAMES_EVALUATION if evaluation else MIN_GAMES)
    if a.prior_games is None:
        a.prior_games = 0 if a.no_safeguards or evaluation else PRIOR_GAMES

    if not evaluation:
        run(
            a,
            lambda explorer, side: Search(explorer, side, a),
            "expected score",
            lambda v: f"{v:.2%}",
            [f"safeguards: {a.min_games} games per candidate move, scores shrunk by {a.prior_games:g} games"
             + ("  (--no-safeguards)" if a.no_safeguards else "")],
        )
        return
    evaluator = Evaluator(a.stockfish, a.depth, a.engine_candidates, a.cache)
    try:
        run(
            a,
            lambda explorer, side: EvaluationSearch(explorer, side, a, evaluator),
            "expected evaluation",
            lambda v: f"{v:+.2f}",
            [f"stockfish:  depth {a.depth}, {a.engine_candidates} engine candidates per position, "
             f"evaluations capped at ±{a.mate_cap:g} pawns",
             f"safeguards: {a.min_games} games per played candidate move"],
        )
    finally:
        print(f"({evaluator.computed} new Stockfish evaluations; cache: {a.cache})")
        evaluator.close()


if __name__ == "__main__":
    main()
