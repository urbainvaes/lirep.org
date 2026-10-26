from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, model_validator

from . import store
from .config import DEFAULT_EXPLORER_SOURCE
from .study_tree import InvalidTree, validate_tree

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
    # How the expected score values a line where the preparation ends, on
    # the Stats page and in the editor's figures (see stats.LeafValue; kept
    # here as a literal to avoid a circular import).
    leafValue: Literal["explorer", "stockfish", "explorer-stockfish"] = "explorer"
    # Stockfish's depth for the study's calculations, on the Stats page and
    # in the editor's figures and suggestions. None on settings saved before
    # it existed: the browser's default then.
    depth: Literal[8, 12, 16] | None = None

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


def _validate_tree(tree: dict, side: str = "white") -> None:
    try:
        validate_tree(tree, side)
    except InvalidTree as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


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
    _validate_tree(payload.tree, payload.side)
    start_node_id = _valid_start_node_id(payload.startNodeId, payload.tree)
    return store.create_study(
        owner, name, payload.tree, payload.explorerSettings.model_dump(), payload.side, start_node_id
    )


class ArchivedIn(BaseModel):
    archived: bool


@router.put("/api/studies/{study_id}/archived")
def set_archived(study_id: int, payload: ArchivedIn, request: Request) -> dict:
    """Archives a study (kept, apart on the home page, off the Practice and
    Community pages) or restores it."""
    owner = _require_owner(request)
    if not store.set_study_archived(owner, study_id, payload.archived):
        raise HTTPException(status_code=404, detail="not found")
    return {"archived": payload.archived}


class StudyOrderIn(BaseModel):
    ids: list[int] = Field(max_length=10_000)


# Before PUT /api/studies/{study_id}, which would otherwise take "order" for
# a study id.
@router.put("/api/studies/order")
def set_study_order(payload: StudyOrderIn, request: Request) -> dict:
    """The owner's studies in the order of their cards on the home page,
    after one is dragged."""
    owner = _require_owner(request)
    store.set_study_order(owner, payload.ids)
    return {"ok": True}


class DuplicateIn(BaseModel):
    name: str


@router.post("/api/studies/{study_id}/duplicate")
def duplicate_study(study_id: int, payload: DuplicateIn, request: Request) -> dict:
    """A private copy of one of your studies, under a new name (see
    store.duplicate_study)."""
    owner = _require_owner(request)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    copy = store.duplicate_study(owner, study_id, name)
    if not copy:
        raise HTTPException(status_code=404, detail="not found")
    return copy


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

    _validate_tree(payload.tree, existing["side"])
    start_node_id = _valid_start_node_id(payload.startNodeId, payload.tree)
    study = store.update_study(
        owner, study_id, name, payload.tree, payload.explorerSettings.model_dump(), existing["side"], start_node_id
    )
    assert study is not None
    return study


@router.put("/api/studies/{study_id}/explorer-settings")
def set_explorer_settings(study_id: int, payload: ExplorerSettings, request: Request) -> dict:
    """The study's settings alone (the Stats page's Save, and its
    calculations): its results calculated with other settings then show as
    out of date."""
    owner = _require_owner(request)
    study = store.update_explorer_settings(owner, study_id, payload.model_dump())
    if not study:
        raise HTTPException(status_code=404, detail="not found")
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


class PgnIn(BaseModel):
    pgn: str = Field(min_length=1, max_length=MAX_PGN_LENGTH)


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


@router.put("/api/studies/{study_id}/games/{game_id}/pgn")
def set_game_pgn(study_id: int, game_id: int, payload: PgnIn, request: Request) -> dict:
    """The game with the player's comments on its positions, which are kept
    in its PGN (see store.set_study_game_pgn)."""
    _require_study(request, study_id)
    if not store.set_study_game_pgn(study_id, game_id, payload.pgn):
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
