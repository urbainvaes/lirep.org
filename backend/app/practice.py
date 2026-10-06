"""Practice mode: drilling a study's own-side moves, with a per-position
knowledge score that fades over time. See practice.md for the full design
writeup this implements.

Unlike the Stats page's expected-score walk (which works *backward* from leaves to
compute an expectation), everything here walks *forward* from a study's
effective starting point, since drilling is about enumerating and grading
individual decisions, not aggregating values.
"""

import math
from datetime import UTC, datetime
from typing import Literal

import chess
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from . import store
from .stats import _get_node, _resolve_start_node_id, _sans_to

router = APIRouter()

# See practice.md §3/§8: hard-coded for v1 rather than a per-profile setting,
# since nothing else in the shipped app reads a profile file yet.
TAU0_DAYS = 1.0
RETENTION_FLOOR = 0.80
SESSION_SIZE = 20


def _require_owner(request: Request) -> str:
    username = request.session.get("username")
    if not username:
        raise HTTPException(status_code=401, detail="not authenticated")
    return username


def _drill_item_nodes(tree: dict, start_node_id: int, side: Literal["white", "black"]) -> list[int]:
    """Every node reachable from start_node_id whose move was played by the
    studied side — i.e. every position you'd need to recall the answer to.
    Walks the *entire* tree (every opponent variation, not just the
    highest-probability line — unlike stats.py's walks, there's no
    probability weighting here, just enumeration), in the same main-line-
    first, depth-first order the Study editor's move list renders in."""
    items: list[int] = []

    def walk(node_id: int, board: chess.Board) -> None:
        if board.outcome() is not None:
            return
        studied_side_to_move = (board.turn == chess.WHITE) == (side == "white")
        node = _get_node(tree, node_id)
        for child_id in node["children"]:
            child = _get_node(tree, child_id)
            child_board = board.copy()
            child_board.push_san(child["san"])
            if studied_side_to_move:
                items.append(child_id)
            walk(child_id, child_board)

    start_board = chess.Board()
    for san in _sans_to(tree, start_node_id):
        start_board.push_san(san)
    walk(start_node_id, start_board)
    return items


def _retention(tau_days: float, last_seen_at: str) -> float:
    last_seen = datetime.fromisoformat(last_seen_at)
    t_days = (datetime.now(UTC) - last_seen).total_seconds() / 86400.0
    return math.exp(-t_days / tau_days)


def knowledge(state: dict | None) -> float | None:
    """0..1, or None if this position has never been attempted ("Not
    started" in the UI — practice.md §3). Deliberately never stored: always
    recomputed from streak/tau_days/last_seen_at plus "now", so tuning the
    decay formula later needs no migration."""
    if state is None:
        return None
    return (state["streak"] / 3) * _retention(state["tau_days"], state["last_seen_at"])


def is_due(state: dict | None) -> bool:
    """New (never-attempted) positions are their own queue category — see
    build_queue — not "due", so this is False for them."""
    if state is None:
        return False
    return _retention(state["tau_days"], state["last_seen_at"]) < RETENTION_FLOOR


def apply_answer(prev: dict | None, correct: bool) -> tuple[int, float]:
    """(new_streak, new_tau_days) — practice.md §3. A wrong answer always
    resets fully, whether or not this position had a history yet. A correct
    answer starts the stability at tau0 on the very first attempt, then
    doubles it (half-life regression) on every subsequent correct rep."""
    if not correct:
        return 0, TAU0_DAYS
    if prev is None:
        return 1, TAU0_DAYS
    return min(prev["streak"] + 1, 3), prev["tau_days"] * 2.0


def _study_summary(owner: str, study: dict) -> dict:
    start_node_id = _resolve_start_node_id(study)
    items = _drill_item_nodes(study["tree"], start_node_id, study["side"])
    states = store.get_practice_states(owner, study["id"])

    due_count = sum(1 for node_id in items if is_due(states.get(node_id)))
    new_count = sum(1 for node_id in items if node_id not in states)
    # Never-attempted positions count as 0 knowledge here (not excluded from
    # the average) — an aggregate that ignored them would overstate how
    # ready the study actually is by hiding how much of it hasn't been
    # touched yet.
    scores = [knowledge(states.get(node_id)) or 0.0 for node_id in items]
    aggregate = (sum(scores) / len(scores)) if scores else None

    return {
        "totalItems": len(items),
        "dueCount": due_count,
        "newCount": new_count,
        "aggregateKnowledge": aggregate,
    }


