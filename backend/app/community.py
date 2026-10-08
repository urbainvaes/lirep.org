"""Community page: public numbers and a leaderboard of the studies their owners
chose to share, plus importing one into your own account."""

import asyncio
import time
from typing import Literal, NamedTuple

import httpx
from fastapi import APIRouter, HTTPException, Request

from . import store
from .config import HTTP_TIMEOUT, MAX_USERS

router = APIRouter()

LEADERBOARD_SIZE = 10
# The leaderboards rank one Explorer's scores at a time: Lichess's, or the
# local Lirep Explorer's (a two-month 2016 sample). Scores from the two are
# not comparable, so they are never ranked together.
Source = Literal["lichess", "lirep"]
# The "Balanced" Stockfish depth on a study's Stats page; shallower expected
# evaluations are too noisy to compare.
MIN_LEADERBOARD_EVAL_DEPTH = 12


def _count_moves_and_lines(tree: dict) -> tuple[int, int]:
    nodes = tree.get("nodes", {})
    root = str(tree.get("rootId", 0))
    moves = max(0, len(nodes) - 1)
    lines = sum(1 for key, node in nodes.items() if not node.get("children") and key != root)
    return moves, lines


def _is_mine(owner: str, me: str | None) -> bool:
    return me is not None and owner.lower() == me.lower()


class _Names(NamedTuple):
    """The Lichess usernames others may not see (lowercased): anonymous
    players, shown without a name, and players with a pen name (see
    USER_ALIASES), shown under it."""

    anonymous: frozenset[str] = frozenset()
    aliases: dict[str, str] = {}

    def public(self, username: str) -> str | None:
        """How others see `username`: None for an anonymous player."""
        if username.lower() in self.anonymous:
            return None
        return self.aliases.get(username.lower(), username)


def _names() -> _Names:
    return _Names(frozenset(store.anonymous_usernames()), store.user_aliases())


def _owner_fields(owner: str, me: str | None, names: _Names) -> dict:
    """Who a shared study belongs to: an anonymous player's name is only
    shown to themselves; a pen name is shown to everyone, its owner too."""
    mine = _is_mine(owner, me)
    public = names.public(owner)
    return {
        "owner": owner if mine and public is None else public,
        "anonymous": owner.lower() in names.anonymous,
        "mine": mine,
    }


def _public_settings(settings: dict, owner: str, me: str | None, names: _Names) -> dict:
    """Explorer settings as others may see them. A study built on the games
    of a player whose name is hidden would give that name away, so others
    browse it with the Lichess database instead."""
    player = settings.get("player")
    if settings.get("database") != "player" or not player or _is_mine(owner, me):
        return settings
    if player.lower() not in names.anonymous and player.lower() not in names.aliases:
        return settings
    return {**settings, "database": "lichess", "player": None}


