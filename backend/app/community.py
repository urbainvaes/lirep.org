"""Community page: public numbers and a leaderboard of the studies their owners
chose to share, plus importing one into your own account."""

from fastapi import APIRouter, HTTPException, Request

from . import store

router = APIRouter()

LEADERBOARD_SIZE = 100


def _count_moves_and_lines(tree: dict) -> tuple[int, int]:
    nodes = tree.get("nodes", {})
    root = str(tree.get("rootId", 0))
    moves = max(0, len(nodes) - 1)
    lines = sum(1 for key, node in nodes.items() if not node.get("children") and key != root)
    return moves, lines


def _ranked_entry(owner: str, study: dict, me: str | None) -> dict | None:
    """A leaderboard row, or None when the study has no comparable score: only
    win probabilities calculated from Lichess's own Explorer count (not the
    local one), and each row carries the settings that produced it."""
    stats = study.get("stats") or {}
    probability = stats.get("winProbability")
    if probability is None:
        return None
    settings = study["explorerSettings"]
    # Older stats records predate the "source" field; fall back to the study's.
    source = stats.get("source") or settings.get("source")
    if source != "lichess":
        return None
    moves, lines = _count_moves_and_lines(study["tree"])
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        "owner": owner,
        "mine": me is not None and owner.lower() == me.lower(),
        "winProbability": probability,
        "database": stats.get("database") or settings.get("database"),
        "minRating": stats.get("minRating", settings.get("minRating")),
        "speeds": stats.get("speeds") or settings.get("speeds") or [],
        "calculatedAt": stats.get("winProbabilityCalculatedAt"),
        "moves": moves,
        "lines": lines,
    }


@router.get("/api/community/summary")
def summary() -> dict:
    counts = store.community_counts()
    ranked = [e for owner, study in store.list_shared_studies() if (e := _ranked_entry(owner, study, None))]
    counts["rankedOpenings"] = len(ranked)
    counts["averageWinProbability"] = (
        sum(e["winProbability"] for e in ranked) / len(ranked) if ranked else None
    )
    return counts


@router.get("/api/community/openings")
def openings(request: Request) -> list[dict]:
    me = request.session.get("username")
    entries = [e for owner, study in store.list_shared_studies() if (e := _ranked_entry(owner, study, me))]
    entries.sort(key=lambda e: e["winProbability"], reverse=True)
    for rank, entry in enumerate(entries[:LEADERBOARD_SIZE], start=1):
        entry["rank"] = rank
    return entries[:LEADERBOARD_SIZE]


@router.post("/api/community/import/{study_id}")
def import_study(study_id: int, request: Request) -> dict:
    me = request.session.get("username")
    if not me or not request.session.get("access_token"):
        raise HTTPException(status_code=401, detail="not authenticated")
    found = store.get_shared_study(study_id)
    if not found:
        raise HTTPException(status_code=404, detail="not found")
    owner, study = found
    if owner.lower() == me.lower():
        raise HTTPException(status_code=400, detail="this is already your study")
    # A private copy: tree, side, starting point and Explorer settings. The
    # calculated stats and evaluations are not copied; they are recalculated.
    return store.create_study(
        me,
        study["name"],
        study["tree"],
        study["explorerSettings"],
        study["side"],
        study["startNodeId"],
    )