@router.get("/api/practice/summary")
def practice_summary_all(request: Request) -> dict[str, dict]:
    owner = _require_owner(request)
    return {str(study["id"]): _study_summary(owner, study) for study in store.list_studies(owner)}


@router.get("/api/studies/{study_id}/practice/queue")
def practice_queue(study_id: int, request: Request) -> dict:
    """Node ids to drill this session: due items first (staler retention
    first), then never-attempted items, capped at SESSION_SIZE. If neither
    exists, falls back to whatever isn't already at 100% knowledge yet (or,
    failing that, everything) — see practice.md §5. The frontend walks the
    tree itself (it already has the full tree from GET /api/studies/{id})
    and prompts only at the nodes in this list, auto-playing the rest — so
    this list isn't just *which* nodes to ask about, it's also what decides
    *where the session starts feeling like it's actually testing you*."""
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="not found")

    start_node_id = _resolve_start_node_id(study)
    items = _drill_item_nodes(study["tree"], start_node_id, study["side"])
    states = store.get_practice_states(owner, study_id)

    due = [node_id for node_id in items if is_due(states.get(node_id))]
    due.sort(key=lambda node_id: states[node_id]["last_seen_at"])
    new = [node_id for node_id in items if node_id not in states]

    queue = due + new
    if not queue and items:
        # Nothing is due and nothing is new, but practice shouldn't be
        # gated by the schedule if you want to drill anyway — there's no
        # reason to disable the whole tab just because the spaced-repetition
        # algorithm is satisfied for now. Offer a voluntary review instead —
        # but only of whatever hasn't already reached a full, rounded 100%
        # (see knowledge()). Queuing everything indiscriminately would select
        # every drill-item node in the line, and since the frontend's walk
        # only *prompts* at selected nodes (everything else is silently
        # auto-played — see practice.md §5), that would force you to
        # re-answer a long fully-mastered prefix before ever reaching
        # whatever's actually worth reviewing. Excluding maxed-out nodes
        # means that prefix is no longer selected, so the walk auto-plays
        # straight through it and the session starts right at the first
        # move that isn't already perfect.
        not_full = [
            node_id for node_id in items if round((knowledge(states.get(node_id)) or 0.0) * 100) < 100
        ]
        # Unless literally everything is at 100% — then there's nothing left
        # to prioritize, so offer the whole thing anyway (this is exactly
        # the case the practice-session UI's 100% celebration covers).
        pool = not_full if not_full else items
        queue = sorted(pool, key=lambda node_id: states[node_id]["last_seen_at"])

    return {"nodeIds": queue[:SESSION_SIZE]}


class AttemptIn(BaseModel):
    nodeId: int
    correct: bool


@router.post("/api/studies/{study_id}/practice/attempt")
def record_attempt(study_id: int, payload: AttemptIn, request: Request) -> dict:
    owner = _require_owner(request)
    study = store.get_study(owner, study_id)
    if not study:
        raise HTTPException(status_code=404, detail="not found")
    if str(payload.nodeId) not in study["tree"]["nodes"]:
        raise HTTPException(status_code=400, detail="unknown node")

    start_node_id = _resolve_start_node_id(study)
    if payload.nodeId not in _drill_item_nodes(study["tree"], start_node_id, study["side"]):
        raise HTTPException(status_code=400, detail="not a drill item for this study")

    states = store.get_practice_states(owner, study_id)
    prev = states.get(payload.nodeId)
    streak, tau_days = apply_answer(prev, payload.correct)
    now = datetime.now(UTC).isoformat()
    store.upsert_practice_state(owner, study_id, payload.nodeId, streak, tau_days, now)

    # Retention is exp(0) = 1.0 immediately after an attempt, so knowledge
    # right now is exactly streak/3 — no need to round-trip through
    # _retention for a "days since last_seen_at" that's ~0.
    return {"streak": streak, "tauDays": tau_days, "knowledge": streak / 3}
