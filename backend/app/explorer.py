"""The Opening Explorer on the backend: rating defaults for the picker, and
the local Lirep Explorer (the 2016 sample). Lichess's own Explorer is queried
by the browser directly, with the user's token (frontend/src/explorerClient.ts),
so each user's requests count against their own rate limit."""

from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException, Request

from . import store
from .auth import ACCOUNT_URL
from .config import DEFAULT_EXPLORER_SOURCE, HTTP_TIMEOUT, LOCAL_LICHESS_EXPLORER_URL

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


async def fetch_lirep(client: httpx.AsyncClient, fen: str, min_rating: int, speeds: str) -> dict:
    """One position from the local Lirep Explorer. It has no rate limit and
    its data never changes, so nothing is cached."""
    if not LOCAL_LICHESS_EXPLORER_URL:
        raise HTTPException(status_code=503, detail="Lirep Explorer is not configured")
    try:
        resp = await client.get(
            f"{LOCAL_LICHESS_EXPLORER_URL}/lichess",
            params={"fen": fen, "speeds": speeds, "ratings": _ratings_from(min_rating)},
        )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="could not reach the local Lirep explorer") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Lirep explorer fetch failed ({resp.status_code})")
    return resp.json()


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
    minRating: int | None = None,
    speeds: str = ",".join(DEFAULT_SPEEDS),
) -> dict:
    """The local Lirep Explorer (Players database only). Lichess's Explorer
    is not proxied here: the browser asks it directly."""
    if not request.session.get("access_token"):
        raise HTTPException(status_code=401, detail="not authenticated")
    # minRating is None only for a study saved before it was always set.
    min_rating = minRating if minRating is not None else _bucket_for(DEFAULT_REFERENCE_RATING)
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        data = await fetch_lirep(client, fen, min_rating, speeds)
    return _shape_response("lirep", "lichess", min_rating, data, datetime.now(UTC).isoformat())
