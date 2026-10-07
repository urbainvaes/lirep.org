from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from . import store
from .config import DEFAULT_EXPLORER_SOURCE

router = APIRouter()


class ExplorerSettings(BaseModel):
    enabled: bool = True
    source: Literal["lirep", "lichess"] = DEFAULT_EXPLORER_SOURCE
    database: Literal["lichess", "masters", "player"] = "lichess"
    # Only for database == "player": whose games to look at (the games they
    # played as the study's side), like the Player tab of Lichess's explorer.
    player: str | None = None
    # A fixed bucket, chosen once (see /api/explorer-defaults) rather than
    # tracked as a standing "current rating" mode. Only ever None for a
    # study saved before this existed — see explorer.py's fallback.
    minRating: int | None = None
    speeds: list[Literal["bullet", "blitz", "rapid", "classical"]] = ["blitz", "rapid", "classical"]

    @model_validator(mode="before")
    @classmethod
    def default_source_for_saved_settings(cls, values: object) -> object:
        if isinstance(values, dict):
            values = dict(values)
            if "source" not in values:
                values["source"] = "lichess" if values.get("database") == "masters" else DEFAULT_EXPLORER_SOURCE
            if values["source"] == "lirep" and values.get("database") == "masters":
                values["database"] = "lichess"
            if values.get("database") == "player":
                # One player's games exist only on Lichess's own explorer.
                values["source"] = "lichess"
                values["player"] = (values.get("player") or "").strip() or None
        return values


class SharedIn(BaseModel):
    shared: bool


class StudyIn(BaseModel):
    name: str
    tree: dict
    explorerSettings: ExplorerSettings = ExplorerSettings()
    side: Literal["white", "black"] = "white"
    # None (the default) means "no override — calculations start at the
    # tree's real root". See starting-point.md.
    startNodeId: int | None = None


def _require_owner(request: Request) -> str:
    username = request.session.get("username")
    if not username:
        raise HTTPException(status_code=401, detail="not authenticated")
    return username


def _validate_tree(tree: dict) -> None:
    """Structural integrity only (not chess legality) — just enough to keep
    every later reader (stats.py's/practice.py's _get_node, which does a
    bare tree["nodes"][str(node_id)]) from crashing with an uncaught
    KeyError on a malformed tree. Raises 400 rather than letting a bad
    write silently brick the study for every future read."""

    def bad(reason: str) -> None:
        raise HTTPException(status_code=400, detail=f"invalid tree: {reason}")

    nodes = tree.get("nodes")
    root_id = tree.get("rootId")
    next_id = tree.get("nextId")
    if not isinstance(nodes, dict) or not nodes:
        bad("nodes must be a non-empty object")
    if not isinstance(root_id, int):
        bad("rootId must be an integer")
    if not isinstance(next_id, int):
        bad("nextId must be an integer")
    if str(root_id) not in nodes:
        bad("rootId is not in nodes")

    max_id = -1
    for key, node in nodes.items():
        if not isinstance(node, dict):
            bad(f"node {key} is not an object")
        node_id = node.get("id")
        if not isinstance(node_id, int) or str(node_id) != key:
            bad(f"node {key} has a mismatched or missing id")
        max_id = max(max_id, node_id)

        parent_id = node.get("parentId")
        is_root = node_id == root_id
        if is_root != (parent_id is None):
            bad(f"node {key}: exactly the root should have parentId null")
        if parent_id is not None:
            if not isinstance(parent_id, int) or str(parent_id) not in nodes:
                bad(f"node {key} has an unknown parentId")

        san = node.get("san")
        if is_root != (san is None):
            bad(f"node {key}: exactly the root should have san null")
        if san is not None and not isinstance(san, str):
            bad(f"node {key} has a non-string san")

        children = node.get("children")
        if not isinstance(children, list) or any(not isinstance(c, int) for c in children):
            bad(f"node {key} has a malformed children list")
        for child_id in children:
            if str(child_id) not in nodes:
                bad(f"node {key} references unknown child {child_id}")
            if nodes[str(child_id)].get("parentId") != node_id:
                bad(f"node {key} and child {child_id} disagree on parentage")

    for key, node in nodes.items():
        parent_id = node.get("parentId")
        if parent_id is not None and int(key) not in nodes[str(parent_id)].get("children", []):
            bad(f"node {key} is missing from parent {parent_id}'s children")

    if next_id <= max_id:
        bad("nextId must be greater than every existing node id")


def _valid_start_node_id(start_node_id: int | None, tree: dict) -> int | None:
    """A stored id that no longer exists in the tree (its subtree got
    deleted) degrades to "no override" rather than being rejected outright —
    same instinct as the calculation-time fallback in stats.py."""
    if start_node_id is None:
        return None
    if str(start_node_id) not in tree.get("nodes", {}):
        return None
    return start_node_id


@router.get("/api/studies")
def list_studies(request: Request) -> list[dict]:
    owner = _require_owner(request)
    return store.list_studies(owner)


@router.post("/api/studies")
def create_study(payload: StudyIn, request: Request) -> dict:
    owner = _require_owner(request)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    _validate_tree(payload.tree)
    start_node_id = _valid_start_node_id(payload.startNodeId, payload.tree)
    return store.create_study(
        owner, name, payload.tree, payload.explorerSettings.model_dump(), payload.side, start_node_id
    )


