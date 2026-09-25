import asyncio
from datetime import UTC, datetime
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request

from . import store
from .auth import ACCOUNT_URL
from .config import DEFAULT_EXPLORER_SOURCE, HTTP_TIMEOUT, LOCAL_LICHESS_EXPLORER_URL

LICHESS_EXPLORER_URL = "https://explorer.lichess.org/lichess"
MASTERS_EXPLORER_URL = "https://explorer.lichess.org/masters"

# All speeds selectable in the UI, and what's included when a study hasn't
# customized this yet. Ultra-bullet and correspondence are left off the
# picker entirely (too noisy / too rare to be worth the extra UI clutter).
ALL_SPEEDS = ("bullet", "blitz", "rapid", "classical")
DEFAULT_SPEEDS = ("blitz", "rapid", "classical")

# The explorer's own rating-bucket boundaries (each bucket covers itself up
# to the next one, and the last is open-ended).
RATING_BUCKETS = (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500)

# Preference order for picking "the profile's rating" when several time
# controls are available.
REFERENCE_SPEEDS = ("rapid", "blitz", "classical")
DEFAULT_REFERENCE_RATING = 1500

router = APIRouter()
_inflight_explorer: dict[str, asyncio.Task[tuple[dict, str]]] = {}


def _reference_rating(perfs: dict) -> int:
    for speed in REFERENCE_SPEEDS:
        rating = perfs.get(speed, {}).get("rating")
        if rating:
            return rating
    return DEFAULT_REFERENCE_RATING


def _bucket_for(rating: int) -> int:
    return max((b for b in RATING_BUCKETS if b <= rating), default=RATING_BUCKETS[0])


def _ratings_from(min_rating: int) -> str:
    return ",".join(str(b) for b in RATING_BUCKETS if b >= min_rating)


async def _resolve_min_rating(client: httpx.AsyncClient, headers: dict[str, str], username: str | None) -> int:
    """Resolves "My current rating" (the auto minRating mode) to a bucket.

    Cached per-user in the database (store.rating_cache /
    RATING_CACHE_TTL_SECONDS) — persisted, not in-memory, specifically so a
    backend restart can't wipe a still-fresh resolution and force a live
    account call it didn't actually need. Two benefits:

    1. Fewer account calls: a whole editing session no longer means one
       Lichess account request per position visited, just one per TTL window.
    2. Graceful degradation: if a *refresh* attempt (past the TTL) gets rate
       limited, this falls back to the stale cached bucket rather than
       failing the request outright — a rating bucket that's an hour or two
       stale is virtually always still correct, and "probably still right"
       beats "definitely fails" when the alternative is refusing to serve
       Explorer data that's sitting right there in cache. See
       explorer-cache.md.
    """
    if username:
        fresh = store.get_rating_cache(username)
        if fresh is not None:
            return fresh

    account_resp = await client.get(ACCOUNT_URL, headers=headers)
    if account_resp.status_code != 200:
        stale = store.get_rating_cache(username, allow_stale=True) if username else None
        if stale is not None:
            return stale  # stale beats failing a request that might be a cache hit anyway
        raise HTTPException(status_code=502, detail="lichess account fetch failed")

    bucket = _bucket_for(_reference_rating(account_resp.json().get("perfs", {})))
    if username:
        store.set_rating_cache(username, bucket, datetime.now(UTC).isoformat())
    return bucket


def _shape_moves(data: dict) -> list[dict]:
    return [
        {
            "san": move["san"],
            "white": move["white"],
            "draws": move["draws"],
            "black": move["black"],
            "averageRating": move.get("averageRating"),
        }
        for move in data.get("moves", [])
    ]


def _shape_response(
    source: str, database: str, min_rating: int | None, data: dict, fetched_at: str
) -> dict:
    opening = data.get("opening")
    return {
        "database": database,
        "source": source,
        "minRating": min_rating,
        "opening": opening["name"] if opening else None,
        "totals": {
            "white": data.get("white", 0),
            "draws": data.get("draws", 0),
            "black": data.get("black", 0),
        },
        "moves": _shape_moves(data),
        "fetchedAt": fetched_at,
    }


async def fetch_explorer(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    fen: str,
    source: Literal["lirep", "lichess"],
    database: str,
    min_rating: int | None,
    speeds: str,
) -> dict:
    """Raw, uncached fetch — see fetch_explorer_cached below, which every
    caller (the live /api/explorer endpoint and stats.py's recalculation)
    should use instead."""
    if source == "lirep":
        if not LOCAL_LICHESS_EXPLORER_URL:
            raise HTTPException(status_code=503, detail="Lirep Explorer is not configured")
        if database == "masters":
            raise HTTPException(status_code=400, detail="Masters is only available from Lichess")
        assert min_rating is not None
        resp = await client.get(
            f"{LOCAL_LICHESS_EXPLORER_URL}/lichess",
            params={"fen": fen, "speeds": speeds, "ratings": _ratings_from(min_rating)},
        )
    elif database == "masters":
        resp = await client.get(MASTERS_EXPLORER_URL, params={"fen": fen}, headers=headers)
    else:
        assert min_rating is not None
        resp = await client.get(
            LICHESS_EXPLORER_URL,
            params={"fen": fen, "speeds": speeds, "ratings": _ratings_from(min_rating)},
            headers=headers,
        )
    if resp.status_code == 429:
        raise HTTPException(
            status_code=429,
            detail="rate limited by lichess's opening explorer (429) — please wait a minute before trying again",
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"lichess explorer fetch failed ({resp.status_code})")
    return resp.json()


