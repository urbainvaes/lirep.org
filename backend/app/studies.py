from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, model_validator

from . import store
from .config import DEFAULT_EXPLORER_SOURCE

router = APIRouter()


class ExplorerSettings(BaseModel):
    enabled: bool = True
    source: Literal["lirep", "lichess"] = DEFAULT_EXPLORER_SOURCE
    database: Literal["lichess", "masters"] = "lichess"
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
        return values


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

    start_node_id = _valid_start_node_id(payload.startNodeId, payload.tree)
    study = store.update_study(
        owner, study_id, name, payload.tree, payload.explorerSettings.model_dump(), existing["side"], start_node_id
    )
    assert study is not None
    return study