@router.get("/api/studies/{study_id}")
def get_study(study_id: int, request: Request) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="not found")
    return study


@router.delete("/api/studies/{study_id}")
def delete_study(study_id: int, request: Request) -> dict:
    owner = _require_owner(request)
    if not store.delete_study(owner, study_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": True}


@router.put("/api/studies/{study_id}")
def update_study(study_id: int, payload: StudyIn, request: Request) -> dict:
    owner = _require_owner(request)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")

    # Side is chosen once at creation and can't change afterwards (the tree's
    # one-move-per-studied-side rule and the Stats calculation both assume a
    # fixed side) — so a PUT can never alter it, no matter what's sent.
    existing = store.get_study(owner, study_id)
    if not existing:
        raise HTTPException(status_code=404, detail="not found")

    _validate_tree(payload.tree)
    start_node_id = _valid_start_node_id(payload.startNodeId, payload.tree)
    study = store.update_study(
        owner, study_id, name, payload.tree, payload.explorerSettings.model_dump(), existing["side"], start_node_id
    )
    assert study is not None
    return study


@router.put("/api/studies/{study_id}/shared")
def set_shared(study_id: int, payload: SharedIn, request: Request) -> dict:
    """Sharing is a separate call (not part of the autosaved study body) so an
    autosave can never publish or unpublish a study by accident."""
    owner = _require_owner(request)
    study = store.set_study_shared(owner, study_id, payload.shared)
    if not study:
        raise HTTPException(status_code=404, detail="not found")
    return study


# The study's Games page: games (PGN as given) in sections the player
# orders. The PGN is read in the browser; here only sizes are checked.
MAX_GAMES_PER_STUDY = 500
MAX_PGN_LENGTH = 100_000
MAX_COMMENT_LENGTH = 10_000
MAX_SECTION_NAME = 60
MAX_SECTIONS = 50


class GameIn(BaseModel):
    pgn: str = Field(min_length=1, max_length=MAX_PGN_LENGTH)
    comment: str = Field(default="", max_length=MAX_COMMENT_LENGTH)


class GamesIn(BaseModel):
    # "" for no section.
    section: str = Field(default="", max_length=MAX_SECTION_NAME)
    games: list[GameIn] = Field(min_length=1)


class CommentIn(BaseModel):
    comment: str = Field(max_length=MAX_COMMENT_LENGTH)


class SectionIn(BaseModel):
    # "" holds the games without a section.
    name: str = Field(max_length=MAX_SECTION_NAME)
    gameIds: list[int]


class LayoutIn(BaseModel):
    sections: list[SectionIn] = Field(max_length=MAX_SECTIONS + 1)  # + the games without a section


def _require_study(request: Request, study_id: int) -> None:
    if not store.get_study(_require_owner(request), study_id):
        raise HTTPException(status_code=404, detail="not found")


@router.get("/api/studies/{study_id}/games")
def list_games(study_id: int, request: Request) -> dict:
    _require_study(request, study_id)
    return store.get_study_games(study_id)


@router.post("/api/studies/{study_id}/games")
def add_games(study_id: int, payload: GamesIn, request: Request) -> dict:
    _require_study(request, study_id)
    section = payload.section.strip()
    if store.count_study_games(study_id) + len(payload.games) > MAX_GAMES_PER_STUDY:
        raise HTTPException(status_code=422, detail=f"a study can have at most {MAX_GAMES_PER_STUDY} games")
    sections = store.get_study_games(study_id)["sections"]
    if section and section not in sections and len(sections) >= MAX_SECTIONS:
        raise HTTPException(status_code=422, detail=f"a study can have at most {MAX_SECTIONS} sections")
    ids = store.add_study_games(study_id, section, [g.model_dump() for g in payload.games])
    return {"ids": ids}


@router.put("/api/studies/{study_id}/games/{game_id}/comment")
def set_game_comment(study_id: int, game_id: int, payload: CommentIn, request: Request) -> dict:
    _require_study(request, study_id)
    if not store.set_study_game_comment(study_id, game_id, payload.comment):
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@router.delete("/api/studies/{study_id}/games/{game_id}")
def delete_game(study_id: int, game_id: int, request: Request) -> dict:
    _require_study(request, study_id)
    if not store.delete_study_game(study_id, game_id):
        raise HTTPException(status_code=404, detail="not found")
    return {"ok": True}


@router.put("/api/studies/{study_id}/games-layout")
def set_games_layout(study_id: int, payload: LayoutIn, request: Request) -> dict:
    """Sections in order with their games in order: reordering, renaming,
    adding or removing sections, and moving games, all in one call."""
    _require_study(request, study_id)
    names = [s.name.strip() for s in payload.sections]
    if len(set(names)) != len(names):
        raise HTTPException(status_code=422, detail="section names must be distinct")
    layout = [{"name": n, "gameIds": s.gameIds} for n, s in zip(names, payload.sections)]
    if not store.set_study_game_layout(study_id, layout):
        raise HTTPException(status_code=409, detail="the games changed; reload the page")
    return store.get_study_games(study_id)