async def fetch_explorer_cached(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    fen: str,
    source: Literal["lirep", "lichess"],
    database: str,
    min_rating: int | None,
    speeds: str,
) -> tuple[dict, str]:
    """(data, fetchedAt ISO timestamp). Persisted across studies *and* users:
    a position's real-world move frequencies don't depend on who's asking, so
    the cache key is the provider plus its exact query (see
    store.EXPLORER_CACHE_TTL_SECONDS for the staleness window). This is what
    keeps repeated "Calculate scores" runs, and different studies that share
    early-game positions, from re-fetching the same data over and over — see
    explorer-cache.md for the full writeup and why this matters for staying
    under Lichess's (undocumented) rate limit.
    """
    ratings = _ratings_from(min_rating) if database != "masters" else ""
    cache_key = f"{source}|{database}|{ratings}|{speeds}|{fen}"
    cached = store.get_explorer_cache(cache_key)
    if cached is not None:
        return cached["response"], cached["fetchedAt"]

    pending = _inflight_explorer.get(cache_key)
    if pending is None:
        async def fetch_and_cache() -> tuple[dict, str]:
            try:
                data = await fetch_explorer(client, headers, fen, source, database, min_rating, speeds)
            except RuntimeError:
                if not client.is_closed:
                    raise
                # The initiating request can disconnect while another caller
                # still awaits its fetch; retry with an independently owned client.
                async with httpx.AsyncClient(timeout=client.timeout) as replacement:
                    data = await fetch_explorer(replacement, headers, fen, source, database, min_rating, speeds)
            except httpx.RequestError as exc:
                # A genuine connection failure (host unreachable, timed out) —
                # not the client-closed case above — so surface it as a clean
                # error instead of letting it propagate as a raw, undetailed 500.
                name = "the local Lirep explorer" if source == "lirep" else "lichess's opening explorer"
                raise HTTPException(status_code=502, detail=f"could not reach {name}") from exc
            fetched_at = datetime.now(UTC).isoformat()
            store.set_explorer_cache(cache_key, data, fetched_at)
            return data, fetched_at

        pending = asyncio.create_task(fetch_and_cache())
        _inflight_explorer[cache_key] = pending

        def clear_pending(done: asyncio.Task[tuple[dict, str]]) -> None:
            if _inflight_explorer.get(cache_key) is done:
                del _inflight_explorer[cache_key]
            if not done.cancelled():
                done.exception()  # Consume failures if all waiting requests were cancelled.

        pending.add_done_callback(clear_pending)

    return await asyncio.shield(pending)


@router.get("/api/explorer-defaults")
async def explorer_defaults(request: Request) -> dict:
    """Rating buckets for the UI's picker, plus the bucket for the signed-in player's current rating."""
    token = request.session.get("access_token")
    username = request.session.get("username")
    default_min_rating = _bucket_for(DEFAULT_REFERENCE_RATING)
    if token:
        headers = {"Authorization": f"Bearer {token}"}
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            try:
                default_min_rating = await _resolve_min_rating(client, headers, username)
            except HTTPException:
                pass  # keep the generic default rather than failing the whole picker
    return {
        "ratingBuckets": list(RATING_BUCKETS),
        "defaultMinRating": default_min_rating,
        "speeds": list(ALL_SPEEDS),
        "defaultSpeeds": list(DEFAULT_SPEEDS),
        "defaultSource": DEFAULT_EXPLORER_SOURCE,
        "lirepAvailable": bool(LOCAL_LICHESS_EXPLORER_URL),
    }


@router.get("/api/explorer")
async def explorer(
    fen: str,
    request: Request,
    source: Literal["lirep", "lichess"] = DEFAULT_EXPLORER_SOURCE,
    database: str = "lichess",
    minRating: int | None = None,
    speeds: str = ",".join(DEFAULT_SPEEDS),
) -> dict:
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")

    headers = {"Authorization": f"Bearer {token}"}

    # A study's minRating is always a concrete bucket now (picked once, from
    # /api/explorer-defaults, when the study was created — see
    # ExplorerSettings). A live per-request "my current rating" lookup here
    # used to mean an extra Lichess account call on every single position
    # visited, plus a whole persisted-cache-with-TTL apparatus just to keep
    # that affordable — None only still shows up for a study saved before
    # this existed, and just gets the same static default the picker itself
    # falls back to, no account lookup involved.
    min_rating = minRating if minRating is not None else _bucket_for(DEFAULT_REFERENCE_RATING)

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        if source == "lirep" and not LOCAL_LICHESS_EXPLORER_URL:
            raise HTTPException(status_code=503, detail="Lirep Explorer is not configured")
        if source == "lirep" and database == "masters":
            raise HTTPException(status_code=400, detail="Masters is only available from Lichess")

        data, fetched_at = await fetch_explorer_cached(client, headers, fen, source, database, min_rating, speeds)

    return _shape_response(source, database, None if database == "masters" else min_rating, data, fetched_at)
