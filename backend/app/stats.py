"""Win-probability estimation for a study, assuming perfect memorization.

See the "Stats tab" section of the project README for the full write-up of
what this computes and the assumptions it makes. In short: at every position
where it's the studied side's move, we assume they always play the tree's
main-line child (perfect memorization); at every position where it's the
opponent's move, we weight each of the tree's recorded replies by its real
frequency in the Opening Explorer, and treat anything the tree doesn't cover
as ending the studied side's preparation right there.
"""

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any, Callable, Literal

import chess
import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import jobs, store
from .config import DEFAULT_EXPLORER_SOURCE, HTTP_TIMEOUT
from .explorer import DEFAULT_SPEEDS, _resolve_min_rating, fetch_explorer_cached
from .studies import ExplorerSettings

logger = logging.getLogger(__name__)

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


def _outcome_probabilities(
    white: int, draws: int, black: int, side: Literal["white", "black"]
) -> tuple[float, float, float] | None:
    games = white + draws + black
    if games == 0:
        return None
    wins = white if side == "white" else black
    losses = black if side == "white" else white
    return wins / games, draws / games, losses / games


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
        source: Literal["lirep", "lichess"],
        database: Literal["lichess", "masters", "player"],
        min_rating: int | None,
        speeds: str,
        player: str | None = None,
        color: str | None = None,
        on_progress: Callable[[int], None] | None = None,
    ) -> None:
        self.client = client
        self.headers = headers
        self.source = source
        self.database = database
        self.min_rating = min_rating
        self.speeds = speeds
        self.player = player
        self.color = color
        self.on_progress = on_progress
        self.cache: dict[str, dict[str, Any]] = {}
        self.explorer_calls = 0
        self.nodes_evaluated = 0

    def _report_progress(self) -> None:
        if self.on_progress is not None:
            self.on_progress(self.explorer_calls)

    async def _fetch(self, fen: str) -> dict[str, Any]:
        """Fetches one position's Opening Explorer data — first this run's own
        in-memory cache (transpositions within one tree walk), then the
        persistent cross-study cache (see explorer.fetch_explorer_cached and
        explorer-cache.md), then a live Lichess request as a last resort. A
        429 is never retried: Lichess's own API docs say to wait "one minute"
        (sometimes longer) and reduce request frequency, not to retry within
        seconds — so a rate limit fails the whole calculation immediately
        with a clear message (raised by fetch_explorer_cached itself)."""
        if fen in self.cache:
            return self.cache[fen]
        self.explorer_calls += 1
        self._report_progress()
        data, _fetched_at = await fetch_explorer_cached(
            self.client, self.headers, fen, self.source, self.database, self.min_rating, self.speeds,
            self.player, self.color,
        )
        self.cache[fen] = data
        return data

    async def outcomes(
        self, tree: dict, node_id: int, side: Literal["white", "black"]
    ) -> tuple[float, float, float]:
        self.nodes_evaluated += 1
        board = chess.Board()
        for san in _sans_to(tree, node_id):
            board.push_san(san)

        outcome = board.outcome()
        if outcome is not None:
            if outcome.winner is None:
                return 0.0, 1.0, 0.0
            return (1.0, 0.0, 0.0) if outcome.winner == (side == "white") else (0.0, 0.0, 1.0)

        studied_side_to_move = (board.turn == chess.WHITE) == (side == "white")
        node = _get_node(tree, node_id)

        if studied_side_to_move:
            if not node["children"]:
                # The tree ends on our own move: no prepared continuation.
                # Fall back to the position's overall explorer stats as a
                # neutral estimate of "what happens from here on average".
                data = await self._fetch(board.fen())
                value = _outcome_probabilities(
                    data.get("white", 0), data.get("draws", 0), data.get("black", 0), side
                )
                return value if value is not None else (0.5, 0.0, 0.5)
            # Perfect memorization: always play the main-line (first) child.
            return await self.outcomes(tree, node["children"][0], side)

        # Opponent's move: weight each prepared reply by its real frequency;
        # anything the tree doesn't cover ends prep at that exact move.
        data = await self._fetch(board.fen())
        moves = data.get("moves", [])
        total_games = sum(m["white"] + m["draws"] + m["black"] for m in moves)
        if total_games == 0:
            return 0.5, 0.0, 0.5

        children_by_san = {_get_node(tree, child_id)["san"]: child_id for child_id in node["children"]}
        expected = [0.0, 0.0, 0.0]
        for move in moves:
            games = move["white"] + move["draws"] + move["black"]
            if games == 0:
                continue
            weight = games / total_games
            child_id = children_by_san.get(move["san"])
            if child_id is not None:
                value = await self.outcomes(tree, child_id, side)
            else:
                value = _outcome_probabilities(move["white"], move["draws"], move["black"], side)
                if value is None:
                    continue
            for index, probability in enumerate(value):
                expected[index] += weight * probability
        return expected[0], expected[1], expected[2]

    async def coverage(self, tree: dict, start_node_id: int, side: Literal["white", "black"]) -> list[float]:
        """Coverage[i] = probability a real game (sampled the same way as `score`)
        is still following a line inside the tree after move i+1 *from
        start_node_id* (both colors' (i+1)-th moves played since then — see
        starting-point.md if start_node_id isn't the tree's real root).
        Reuses this evaluator's explorer cache, so it's nearly free after
        `score` has already walked the same tree.
        """
        depth_mass: dict[int, float] = {}
        async def walk(node_id: int, depth: int, prob: float) -> None:
            depth_mass[depth] = depth_mass.get(depth, 0.0) + prob

            board = chess.Board()
            for san in _sans_to(tree, node_id):
                board.push_san(san)
            if board.outcome() is not None:
                return

            studied_side_to_move = (board.turn == chess.WHITE) == (side == "white")
            node = _get_node(tree, node_id)

            if studied_side_to_move:
                if not node["children"]:
                    return
                await walk(node["children"][0], depth + 1, prob)
                return

            data = await self._fetch(board.fen())
            moves = data.get("moves", [])
            total_games = sum(m["white"] + m["draws"] + m["black"] for m in moves)
            if total_games == 0:
                return
            children_by_san = {_get_node(tree, child_id)["san"]: child_id for child_id in node["children"]}
            for move in moves:
                games = move["white"] + move["draws"] + move["black"]
                if games == 0:
                    continue
                weight = games / total_games
                child_id = children_by_san.get(move["san"])
                if child_id is not None:
                    await walk(child_id, depth + 1, prob * weight)
                # else: this probability mass has left the book — not tracked further.

        await walk(start_node_id, 0, 1.0)

        # Which plies represent "right after the opponent's move" depends on
        # who moves first *from start_node_id* — not always even plies. That
        # was only ever true because start_node_id used to always be the
        # tree's real root in a White study (White moves first there, so the
        # opponent's Nth move always lands on an even ply). A custom starting
        # point can have the opponent to move first instead (see
        # starting-point.md) — and so can a Black study even at the real
        # root, since White moves first there regardless of which side is
        # being studied. Sampling fixed-parity "even plies" in that case
        # would silently report the *studied side's* move-completion points
        # instead of the opponent's.
        start_board = chess.Board()
        for san in _sans_to(tree, start_node_id):
            start_board.push_san(san)
        start_side_to_move = (start_board.turn == chess.WHITE) == (side == "white")
        first_ply = 2 if start_side_to_move else 1

        max_ply = max(depth_mass.keys(), default=0)
        return [depth_mass.get(ply, 0.0) for ply in range(first_ply, max_ply + 1, 2)]


