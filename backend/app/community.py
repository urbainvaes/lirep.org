"""Community page: public numbers and a leaderboard of the studies their owners
chose to share, plus importing one into your own account."""

from fastapi import APIRouter, HTTPException, Request

from . import store
from .config import MAX_USERS

router = APIRouter()

LEADERBOARD_SIZE = 10
# The "Balanced" Stockfish depth on a study's Stats page; shallower expected
# evaluations are too noisy to compare.
MIN_LEADERBOARD_EVAL_DEPTH = 12


def _count_moves_and_lines(tree: dict) -> tuple[int, int]:
    nodes = tree.get("nodes", {})
    root = str(tree.get("rootId", 0))
    moves = max(0, len(nodes) - 1)
    lines = sum(1 for key, node in nodes.items() if not node.get("children") and key != root)
    return moves, lines


def _entry(owner: str, study: dict, me: str | None, include_lirep: bool = False, any_source: bool = False) -> dict:
    """A leaderboard row. Only win probabilities calculated from Lichess's own
    Explorer are comparable, so only those get a score and a rank; the rest are
    listed with the reason they are not ranked yet. Each scored row carries the
    settings that produced it. With include_lirep, scores calculated with the
    local Lirep Explorer (a two-month, 2016 sample) are ranked too."""
    stats = study.get("stats") or {}
    settings = study["explorerSettings"]
    probability = stats.get("winProbability")
    # Older stats records predate the "source" field; fall back to the study's.
    source = stats.get("source") or settings.get("source")
    moves, lines = _count_moves_and_lines(study["tree"])
    reason = None
    if probability is None:
        reason = "Stats not calculated yet"
    elif any_source:
        pass  # a profile shows every score, however it was calculated
    elif source != "lichess" and not include_lirep:
        reason = "Calculated with the local Explorer, not Lichess's"
        probability = None
    elif (stats.get("database") or settings.get("database")) == "player":
        reason = "Calculated from one player's games"
        probability = None
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        "owner": owner,
        "mine": me is not None and owner.lower() == me.lower(),
        "winProbability": probability,
        "reason": reason,
        "source": source,
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
    counts["maxUsers"] = MAX_USERS
    return counts


@router.get("/api/community/players")
def players() -> dict:
    """Everyone registered, numbered in registration order."""
    return {"maxUsers": MAX_USERS, "players": store.list_users()}


@router.get("/api/community/players/{username}")
def player(username: str, request: Request, includeLirep: bool = True) -> dict:
    """A public profile: when they joined and the studies they chose to share."""
    user = store.get_user(username)
    if user is None:
        raise HTTPException(status_code=404, detail="not found")
    me = request.session.get("username")
    studies = [
        _entry(owner, study, me, includeLirep, any_source=True)
        for owner, study in store.list_shared_studies()
        if owner.lower() == user["username"].lower()
    ]
    # Best win probability first (however it was calculated); studies without a
    # score last, in the order they were created.
    studies.sort(key=lambda e: (e["winProbability"] is None, -(e["winProbability"] or 0), e["id"]))
    return {"maxUsers": MAX_USERS, **user, "studies": studies}


@router.get("/api/community/studies/{study_id}")
def shared_study(study_id: int, request: Request) -> dict:
    """One shared opening, for the read-only viewer: its tree, side and the
    Explorer settings its author used. Studies that are not shared (or no
    longer shared) do not exist here. No scores: the viewer only browses."""
    found = store.get_shared_study(study_id)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    owner, study = found
    me = request.session.get("username")
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        "owner": owner,
        "mine": me is not None and owner.lower() == me.lower(),
        "tree": study["tree"],
        "startNodeId": study["startNodeId"],
        "explorerSettings": study["explorerSettings"],
    }


@router.get("/api/community/openings")
def openings(request: Request, includeLirep: bool = False) -> list[dict]:
    """Up to LEADERBOARD_SIZE ranked studies per side, best score first. Only
    studies with a comparable score appear: win probabilities calculated with
    Lichess's Explorer, plus (with includeLirep) those calculated with the
    local Lirep Explorer. Everything else is left out. Ranks are per side."""
    me = request.session.get("username")
    entries = [_entry(owner, study, me, includeLirep) for owner, study in store.list_shared_studies()]
    shown: list[dict] = []
    for side in ("white", "black"):
        ranked = sorted(
            (e for e in entries if e["side"] == side and e["winProbability"] is not None),
            key=lambda e: e["winProbability"],
            reverse=True,
        )
        for rank, entry in enumerate(ranked[:LEADERBOARD_SIZE], start=1):
            entry["rank"] = rank
            shown.append(entry)
    return shown


def _eval_entry(owner: str, study: dict, me: str | None, include_lirep: bool) -> dict | None:
    """A row of the expected-evaluation leaderboard, or None when the study's
    expected evaluation is not comparable: not calculated, a legacy server
    calculation (depth unknown), Stockfish below MIN_LEADERBOARD_EVAL_DEPTH,
    or Explorer settings the score leaderboard leaves out too."""
    stats = study.get("stats") or {}
    eval_cp = stats.get("evalCp")
    depth = stats.get("evalDepth")
    settings = stats.get("evalSettings")
    if eval_cp is None or settings is None or depth is None or depth < MIN_LEADERBOARD_EVAL_DEPTH:
        return None
    if settings["database"] == "player" or (settings["source"] != "lichess" and not include_lirep):
        return None
    moves, lines = _count_moves_and_lines(study["tree"])
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        "owner": owner,
        "mine": me is not None and owner.lower() == me.lower(),
        "evalCp": eval_cp,
        "depth": depth,
        "source": settings["source"],
        "database": settings["database"],
        "minRating": settings["minRating"],
        "speeds": settings["speeds"] or [],
        "calculatedAt": stats.get("evalCalculatedAt"),
        "moves": moves,
        "lines": lines,
        "rank": None,
    }


@router.get("/api/community/openings-by-eval")
def openings_by_eval(request: Request, includeLirep: bool = False) -> list[dict]:
    """Like /api/community/openings, ranked by expected evaluation at the end
    of prep instead of expected score. Only evaluations with Stockfish at depth
    MIN_LEADERBOARD_EVAL_DEPTH ("Balanced") or more are ranked."""
    me = request.session.get("username")
    entries = [
        e for owner, study in store.list_shared_studies()
        if (e := _eval_entry(owner, study, me, includeLirep)) is not None
    ]
    shown: list[dict] = []
    for side in ("white", "black"):
        ranked = sorted((e for e in entries if e["side"] == side), key=lambda e: e["evalCp"], reverse=True)
        for rank, entry in enumerate(ranked[:LEADERBOARD_SIZE], start=1):
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
