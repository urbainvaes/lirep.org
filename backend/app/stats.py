"""Saving a study's stats, calculated in the browser.

Both the expected score (with coverage) and the expected evaluation are
calculated by the Stats page itself: the Opening Explorer requests behind
them then come from the user's own browser and token, so each user stays
within their own Lichess rate limit (see explorer-cache.md). The backend
validates what it can and stores the results with the settings and moves
they were calculated from.
"""

from datetime import UTC, datetime
from typing import Annotated, Literal

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
# How the expected score values a line where the preparation ends: the
# Explorer's results, Stockfish's evaluation as an expected score, or the
# Explorer's results with Stockfish where they count too few games. See
# doc/expected-score.html.
LeafValue = Literal["explorer", "stockfish", "explorer-stockfish"]


class CalculationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The browser's actual calculation snapshot, not the latest study at save time.
    movesFingerprint: str = Field(pattern=r"^[0-9a-f]{16}$")
    side: Literal["white", "black"]


class ExpectedScoreIn(CalculationInput):
    # Missing from pages loaded before Stockfish could value lines' ends,
    # which send only the win and loss probabilities.
    score: Share | None = None
    # Unknown (None) once a line's end is valued with Stockfish.
    winRate: Share | None = None
    lossProbability: Share | None = None
    leafValue: LeafValue = "explorer"
    # Stockfish depth, when Stockfish values some lines' ends.
    depth: int | None = Field(default=None, strict=True, ge=1, le=99)
    # Hybrid's threshold: Stockfish values a line's end under this many
    # games (the frontend's MIN_LEAF_GAMES). Missing on Hybrid scores saved
    # before it was recorded, which used 50.
    leafGames: int | None = Field(default=None, strict=True, ge=1, le=1_000_000)
    stockfishLeaves: int = Field(default=0, strict=True, ge=0)
    # coverage[i]: share of games still in the tree after the opponent's
    # (i+1)th move from the starting point.
    coverage: list[Share] = Field(max_length=500)
    nodesEvaluated: int = Field(strict=True, ge=0)
    explorerCalls: int = Field(strict=True, ge=0)
    explorerSettings: ExplorerSettings

    @model_validator(mode="after")
    def _outcomes_add_up(self) -> "ExpectedScoreIn":
        if (self.winRate is None) != (self.lossProbability is None):
            raise ValueError("win and loss probabilities go together")
        if self.leafValue == "explorer" and self.winRate is None:
            raise ValueError("Explorer results give win and loss probabilities")
        if self.leafValue != "explorer" and self.depth is None:
            raise ValueError("Stockfish values need a depth")
        if self.winRate is not None and self.lossProbability is not None:
            if self.winRate + self.lossProbability > 1 + 1e-9:
                raise ValueError("win and loss probabilities add up to more than 1")
            # The expected score: wins plus half the draws.
            from_outcomes = (1 + self.winRate - self.lossProbability) / 2
            if self.score is None:
                self.score = from_outcomes
            elif abs(self.score - from_outcomes) > 1e-6:
                raise ValueError("the score doesn't match the win and loss probabilities")
        if self.score is None:
            raise ValueError("no score")
        return self


# The expected evaluation's method. 1: lines ending with the studied side's
# move were evaluated after each of the opponent's Explorer replies. 2: they
# are evaluated after the move itself, the same lines' ends as the expected
# score with Stockfish values. 3: as 2, each evaluation capped at ±10 pawns
# (a mate counts as 10). Evaluations from an older method are out of date,
# and not ranked.
EVAL_METHOD = 3


class ExpectedEvalIn(CalculationInput):
    evalCp: float = Field(strict=True, ge=-100_000, le=100_000, allow_inf_nan=False)
    evalMisses: int = Field(strict=True, ge=0)
    # Stockfish depth the end-of-prep positions were evaluated at; the
    # community leaderboard only ranks expected evaluations at depth 12 or more.
    depth: int | None = Field(default=None, strict=True, ge=1, le=99)
    explorerSettings: ExplorerSettings
    # Missing from pages loaded before method 2: method 1.
    method: int = Field(default=1, strict=True, ge=1, le=EVAL_METHOD)


def _save_stats(owner: str, study_id: int, payload: CalculationInput, updates: dict) -> dict:
    try:
        updated = store.merge_study_stats(
            owner, study_id, updates,
            expected_moves_fingerprint=payload.movesFingerprint,
            expected_side=payload.side,
        )
    except store.StudyStatsConflict:
        raise HTTPException(status_code=409, detail="Study changed. Reload the page and recalculate stats.") from None
    if updated is None:
        raise HTTPException(status_code=404, detail="not found")
    return updated


@router.post("/api/studies/{study_id}/expected-score")
def save_expected_score(study_id: int, request: Request, payload: ExpectedScoreIn) -> dict:
    owner = _require_owner(request)
    settings = payload.explorerSettings.model_dump()
    is_player = settings["database"] == "player"
    return _save_stats(
        owner,
        study_id,
        payload,
        {
            # "winProbability" is the expected score: wins plus half the draws.
            "winProbability": payload.score,
            "winRate": payload.winRate,
            "lossProbability": payload.lossProbability,
            "leafValue": payload.leafValue,
            "scoreDepth": payload.depth if payload.leafValue != "explorer" else None,
            "leafGames": payload.leafGames if payload.leafValue == "explorer-stockfish" else None,
            "stockfishLeaves": payload.stockfishLeaves,
            "coverage": payload.coverage,
            "winProbabilityCalculatedAt": datetime.now(UTC).isoformat(),
            "winProbabilityMovesFingerprint": payload.movesFingerprint,
            # One player's games exist only on Lichess's Explorer.
            "source": "lichess" if is_player else settings["source"],
            "database": settings["database"],
            "minRating": settings["minRating"],
            "player": settings.get("player") if is_player else None,
            "speeds": settings["speeds"],
            "nodesEvaluated": payload.nodesEvaluated,
            "explorerCalls": payload.explorerCalls,
        },
    )


@router.post("/api/studies/{study_id}/expected-eval")
def save_expected_eval(study_id: int, request: Request, payload: ExpectedEvalIn) -> dict:
    owner = _require_owner(request)
    settings = payload.explorerSettings.model_dump()
    return _save_stats(
        owner,
        study_id,
        payload,
        {
            "evalCp": payload.evalCp,
            "evalMisses": payload.evalMisses,
            "evalCalculatedAt": datetime.now(UTC).isoformat(),
            "evalOrigin": "local",
            "evalDepth": payload.depth,
            "evalMethod": payload.method,
            "evalMovesFingerprint": payload.movesFingerprint,
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
    )
