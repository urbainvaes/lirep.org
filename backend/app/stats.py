"""Saving a study's stats, calculated in the browser.

Both the expected score (with coverage) and the expected evaluation are
calculated by the Stats page itself: the Opening Explorer requests behind
them then come from the user's own browser and token, so each user stays
within their own Lichess rate limit (see explorer-cache.md). The backend
validates what it can and stores the results with the settings and moves
they were calculated from.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from . import store
from .studies import ExplorerSettings

router = APIRouter()


def _require_owner(request: Request) -> str:
    username = request.session.get("username")
    if not username:
        raise HTTPException(status_code=401, detail="not authenticated")
    return username


def _get_node(tree: dict, node_id: int) -> dict:
    return tree["nodes"][str(node_id)]


def _sans_to(tree: dict, node_id: int) -> list[str]:
    sans: list[str] = []
    node = _get_node(tree, node_id)
    while node["parentId"] is not None:
        sans.append(node["san"])
        node = _get_node(tree, node["parentId"])
    sans.reverse()
    return sans


def _resolve_start_node_id(study: dict) -> int:
    """The node every calculation should treat as move one — a study's
    `startNodeId` if it's set and still exists in the current tree, else the
    tree's real root. See starting-point.md: a stale id (its subtree got
    deleted since it was set) degrades to the default rather than erroring,
    the same instinct as every other fallback in this app."""
    start_node_id = study.get("startNodeId")
    if start_node_id is not None and str(start_node_id) in study["tree"]["nodes"]:
        return start_node_id
    return study["tree"]["rootId"]


Share = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]


class ExpectedScoreIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    winRate: Share
    lossProbability: Share
    # coverage[i]: share of games still in the tree after the opponent's
    # (i+1)th move from the starting point.
    coverage: list[Share] = Field(max_length=500)
    nodesEvaluated: int = Field(strict=True, ge=0)
    explorerCalls: int = Field(strict=True, ge=0)
    explorerSettings: ExplorerSettings

    @model_validator(mode="after")
    def _outcomes_add_up(self) -> "ExpectedScoreIn":
        if self.winRate + self.lossProbability > 1 + 1e-9:
            raise ValueError("win and loss probabilities add up to more than 1")
        return self


class ExpectedEvalIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evalCp: float = Field(strict=True, ge=-100_000, le=100_000, allow_inf_nan=False)
    evalMisses: int = Field(strict=True, ge=0)
    # Stockfish depth the end-of-prep positions were evaluated at; the
    # community leaderboard only ranks expected evaluations at depth 12 or more.
    depth: int | None = Field(default=None, strict=True, ge=1, le=99)
    explorerSettings: ExplorerSettings | None = None


@router.post("/api/studies/{study_id}/expected-score")
def save_expected_score(study_id: int, request: Request, payload: ExpectedScoreIn) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="not found")
    settings = payload.explorerSettings.model_dump()
    is_player = settings["database"] == "player"
    draw = max(0.0, 1.0 - payload.winRate - payload.lossProbability)
    updated = store.merge_study_stats(
        owner,
        study_id,
        {
            # "winProbability" is the expected score: wins plus half the draws.
            "winProbability": payload.winRate + 0.5 * draw,
            "winRate": payload.winRate,
            "lossProbability": payload.lossProbability,
            "coverage": payload.coverage,
            "winProbabilityCalculatedAt": datetime.now(UTC).isoformat(),
            "winProbabilityMovesFingerprint": study["movesFingerprint"],
            # One player's games exist only on Lichess's Explorer.
            "source": "lichess" if is_player else settings["source"],
            "database": settings["database"],
            "minRating": settings["minRating"],
            "player": settings.get("player") if is_player else None,
            "speeds": settings["speeds"],
            "nodesEvaluated": payload.nodesEvaluated,
            "explorerCalls": payload.explorerCalls,
        },
        # Recalculating with other settings makes them the study's settings.
        explorer_settings=settings,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    return updated


@router.post("/api/studies/{study_id}/expected-eval")
def save_expected_eval(study_id: int, request: Request, payload: ExpectedEvalIn) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if study is None:
        raise HTTPException(status_code=404, detail="not found")
    settings = payload.explorerSettings.model_dump() if payload.explorerSettings is not None else study["explorerSettings"]
    updated = store.merge_study_stats(
        owner,
        study_id,
        {
            "evalCp": payload.evalCp,
            "evalMisses": payload.evalMisses,
            "evalCalculatedAt": datetime.now(UTC).isoformat(),
            "evalOrigin": "local",
            "evalDepth": payload.depth,
            "evalMovesFingerprint": study["movesFingerprint"],
            # Kept apart from source/database/minRating/speeds, which describe
            # the expected score: the two can be calculated with different
            # Explorer settings.
            "evalSettings": {
                "source": settings["source"],
                "database": settings["database"],
                "minRating": settings["minRating"],
                "speeds": settings["speeds"],
                "player": settings.get("player") if settings["database"] == "player" else None,
            },
        },
        explorer_settings=settings if payload.explorerSettings is not None else None,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    return updated
