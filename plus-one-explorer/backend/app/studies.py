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
    study = store.update_study(
        owner, study_id, name, payload.tree, payload.explorerSettings.model_dump(), payload.side
    )
    if not study:
        raise HTTPException(status_code=404, detail="not found")
    return study