class RecalculateIn(BaseModel):
    explorerSettings: ExplorerSettings | None = None


class ExpectedEvalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evalCp: float = Field(strict=True, ge=-100_000, le=100_000, allow_inf_nan=False)
    evalMisses: int = Field(strict=True, ge=0)
    explorerSettings: ExplorerSettings | None = None


async def _resolve_explorer_settings(
    job_id: str, owner: str, study: dict, headers: dict[str, str]
) -> tuple[
    Literal["lirep", "lichess"], Literal["lichess", "masters", "player"], int | None, str, str | None, str | None
] | None:
    """Resolve the saved explorer settings for the win-probability job:
    (source, database, min_rating, speeds, player, color)."""
    explorer_settings = study["explorerSettings"]
    source: Literal["lirep", "lichess"] = explorer_settings.get("source", DEFAULT_EXPLORER_SOURCE)
    database: Literal["lichess", "masters", "player"] = explorer_settings.get("database", "lichess")
    speeds = ",".join(explorer_settings.get("speeds") or DEFAULT_SPEEDS)

    if source == "lirep" and database == "masters":
        jobs.fail(job_id, "Masters data is only available from Lichess")
        return None

    player: str | None = None
    color: str | None = None
    if database == "player":
        # One player's games as the study's side; defaults to the owner.
        source = "lichess"
        player = explorer_settings.get("player") or owner
        color = study["side"]

    min_rating = explorer_settings.get("minRating")
    if database == "lichess" and min_rating is None:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                min_rating = await _resolve_min_rating(client, headers, owner)
            except HTTPException as exc:
                jobs.fail(job_id, str(exc.detail))
                return None
    return source, database, min_rating, speeds, player, color


