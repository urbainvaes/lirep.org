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
from pydantic import BaseModel

from . import jobs, store
from .config import HTTP_TIMEOUT
from .explorer import DEFAULT_SPEEDS, _resolve_min_rating, fetch_explorer_cached
from .studies import ExplorerSettings

CLOUD_EVAL_URL = "https://lichess.org/api/cloud-eval"

# A forced mate is capped at this many "centipawns" (rather than infinity) so
# it can be averaged together with ordinary evals; the exact value doesn't
# matter much since it's always overwhelmingly larger than any real eval.
MATE_SCORE_CP = 100_000.0

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
        on_progress: Callable[[int], None] | None = None,
    ) -> None:
        self.client = client
        self.headers = headers
        self.database = database
        self.min_rating = min_rating
        self.speeds = speeds
        self.on_progress = on_progress
        self.cache: dict[str, dict[str, Any]] = {}
        self.eval_cache: dict[str, float | None] = {}
        self.explorer_calls = 0
        self.eval_calls = 0
        self.eval_misses = 0
        self.nodes_evaluated = 0

    def _report_progress(self) -> None:
        if self.on_progress is not None:
            self.on_progress(self.explorer_calls + self.eval_calls)

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
            self.client, self.headers, fen, self.database, self.min_rating, self.speeds
        )
        self.cache[fen] = data
        return data

    async def _fetch_eval(self, fen: str) -> float | None:
        """Centipawns from White's point of view, or None if lichess has no
        cached eval for this position (its "sparse coverage" — a genuine 404
        just means nobody's analyzed this exact position yet, not an error).

        A 404 is the only outcome cached as a permanent miss: since "Calculate
        evaluations" persists this result long-term, a transient failure
        (rate limiting, a server hiccup) must never be mistaken for "no data"
        and baked into the cache — so anything other than 200/404 is raised
        rather than silently recorded as a miss.

        A 429 specifically is never retried in a loop: Lichess's own guidance
        is to back off a full minute after one, and hammering it again a few
        seconds later (as a short retry loop would) risks an escalating ban
        rather than helping — so it fails the whole job immediately with a
        clear message instead. A plain server hiccup (5xx) gets a couple of
        short retries, since those usually clear on their own.

        Persisted globally by FEN (store.cloud_eval_cache), not just this
        run's in-memory cache — this is the path every opponent move that
        exists in the Explorer data but isn't in your tree goes through
        (there can easily be over a hundred of these per study), and without
        persistence *every* "Calculate scores" run re-fetches all of them
        from scratch, every time, forever. It also means a run that fails
        partway through a rate limit doesn't lose the positions it already
        successfully fetched — a retry picks up where it left off instead of
        starting over.
        """
        if fen in self.eval_cache:
            return self.eval_cache[fen]

        persisted = store.get_cloud_eval_cache(fen)
        if persisted is not None:
            self.eval_cache[fen] = persisted["cp"]
            return persisted["cp"]

        self.eval_calls += 1
        self._report_progress()
        resp = None
        for attempt in range(3):
            resp = await self.client.get(CLOUD_EVAL_URL, params={"fen": fen, "multiPv": 1})
            if resp.status_code == 429:
                raise HTTPException(
                    status_code=429,
                    detail="rate limited by lichess (429) — please wait a minute before trying again",
                )
            if resp.status_code in (200, 404):
                break
            if attempt < 2:
                await asyncio.sleep(1.5 * (attempt + 1))
        assert resp is not None
        fetched_at = datetime.now(UTC).isoformat()
        if resp.status_code == 404:
            self.eval_misses += 1
            self.eval_cache[fen] = None
            store.set_cloud_eval_cache(fen, None, fetched_at)
            return None
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"cloud eval fetch failed ({resp.status_code})")
        pv = resp.json()["pvs"][0]
        if "mate" in pv:
            mate = pv["mate"]
            cp = (MATE_SCORE_CP - abs(mate)) * (1.0 if mate > 0 else -1.0)
        else:
            cp = float(pv["cp"])
        self.eval_cache[fen] = cp
        store.set_cloud_eval_cache(fen, cp, fetched_at)
        return cp

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

    async def coverage(self, tree: dict, side: Literal["white", "black"]) -> list[float]:
        """Coverage[i] = probability a real game (sampled the same way as `score`)
        is still following a line inside the tree after move i+1 (both colors'
        (i+1)-th moves played). Reuses this evaluator's explorer cache, so it's
        nearly free after `score` has already walked the same tree.
        """
        depth_mass: dict[int, float] = {}

        async def walk(node_id: int, depth: int, prob: float) -> None:
            if prob < 1e-4:
                return
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

        await walk(tree["rootId"], 0, 1.0)

        max_ply = max(depth_mass.keys(), default=0)
        return [depth_mass.get(ply, 0.0) for ply in range(2, max_ply + 1, 2)]

    async def _eval_at(self, node_id: int, fen: str, stored_evals: dict[str, float | None]) -> float | None:
        """Centipawns (White's POV) for a position that's a node in the tree:
        reuse the value from a prior "Calculate evaluations" run if there is
        one (a node's eval never changes, so it's cheap to reuse across many
        stats recalculations at different Opening Explorer settings), else
        fetch it live."""
        key = str(node_id)
        if key in stored_evals:
            return stored_evals[key]
        return await self._fetch_eval(fen)

    async def eval_score(
        self,
        tree: dict,
        node_id: int,
        side: Literal["white", "black"],
        stored_evals: dict[str, float | None],
    ) -> float:
        """Expected Stockfish eval (centipawns, from the studied side's point
        of view) at the frontier of preparation — the `eeval` objective from
        §2 of the README, restricted to this study's tree. Same backward
        induction as `score`, but the leaf value is a real engine evaluation
        (via lichess's free Cloud Eval API, or `stored_evals` when a
        "Calculate evaluations" run already has it) instead of a win/draw/loss
        score, fetched wherever preparation ends: a leaf on your own move, a
        position the explorer has no games for, or a covered-tree exit where
        the opponent played something you didn't prepare for.
        """
        board = chess.Board()
        for san in _sans_to(tree, node_id):
            board.push_san(san)

        outcome = board.outcome()
        if outcome is not None:
            if outcome.winner is None:
                return 0.0
            return MATE_SCORE_CP if outcome.winner == (side == "white") else -MATE_SCORE_CP

        studied_side_to_move = (board.turn == chess.WHITE) == (side == "white")
        node = _get_node(tree, node_id)
        sign = 1.0 if side == "white" else -1.0

        if studied_side_to_move:
            if not node["children"]:
                cp = await self._eval_at(node_id, board.fen(), stored_evals)
                return (cp or 0.0) * sign
            return await self.eval_score(tree, node["children"][0], side, stored_evals)

        data = await self._fetch(board.fen())
        moves = data.get("moves", [])
        total_games = sum(m["white"] + m["draws"] + m["black"] for m in moves)
        if total_games == 0:
            cp = await self._eval_at(node_id, board.fen(), stored_evals)
            return (cp or 0.0) * sign

        children_by_san = {_get_node(tree, child_id)["san"]: child_id for child_id in node["children"]}
        expected = 0.0
        for move in moves:
            games = move["white"] + move["draws"] + move["black"]
            if games == 0:
                continue
            weight = games / total_games
            child_id = children_by_san.get(move["san"])
            if child_id is not None:
                value = await self.eval_score(tree, child_id, side, stored_evals)
            else:
                # Not a node in our tree: no stored eval possible, always fetch live.
                child_board = board.copy()
                child_board.push_san(move["san"])
                cp = await self._fetch_eval(child_board.fen())
                value = (cp or 0.0) * sign
            expected += weight * value
        return expected


