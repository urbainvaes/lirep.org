import httpx
from fastapi import APIRouter, HTTPException, Request

from .auth import ACCOUNT_URL

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


def _shape_response(database: str, min_rating: int | None, data: dict) -> dict:
    opening = data.get("opening")
    return {
        "database": database,
        "minRating": min_rating,
        "opening": opening["name"] if opening else None,
        "totals": {
            "white": data.get("white", 0),
            "draws": data.get("draws", 0),
            "black": data.get("black", 0),
        },
        "moves": _shape_moves(data),
    }


async def fetch_explorer(
    client: httpx.AsyncClient,
    headers: dict[str, str],
    fen: str,
    database: str,
    min_rating: int | None,
    speeds: str,
) -> dict:
    """Shared by the live /api/explorer endpoint and stats.py's recalculation."""
    if database == "masters":
        resp = await client.get(MASTERS_EXPLORER_URL, params={"fen": fen}, headers=headers)
    else:
        assert min_rating is not None
        resp = await client.get(
            LICHESS_EXPLORER_URL,
            params={"fen": fen, "speeds": speeds, "ratings": _ratings_from(min_rating)},
            headers=headers,
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="lichess explorer fetch failed")
    return resp.json()


@router.get("/api/explorer-defaults")
async def explorer_defaults(request: Request) -> dict:
    """Rating buckets for the UI's picker, plus the bucket for the signed-in player's current rating."""
    token = request.session.get("access_token")
    default_min_rating = _bucket_for(DEFAULT_REFERENCE_RATING)
    if token:
        async with httpx.AsyncClient() as client:
            account_resp = await client.get(ACCOUNT_URL, headers={"Authorization": f"Bearer {token}"})
        if account_resp.status_code == 200:
            default_min_rating = _bucket_for(_reference_rating(account_resp.json().get("perfs", {})))
    return {
        "ratingBuckets": list(RATING_BUCKETS),
        "defaultMinRating": default_min_rating,
        "speeds": list(ALL_SPEEDS),
        "defaultSpeeds": list(DEFAULT_SPEEDS),
    }


@router.get("/api/explorer")
async def explorer(
    fen: str,
    request: Request,
    database: str = "lichess",
    minRating: int | None = None,
    speeds: str = ",".join(DEFAULT_SPEEDS),
) -> dict:
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")

    headers = {"Authorization": f"Bearer {token}"}

    min_rating: int | None = None
    async with httpx.AsyncClient() as client:
        if database != "masters" and minRating is None:
            account_resp = await client.get(ACCOUNT_URL, headers=headers)
            if account_resp.status_code != 200:
                raise HTTPException(status_code=502, detail="lichess account fetch failed")
            min_rating = _bucket_for(_reference_rating(account_resp.json().get("perfs", {})))
        else:
            min_rating = minRating

        data = await fetch_explorer(client, headers, fen, database, min_rating, speeds)

    return _shape_response(database, None if database == "masters" else min_rating, data)