def _entry(
    owner: str,
    study: dict,
    me: str | None,
    ranked_source: Source = "lichess",
    any_source: bool = False,
    names: _Names = _Names(),
) -> dict:
    """A leaderboard row. Only win probabilities calculated with
    `ranked_source`'s Explorer get a score and a rank; the rest are listed
    with the reason they are not ranked. Each scored row carries the
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
    elif any_source:
        pass  # a profile shows every score, however it was calculated
    elif (stats.get("database") or settings.get("database")) == "player":
        reason = "Calculated from one player's games"
        probability = None
    elif source != ranked_source:
        reason = "Calculated with another Explorer"
        probability = None
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        **_owner_fields(owner, me, names),
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
    shared = store.list_shared_studies()
    ranked = [e for owner, study in shared if (e := _entry(owner, study, None))["winProbability"] is not None]
    counts["rankedOpenings"] = len(ranked)
    # Shared studies with a result rankable on the 2016 sample; the Community
    # page only offers that view when there is something to show.
    counts["lirepOpenings"] = sum(
        1 for owner, study in shared
        if _entry(owner, study, None, "lirep")["winProbability"] is not None
        or _eval_entry(owner, study, None, "lirep") is not None
    )
    counts["maxUsers"] = MAX_USERS
    return counts


@router.get("/api/community/players")
def players() -> dict:
    """Everyone registered, numbered in registration order. Anonymous players
    are counted, but without their name; players with a pen name are listed
    under it."""
    names = _names()
    players = [{**player, "username": names.public(player["username"])} for player in store.list_users()]
    return {"maxUsers": MAX_USERS, "players": players}


@router.get("/api/community/players/{username}")
def player(username: str, request: Request) -> dict:
    """A public profile: when they joined and the studies they chose to share."""
    me = request.session.get("username")
    names = _names()
    # A pen name leads to the profile; the username behind it doesn't, except
    # for its owner, so it can't be confirmed by guessing.
    by_alias = {alias.lower(): name for name, alias in names.aliases.items()}
    user = store.get_user(by_alias.get(username.lower(), username))
    if user is None:
        raise HTTPException(status_code=404, detail="not found")
    mine = _is_mine(user["username"], me)
    aliased = user["username"].lower() in names.aliases
    if not mine and aliased and username.lower() not in by_alias:
        raise HTTPException(status_code=404, detail="not found")
    # An anonymous player's profile would tie their name to their studies.
    if user["anonymous"] and not mine:
        raise HTTPException(status_code=404, detail="not found")
    studies = [
        _entry(owner, study, me, any_source=True, names=names)
        for owner, study in store.list_shared_studies()
        if owner.lower() == user["username"].lower()
    ]
    # Best win probability first (however it was calculated); studies without a
    # score last, in the order they were created.
    studies.sort(key=lambda e: (e["winProbability"] is None, -(e["winProbability"] or 0), e["id"]))
    return {
        "maxUsers": MAX_USERS,
        **user,
        "username": names.aliases[user["username"].lower()] if aliased else user["username"],
        "aliased": aliased,
        "studies": studies,
    }


# The strongest players: registered players' current Lichess ratings,
# fetched in one request (Lichess accepts up to 300 names) and kept for an
# hour, so the page doesn't call Lichess on every visit.
LICHESS_USERS_URL = "https://lichess.org/api/users"
TOP_PLAYERS_SPEEDS = ("bullet", "blitz", "rapid")
TOP_PLAYERS_SIZE = 10
TOP_PLAYERS_TTL_SECONDS = 60 * 60
_top_players: dict | None = None
_top_players_at = 0.0
_top_players_lock = asyncio.Lock()


async def _fetch_lichess_users(usernames: list[str]) -> list[dict]:
    found: list[dict] = []
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        for start in range(0, len(usernames), 300):
            resp = await client.post(LICHESS_USERS_URL, content=",".join(usernames[start : start + 300]))
            resp.raise_for_status()
            found.extend(resp.json())
    return found


@router.get("/api/community/top-players")
async def top_players() -> dict:
    """Per speed, the registered players with the highest Lichess ratings.
    Anonymous players are listed without their name and with their rating
    rounded down to the hundred (an exact rating could identify them); they
    are also ranked by that rounded rating, so their place in the list
    doesn't narrow it down. Players with a pen name are listed under it, the
    same way: rounded rating and no title. Provisional ratings, closed accounts and accounts
    Lichess flagged for breaking its terms are left out."""
    global _top_players, _top_players_at
    async with _top_players_lock:
        if _top_players is None or time.monotonic() - _top_players_at > TOP_PLAYERS_TTL_SECONDS:
            names = _names()
            usernames = [u["username"] for u in store.list_users()]
            try:
                users = await _fetch_lichess_users(usernames) if usernames else []
            except (httpx.HTTPError, ValueError):
                if _top_players is not None:
                    return _top_players  # stale is better than nothing
                raise HTTPException(status_code=502, detail="Lichess is unavailable")
            board: dict[str, list[dict]] = {}
            for speed in TOP_PLAYERS_SPEEDS:
                rated = []
                for u in users:
                    perf = u.get("perfs", {}).get(speed)
                    if u.get("disabled") or u.get("tosViolation") or not perf or not perf.get("games") or perf.get("prov"):
                        continue
                    if u["username"].lower() in names.anonymous:
                        rounded = perf["rating"] // 100 * 100
                        rated.append({"username": None, "title": u.get("title"), "rating": rounded, "roundedDown": True})
                    elif u["username"].lower() in names.aliases:
                        rounded = perf["rating"] // 100 * 100
                        alias = names.aliases[u["username"].lower()]
                        rated.append({"username": alias, "title": None, "rating": rounded, "roundedDown": True})
                    else:
                        rated.append({"username": u["username"], "title": u.get("title"), "rating": perf["rating"], "roundedDown": False})
                # Named players first among equal ratings, so an anonymous
                # 2100+ sits below a named 2100.
                rated.sort(key=lambda r: (r["rating"], not r["roundedDown"]), reverse=True)
                board[speed] = rated[:TOP_PLAYERS_SIZE]
            _top_players, _top_players_at = board, time.monotonic()
    return _top_players


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
    names = _names()
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        **_owner_fields(owner, me, names),
        "tree": study["tree"],
        "startNodeId": study["startNodeId"],
        "explorerSettings": _public_settings(study["explorerSettings"], owner, me, names),
    }


@router.get("/api/community/openings")
def openings(request: Request, source: Source = "lichess") -> list[dict]:
    """Up to LEADERBOARD_SIZE ranked studies per side, best score first. Only
    studies with a comparable score appear: win probabilities calculated with
    `source`'s Explorer. Everything else is left out. Ranks are per side."""
    me = request.session.get("username")
    names = _names()
    entries = [_entry(owner, study, me, source, names=names) for owner, study in store.list_shared_studies()]
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


def _eval_entry(
    owner: str, study: dict, me: str | None, ranked_source: Source, names: _Names = _Names()
) -> dict | None:
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
    if settings["database"] == "player" or settings["source"] != ranked_source:
        return None
    moves, lines = _count_moves_and_lines(study["tree"])
    return {
        "id": study["id"],
        "name": study["name"],
        "side": study["side"],
        **_owner_fields(owner, me, names),
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
def openings_by_eval(request: Request, source: Source = "lichess") -> list[dict]:
    """Like /api/community/openings, ranked by expected evaluation at the end
    of prep instead of expected score. Only evaluations with Stockfish at depth
    MIN_LEADERBOARD_EVAL_DEPTH ("Balanced") or more are ranked."""
    me = request.session.get("username")
    names = _names()
    entries = [
        e for owner, study in store.list_shared_studies()
        if (e := _eval_entry(owner, study, me, source, names)) is not None
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
    if _is_mine(owner, me):
        raise HTTPException(status_code=400, detail="this is already your study")
    # A private copy (not shared, so it does not appear a second time on the
    # leaderboard): tree, side, starting point and Explorer settings. The
    # calculated stats and evaluations are not copied; they are recalculated.
    return store.create_study(
        me,
        study["name"],
        study["tree"],
        _public_settings(study["explorerSettings"], owner, me, _names()),
        study["side"],
        study["startNodeId"],
        shared=False,
    )