class RecalculateIn(BaseModel):
    explorerSettings: ExplorerSettings | None = None


class EvalsIn(BaseModel):
    byNode: dict[str, float | None]
    # Off-tree opponent continuations, evaluated locally too (the browser
    # discovers these from the same cached Explorer data eval_score itself
    # would otherwise walk). Global, not study-scoped, so it goes straight
    # into store.cloud_eval_cache rather than this study's own `evals` row —
    # see explorer-cache.md's "biggest hidden request" section.
    byFen: dict[str, float | None] = {}
    misses: int = 0


@router.post("/api/studies/{study_id}/evals")
async def save_evals(study_id: int, request: Request, payload: EvalsIn) -> dict:
    """Stores per-node Stockfish evals computed **in the browser**, using the
    same Stockfish WASM engine already used for live analysis in the Study
    editor (see `frontend/src/engine.ts`) — not Lichess's Cloud Eval API. That
    keeps this entirely local: no server-side engine, no external rate limit,
    and it works for every position, not just ones Lichess happens to have
    analyzed already.

    This is a synchronous save, not a job: the actual (slow, sequential)
    engine analysis already happened client-side, with its own progress bar
    driven directly by the browser loop — there's nothing left to poll here.
    These evals don't depend on the Opening Explorer at all (a position's
    eval is the same regardless of database/rating/speed settings), so
    they're cached here rather than recomputed on every stats recalculation
    (see `eval_score` and its `stored_evals` argument).
    """
    owner = _require_owner(request)
    fetched_at = datetime.now(UTC).isoformat()

    for fen, cp in payload.byFen.items():
        store.set_cloud_eval_cache(fen, cp, fetched_at)

    evals = {
        "byNode": payload.byNode,
        "calculatedAt": fetched_at,
        "misses": payload.misses,
        # byFen itself isn't stored here (it's global, not this study's — see
        # above), but its *count* is, purely so the UI can report a total
        # ("N positions evaluated") that actually matches what the progress
        # bar counted while getting here, instead of only counting byNode.
        "offTreeCount": len(payload.byFen),
    }
    updated = store.set_study_evals(owner, study_id, evals)
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    return updated


