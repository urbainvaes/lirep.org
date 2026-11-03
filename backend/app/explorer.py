"""The Opening Explorer on the backend: the picker's choices and defaults, and
the local Lirep Explorer (the 2016 sample). Lichess's own Explorer is queried
by the browser directly, with the user's token (frontend/src/explorerClient.ts),
so each user's requests count against their own rate limit."""

from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, HTTPException, Request

from .config import DEFAULT_EXPLORER_SOURCE, HTTP_TIMEOUT, LOCAL_LICHESS_EXPLORER_URL

# All speeds selectable in the UI. Ultra-bullet and correspondence are left
# off the picker entirely (too noisy / too rare to be worth the extra UI
# clutter).
ALL_SPEEDS = ("bullet", "blitz", "rapid", "classical")

# The explorer's own rating-bucket boundaries (each bucket covers itself up
# to the next one, and the last is open-ended).
RATING_BUCKETS = (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500)

# A new study's Explorer: blitz games rated 1600+, as the Browse page's
# openings are calculated with (tools/browse_stats.mjs).
DEFAULT_SPEEDS = ("blitz",)
DEFAULT_MIN_RATING = 1600
# What a study saved before minRating was always set (null) means.
LEGACY_MIN_RATING = 1400

router = APIRouter()


def _ratings_from(min_rating: int) -> str:
    return ",".join(str(b) for b in RATING_BUCKETS if b >= min_rating)


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
async def explorer_defaults() -> dict:
    """The picker's choices, and a new study's settings."""
    return {
        "ratingBuckets": list(RATING_BUCKETS),
        "defaultMinRating": DEFAULT_MIN_RATING,
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
    min_rating = minRating if minRating is not None else LEGACY_MIN_RATING
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        data = await fetch_lirep(client, fen, min_rating, speeds)
    return _shape_response("lirep", "lichess", min_rating, data, datetime.now(UTC).isoformat())
