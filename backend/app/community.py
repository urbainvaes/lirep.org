"""Community page: public numbers and a leaderboard of the studies their owners
chose to share, plus importing one into your own account."""

from fastapi import APIRouter, HTTPException, Request

from . import store

router = APIRouter()

LEADERBOARD_SIZE = 10


def _count_moves_and_lines(tree: dict) -> tuple[int, int]:
    nodes = tree.get("nodes", {})
    root = str(tree.get("rootId", 0))
    moves = max(0, len(nodes) - 1)
    lines = sum(1 for key, node in nodes.items() if not node.get("children") and key != root)
    return moves, lines


def _entry(owner: str, study: dict, me: str | None) -> dict:
    """A leaderboard row. Only win probabilities calculated from Lichess's own
    Explorer are comparable, so only those get a score and a rank; the rest are
    listed with the reason they are not ranked yet. Each scored row carries the
    settings that produced it."""
    stats = study.get("stats") or {}
    settings = study["explorerSettings"]
    probability = stats.get("winProbability")
    # Older stats records predate the "source" field; fall back to the study's.
    source = stats.get("source") or settings.get("source")
    moves, lines = _count_moves_and_lines(study["tree"])
    reason = None
    if probability is None:
        reason = "Stats not calculated yet"
    elif source != "lichess":
        reason = "Calculated with the local Explorer, not Lichess's"
        probability = None
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        "owner": owner,
        "mine": me is not None and owner.lower() == me.lower(),
        "winProbability": probability,
        "reason": reason,
        "database": stats.get("database") or settings.get("database"),
        "minRating": stats.get("minRating", settings.get("minRating")),
        "speeds": stats.get("speeds") or settings.get("speeds") or [],
        "calculatedAt": stats.get("winProbabilityCalculatedAt"),
        "moves": moves,
        "lines": lines,
        "rank": None,
    }


@router.get("/api/community/summary")
def summary() -> dict:
    counts = store.community_counts()
    ranked = [
        e for owner, study in store.list_shared_studies()
        if (e := _entry(owner, study, None))["winProbability"] is not None
    ]
    counts["rankedOpenings"] = len(ranked)
    return counts


@router.get("/api/community/openings")
def openings(request: Request) -> list[dict]:
    """Up to LEADERBOARD_SIZE shared studies per side: the best-scoring first,
    then (to fill the list) the ones that have no comparable score yet. Ranks
    are per side, since White and Black openings are shown separately."""
    me = request.session.get("username")
    entries = [_entry(owner, study, me) for owner, study in store.list_shared_studies()]
    shown: list[dict] = []
    for side in ("white", "black"):
        group = [e for e in entries if e["side"] == side]
        ranked = sorted((e for e in group if e["winProbability"] is not None),
                        key=lambda e: e["winProbability"], reverse=True)
        unranked = sorted((e for e in group if e["winProbability"] is None), key=lambda e: e["id"])
        rank = 0
        for entry in (ranked + unranked)[:LEADERBOARD_SIZE]:
            if entry["winProbability"] is not None:
                rank += 1
                entry["rank"] = rank
            shown.append(entry)
    return shown


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
    # A private copy (not shared, so it does not appear a second time on the
    # leaderboard): tree, side, starting point and Explorer settings. The
    # calculated stats and evaluations are not copied; they are recalculated.
    return store.create_study(
        me,
        study["name"],
        study["tree"],
        study["explorerSettings"],
        study["side"],
        study["startNodeId"],
        shared=False,
    )