class EvalCacheLookupIn(BaseModel):
    fens: list[str]


@router.post("/api/eval-cache/lookup")
async def lookup_eval_cache(request: Request, payload: EvalCacheLookupIn) -> dict:
    """Bulk read from the shared, global, FEN-keyed position-eval cache
    (store.cloud_eval_cache) — deliberately generic and not study-scoped, so
    anything that wants to avoid recomputing or refetching a position's eval
    can reuse this, not just today's one caller. Currently used by
    "Update evaluations" (`stat.ts`) to skip re-evaluating an off-tree
    position it (or another study, or the server-side Cloud Eval fallback)
    has already covered. A FEN missing from the response means "not cached
    anywhere yet" — the caller decides what to do about that (here: evaluate
    it locally). See explorer-cache.md.
    """
    _require_owner(request)
    evals: dict[str, float] = {}
    for fen in payload.fens:
        cached = store.get_cloud_eval_cache(fen)
        # A stored miss (cp is None — Cloud Eval had nothing) is treated the
        # same as "not cached at all": local Stockfish can virtually always
        # produce a real value where Cloud Eval couldn't, so a caller should
        # still evaluate it rather than accept a permanent gap.
        if cached is not None and cached["cp"] is not None:
            evals[fen] = cached["cp"]
    return {"evals": evals}


async def _resolve_explorer_settings(
    job_id: str, owner: str, study: dict, headers: dict[str, str]
) -> tuple[Literal["lichess", "masters"], int | None, str] | None:
    """(database, min_rating, speeds) for this study's saved explorer
    settings, resolving "my current rating" if needed. Shared by both the
    win-probability and expected-eval jobs, which otherwise duplicated this
    exact setup. Fails the job and returns None on error, so a caller can
    just `if result is None: return`."""
    explorer_settings = study["explorerSettings"]
    database: Literal["lichess", "masters"] = explorer_settings.get("database", "lichess")
    speeds = ",".join(explorer_settings.get("speeds") or DEFAULT_SPEEDS)

    min_rating = explorer_settings.get("minRating")
    if database == "lichess" and min_rating is None:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                min_rating = await _resolve_min_rating(client, headers, owner)
            except HTTPException as exc:
                jobs.fail(job_id, str(exc.detail))
                return None
    return database, min_rating, speeds


