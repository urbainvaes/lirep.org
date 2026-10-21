"""Server storage for Stockfish and Explorer data. The browser keeps both in
IndexedDB (explorerClient.ts, evalCache.ts); for the users allowed server
storage (SERVER_CACHE_USERS), it also reads what it lacks from here and
saves what it computes or fetches here, so the data follows them across
devices and survives clearing the browser. The cache is shared: a position's
Explorer answer, or its evaluation at a depth, is the same whoever asks.
Only those users can read or write it, so nobody else can put data in it."""

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import store

router = APIRouter()

MAX_KEY = 400  # an Explorer cache key: source, settings and FEN
MAX_FEN = 100
MAX_ANSWER = 100_000  # an Explorer answer, as JSON
MAX_BATCH = 500
MAX_DEPTH = 60
MATE_CP = 100_000  # evalCache.ts's MATE_SCORE_CP


def _require_server_cache(request: Request) -> str:
    username = request.session.get("username")
    if not username or not request.session.get("access_token"):
        raise HTTPException(status_code=401, detail="not authenticated")
    if not store.server_cache_state(username)[1]:
        raise HTTPException(status_code=403, detail="server storage is off for this account")
    return username


class ExplorerLookupIn(BaseModel):
    keys: list[str] = Field(max_length=MAX_BATCH)


@router.post("/api/cache/explorer/lookup")
def explorer_lookup(payload: ExplorerLookupIn, request: Request) -> dict:
    _require_server_cache(request)
    keys = [key for key in payload.keys if len(key) <= MAX_KEY]
    return {"entries": store.explorer_cache_get(keys) if keys else {}}


class ExplorerEntryIn(BaseModel):
    key: str = Field(max_length=MAX_KEY)
    data: dict
    fetchedAt: float  # ms since the epoch


class ExplorerStoreIn(BaseModel):
    entries: list[ExplorerEntryIn] = Field(max_length=MAX_BATCH)


@router.put("/api/cache/explorer")
def explorer_store(payload: ExplorerStoreIn, request: Request) -> dict:
    _require_server_cache(request)
    entries = [(e.key, json.dumps(e.data, separators=(",", ":")), e.fetchedAt) for e in payload.entries]
    entries = [e for e in entries if len(e[1]) <= MAX_ANSWER]
    store.explorer_cache_put(entries)
    return {"stored": len(entries)}


class Position(BaseModel):
    fen: str = Field(max_length=MAX_FEN)
    depth: int = Field(ge=1, le=MAX_DEPTH)


class EvalLookupIn(BaseModel):
    positions: list[Position] = Field(max_length=MAX_BATCH)


@router.post("/api/cache/evals/lookup")
def evals_lookup(payload: EvalLookupIn, request: Request) -> dict:
    _require_server_cache(request)
    if not payload.positions:
        return {"evals": []}
    found = store.eval_cache_get([(p.fen, p.depth) for p in payload.positions])
    return {"evals": [{"fen": fen, "depth": depth, "cp": cp} for fen, depth, cp in found]}


class Evaluation(Position):
    cp: int = Field(ge=-MATE_CP, le=MATE_CP)  # White's point of view


class EvalStoreIn(BaseModel):
    evals: list[Evaluation] = Field(max_length=MAX_BATCH)


@router.put("/api/cache/evals")
def evals_store(payload: EvalStoreIn, request: Request) -> dict:
    _require_server_cache(request)
    store.eval_cache_put([(e.fen, e.depth, e.cp) for e in payload.evals])
    return {"stored": len(payload.evals)}


@router.get("/api/cache/size")
def size(request: Request) -> dict:
    if not request.session.get("username"):
        raise HTTPException(status_code=401, detail="not authenticated")
    return store.cache_size()


class ServerCacheIn(BaseModel):
    enabled: bool


@router.put("/api/profile/server-cache")
def set_server_cache(payload: ServerCacheIn, request: Request) -> dict:
    username = request.session.get("username")
    if not username or not request.session.get("access_token"):
        raise HTTPException(status_code=401, detail="not authenticated")
    if not store.server_cache_state(username)[0]:
        raise HTTPException(status_code=403, detail="server storage isn't available for this account")
    store.set_server_cache(username, payload.enabled)
    return {"enabled": payload.enabled}
