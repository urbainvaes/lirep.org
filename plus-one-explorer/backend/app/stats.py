"""Win-probability estimation for a study, assuming perfect memorization.

See the "Stats tab" section of the project README for the full write-up of
what this computes and the assumptions it makes. In short: at every position
where it's the studied side's move, we assume they always play the tree's
main-line child (perfect memorization); at every position where it's the
opponent's move, we weight each of the tree's recorded replies by its real
frequency in the Opening Explorer, and treat anything the tree doesn't cover
as ending the studied side's preparation right there.
"""

from datetime import UTC, datetime
from typing import Any, Literal

import chess
import httpx
from fastapi import APIRouter, HTTPException, Request

from . import store
from .auth import ACCOUNT_URL
from .explorer import (
    DEFAULT_SPEEDS,
    LICHESS_EXPLORER_URL,
    MASTERS_EXPLORER_URL,
    _bucket_for,
    _ratings_from,
    _reference_rating,
)

router = APIRouter()


def _require_owner(request: Request) -> str:
    username = request.session.get("username")
    if not username:
        raise HTTPException(status_code=401, detail="not authenticated")
    return username


def _get_node(tree: dict, node_id: int) -> dict:
    return tree["nodes"][str(node_id)]


def _sans_to(tree: dict, node_id: int) -> list[str]:
    sans: list[str] = []
    node = _get_node(tree, node_id)
    while node["parentId"] is not None:
        sans.append(node["san"])
        node = _get_node(tree, node["parentId"])
    sans.reverse()
    return sans


def _score_from_wdl(white: int, draws: int, black: int, side: Literal["white", "black"]) -> float | None:
    games = white + draws + black
    if games == 0:
        return None
    wins = white if side == "white" else black
    return (wins + 0.5 * draws) / games


class _Evaluator:
    """Walks a study's tree once, calling the Opening Explorer as needed.

    Explorer responses are cached by FEN for the lifetime of one
    recalculation, since a hand-built tree can transpose (different move
    orders reaching the same position) even though it can't literally repeat
    a node.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        database: Literal["lichess", "masters"],
        min_rating: int | None,
        speeds: str,
    ) -> None:
        self.client = client
        self.headers = headers
        self.database = database
        self.min_rating = min_rating
        self.speeds = speeds
        self.cache: dict[str, dict[str, Any]] = {}
        self.explorer_calls = 0
        self.nodes_evaluated = 0

    async def _fetch(self, fen: str) -> dict[str, Any]:
        if fen in self.cache:
            return self.cache[fen]
        self.explorer_calls += 1
        if self.database == "masters":
            resp = await self.client.get(MASTERS_EXPLORER_URL, params={"fen": fen}, headers=self.headers)
        else:
            assert self.min_rating is not None
            resp = await self.client.get(
                LICHESS_EXPLORER_URL,
                params={"fen": fen, "speeds": self.speeds, "ratings": _ratings_from(self.min_rating)},
                headers=self.headers,
            )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail="lichess explorer fetch failed")
        data = resp.json()
        self.cache[fen] = data
        return data

    async def score(self, tree: dict, node_id: int, side: Literal["white", "black"]) -> float:
        self.nodes_evaluated += 1
        board = chess.Board()
        for san in _sans_to(tree, node_id):
            board.push_san(san)

        outcome = board.outcome()
        if outcome is not None:
            if outcome.winner is None:
                return 0.5
            return 1.0 if outcome.winner == (side == "white") else 0.0

        studied_side_to_move = (board.turn == chess.WHITE) == (side == "white")
        node = _get_node(tree, node_id)

        if studied_side_to_move:
            if not node["children"]:
                # The tree ends on our own move: no prepared continuation.
                # Fall back to the position's overall explorer stats as a
                # neutral estimate of "what happens from here on average".
                data = await self._fetch(board.fen())
                value = _score_from_wdl(data.get("white", 0), data.get("draws", 0), data.get("black", 0), side)
                return value if value is not None else 0.5
            # Perfect memorization: always play the main-line (first) child.
            return await self.score(tree, node["children"][0], side)

        # Opponent's move: weight each prepared reply by its real frequency;
        # anything the tree doesn't cover ends prep at that exact move.
        data = await self._fetch(board.fen())
        moves = data.get("moves", [])
        total_games = sum(m["white"] + m["draws"] + m["black"] for m in moves)
        if total_games == 0:
            return 0.5

        children_by_san = {_get_node(tree, child_id)["san"]: child_id for child_id in node["children"]}
        expected = 0.0
        for move in moves:
            games = move["white"] + move["draws"] + move["black"]
            if games == 0:
                continue
            weight = games / total_games
            child_id = children_by_san.get(move["san"])
            if child_id is not None:
                value = await self.score(tree, child_id, side)
            else:
                value = _score_from_wdl(move["white"], move["draws"], move["black"], side)
                if value is None:
                    continue
            expected += weight * value
        return expected


@router.post("/api/studies/{study_id}/stats")
async def recalculate_stats(study_id: int, request: Request) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="not found")

    token = request.session.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")
    headers = {"Authorization": f"Bearer {token}"}

    explorer_settings = study["explorerSettings"]
    database: Literal["lichess", "masters"] = explorer_settings.get("database", "lichess")
    speeds = ",".join(explorer_settings.get("speeds") or DEFAULT_SPEEDS)

    min_rating = explorer_settings.get("minRating")
    if database == "lichess" and min_rating is None:
        async with httpx.AsyncClient() as client:
            account_resp = await client.get(ACCOUNT_URL, headers=headers)
        if account_resp.status_code != 200:
            raise HTTPException(status_code=502, detail="lichess account fetch failed")
        min_rating = _bucket_for(_reference_rating(account_resp.json().get("perfs", {})))

    async with httpx.AsyncClient(timeout=20.0) as client:
        evaluator = _Evaluator(client, headers, database, min_rating, speeds)
        win_probability = await evaluator.score(study["tree"], study["tree"]["rootId"], study["side"])

    stats = {
        "winProbability": win_probability,
        "calculatedAt": datetime.now(UTC).isoformat(),
        "database": database,
        "minRating": min_rating,
        "nodesEvaluated": evaluator.nodes_evaluated,
        "explorerCalls": evaluator.explorer_calls,
    }
    updated = store.set_study_stats(owner, study_id, stats)
    assert updated is not None
    return updated