async def _run_win_probability_job(job_id: str, owner: str, study_id: int, token: str) -> None:
    """Win probability + coverage only — purely Explorer-derived, never
    touches Stockfish/Cloud Eval (see stats.md's guarantee at the top of
    that doc). Independent of "Update expected evaluation": either can run
    without the other ever having run."""
    try:
        study = store.get_study(owner, study_id)
        if not study:
            jobs.fail(job_id, "study not found")
            return
        headers = {"Authorization": f"Bearer {token}"}

        resolved = await _resolve_explorer_settings(job_id, owner, study, headers)
        if resolved is None:
            return
        database, min_rating, speeds = resolved

        async with httpx.AsyncClient(timeout=30.0) as client:
            evaluator = _Evaluator(
                client, headers, database, min_rating, speeds, on_progress=lambda n: jobs.set_progress(job_id, n)
            )
            win_probability = await evaluator.score(study["tree"], study["tree"]["rootId"], study["side"])
            coverage = await evaluator.coverage(study["tree"], study["side"])

        explorer_settings = study["explorerSettings"]
        stats = dict(study.get("stats") or {})
        stats.update(
            {
                "winProbability": win_probability,
                "coverage": coverage,
                "winProbabilityCalculatedAt": datetime.now(UTC).isoformat(),
                "database": database,
                "minRating": min_rating,
                "speeds": explorer_settings.get("speeds", list(DEFAULT_SPEEDS)),
                "nodesEvaluated": evaluator.nodes_evaluated,
                "explorerCalls": evaluator.explorer_calls,
            }
        )
        updated = store.set_study_stats(owner, study_id, stats)
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


async def _run_expected_eval_job(job_id: str, owner: str, study_id: int, token: str) -> None:
    """Expected evaluation only. Reuses whatever "Update evaluations" already
    computed (study['evals'].byNode for tree positions, the global
    cloud_eval_cache for off-tree ones); only ever calls Cloud Eval live for a
    position neither of those covers yet."""
    try:
        study = store.get_study(owner, study_id)
        if not study:
            jobs.fail(job_id, "study not found")
            return
        headers = {"Authorization": f"Bearer {token}"}

        resolved = await _resolve_explorer_settings(job_id, owner, study, headers)
        if resolved is None:
            return
        database, min_rating, speeds = resolved

        stored_evals: dict[str, float | None] = (study.get("evals") or {}).get("byNode", {})

        async with httpx.AsyncClient(timeout=30.0) as client:
            evaluator = _Evaluator(
                client, headers, database, min_rating, speeds, on_progress=lambda n: jobs.set_progress(job_id, n)
            )
            eval_cp = await evaluator.eval_score(study["tree"], study["tree"]["rootId"], study["side"], stored_evals)

        explorer_settings = study["explorerSettings"]
        stats = dict(study.get("stats") or {})
        stats.update(
            {
                "evalCp": eval_cp,
                "evalMisses": evaluator.eval_misses,
                "evalCalculatedAt": datetime.now(UTC).isoformat(),
                "database": database,
                "minRating": min_rating,
                "speeds": explorer_settings.get("speeds", list(DEFAULT_SPEEDS)),
            }
        )
        updated = store.set_study_stats(owner, study_id, stats)
        if updated is None:
            jobs.fail(job_id, "study not found")
            return
        jobs.finish(job_id, updated)
    except HTTPException as exc:
        logger.warning("expected-eval job %s failed: %s", job_id, exc.detail)
        jobs.fail(job_id, str(exc.detail))
    except Exception as exc:  # noqa: BLE001 - reported to the client via the job, not raised
        logger.exception("expected-eval job %s failed", job_id)
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
async def start_expected_eval_job(study_id: int, request: Request, payload: RecalculateIn = RecalculateIn()) -> dict:
    owner = _require_owner(request)
    _study, token = _start_job_endpoint_precheck(request, study_id, owner)

    if payload.explorerSettings is not None:
        updated_study = store.update_explorer_settings(owner, study_id, payload.explorerSettings.model_dump())
        assert updated_study is not None

    job_id = jobs.create_job(owner, total=None)
    asyncio.create_task(_run_expected_eval_job(job_id, owner, study_id, token))
    return {"jobId": job_id}


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
