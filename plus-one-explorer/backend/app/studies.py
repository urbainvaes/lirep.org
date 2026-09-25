from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import store

router = APIRouter()


class ExplorerSettings(BaseModel):
    enabled: bool = True
    database: Literal["lichess", "masters"] = "lichess"
    # None means "always use my current rating" rather than a fixed value pinned to the study.
    minRating: int | None = None
    speeds: list[Literal["bullet", "blitz", "rapid", "classical"]] = ["blitz", "rapid", "classical"]


class StudyIn(BaseModel):
    name: str
    tree: dict
    explorerSettings: ExplorerSettings = ExplorerSettings()
    side: Literal["white", "black"] = "white"


def _require_owner(request: Request) -> str:
    username = request.session.get("username")
    if not username:
        raise HTTPException(status_code=401, detail="not authenticated")
    return username


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
    return store.create_study(owner, name, payload.tree, payload.explorerSettings.model_dump(), payload.side)


@router.get("/api/studies/{study_id}")
def get_study(study_id: int, request: Request) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="not found")
    return study


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

    study = store.update_study(
        owner, study_id, name, payload.tree, payload.explorerSettings.model_dump(), existing["side"]
    )
    assert study is not None
    return study