def _resolve_start_node_id(study: dict) -> int:
    """The node every calculation should treat as move one — a study's
    `startNodeId` if it's set and still exists in the current tree, else the
    tree's real root. See starting-point.md: a stale id (its subtree got
    deleted since it was set) degrades to the default rather than erroring,
    the same instinct as every other fallback in this app."""
    start_node_id = study.get("startNodeId")
    if start_node_id is not None and str(start_node_id) in study["tree"]["nodes"]:
        return start_node_id
    return study["tree"]["rootId"]


async def _run_win_probability_job(job_id: str, owner: str, study_id: int, token: str) -> None:
    """Win probability + coverage only, purely Explorer-derived."""
    try:
        study = store.get_study(owner, study_id)
        if not study:
            jobs.fail(job_id, "study not found")
            return
        headers = {"Authorization": f"Bearer {token}"}
        start_node_id = _resolve_start_node_id(study)

        resolved = await _resolve_explorer_settings(job_id, owner, study, headers)
        if resolved is None:
            return
        source, database, min_rating, speeds, player, color = resolved

        async with httpx.AsyncClient(timeout=30.0) as client:
            evaluator = _Evaluator(
                client, headers, source, database, min_rating, speeds, player, color,
                on_progress=lambda n: jobs.set_progress(job_id, n),
            )
            win_rate, draw_probability, loss_probability = await evaluator.outcomes(
                study["tree"], start_node_id, study["side"]
            )
            win_probability = win_rate + 0.5 * draw_probability
            coverage = await evaluator.coverage(study["tree"], start_node_id, study["side"])

        explorer_settings = study["explorerSettings"]
        updated = store.merge_study_stats(
            owner,
            study_id,
            {
                "winProbability": win_probability,
                "winRate": win_rate,
                "lossProbability": loss_probability,
                "coverage": coverage,
                "winProbabilityCalculatedAt": datetime.now(UTC).isoformat(),
                "source": source,
                "database": database,
                "minRating": min_rating,
                "player": player,
                "speeds": explorer_settings.get("speeds", list(DEFAULT_SPEEDS)),
                "nodesEvaluated": evaluator.nodes_evaluated,
                "explorerCalls": evaluator.explorer_calls,
            },
        )
        if updated is None:
            jobs.fail(job_id, "study not found")
            return
        jobs.finish(job_id, updated)
    except HTTPException as exc:
        logger.warning("win-probability job %s failed: %s", job_id, exc.detail)
        jobs.fail(job_id, str(exc.detail))
    except Exception as exc:  # noqa: BLE001 - reported to the client via the job, not raised
        logger.exception("win-probability job %s failed", job_id)
        jobs.fail(job_id, str(exc))


def _start_job_endpoint_precheck(request: Request, study_id: int, owner: str) -> tuple[dict, str]:
    study = store.get_study(owner, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="not found")
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")
    return study, token


@router.post("/api/studies/{study_id}/win-probability")
async def start_win_probability_job(
    study_id: int, request: Request, payload: RecalculateIn = RecalculateIn()
) -> dict:
    owner = _require_owner(request)
    _study, token = _start_job_endpoint_precheck(request, study_id, owner)

    # The stats page lets you tweak explorer settings before recalculating;
    # when it does, that becomes the study's new settings (not a one-off).
    if payload.explorerSettings is not None:
        updated_study = store.update_explorer_settings(owner, study_id, payload.explorerSettings.model_dump())
        assert updated_study is not None

    # Indeterminate total: how many explorer requests this run will need isn't
    # known until the tree walk is underway (it depends on branching factors
    # reported live by the explorer). The frontend shows its own estimate.
    job_id = jobs.create_job(owner, total=None)
    asyncio.create_task(_run_win_probability_job(job_id, owner, study_id, token))
    return {"jobId": job_id}


@router.post("/api/studies/{study_id}/expected-eval")
def save_expected_eval(study_id: int, request: Request, payload: ExpectedEvalIn) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="not found")
    settings = payload.explorerSettings.model_dump() if payload.explorerSettings is not None else study["explorerSettings"]
    updated = store.merge_study_stats(
        owner,
        study_id,
        {
            "evalCp": payload.evalCp,
            "evalMisses": payload.evalMisses,
            "evalCalculatedAt": datetime.now(UTC).isoformat(),
            "evalOrigin": "local",
            "source": settings["source"],
            "database": settings["database"],
            "minRating": settings["minRating"],
            "speeds": settings["speeds"],
        },
        explorer_settings=settings if payload.explorerSettings is not None else None,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    return updated


@router.get("/api/jobs/{job_id}")
async def get_job_status(job_id: str, request: Request) -> dict:
    owner = _require_owner(request)
    job = jobs.get_job(owner, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return {
        "status": job["status"],
        "done": job["done"],
        "total": job["total"],
        "result": job["result"],
        "error": job["error"],
    }
