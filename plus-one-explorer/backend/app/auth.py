import base64
import hashlib
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from .config import FRONTEND_URL, LICHESS_CLIENT_ID, REDIRECT_URI

AUTHORIZE_URL = "https://lichess.org/oauth"
TOKEN_URL = "https://lichess.org/api/token"
ACCOUNT_URL = "https://lichess.org/api/account"
PREFERENCES_URL = "https://lichess.org/api/account/preferences"

# preference:read is needed to read the user's board theme / piece set
# (see /api/board-theme below). Requesting it here means anyone who logged
# in before this scope was added needs to sign out and back in once.
OAUTH_SCOPE = "preference:read"

router = APIRouter()


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _new_pkce_pair() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


@router.get("/auth/login")
def login(request: Request) -> RedirectResponse:
    verifier, challenge = _new_pkce_pair()
    state = secrets.token_urlsafe(16)
    request.session["oauth_verifier"] = verifier
    request.session["oauth_state"] = state

    params = {
        "response_type": "code",
        "client_id": LICHESS_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "state": state,
        "scope": OAUTH_SCOPE,
    }
    return RedirectResponse(f"{AUTHORIZE_URL}?{urlencode(params)}")


@router.get("/auth/callback")
async def callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> RedirectResponse:
    if error:
        # Lichess sends this instead of `code` whenever authorization didn't
        # succeed (denied consent, invalid scope, etc.) — surface the real
        # reason instead of failing on a missing `code` param.
        raise HTTPException(status_code=400, detail=f"lichess authorization failed: {error_description or error}")

    if not code or not state:
        raise HTTPException(status_code=400, detail="missing code or state in lichess redirect")

    expected_state = request.session.pop("oauth_state", None)
    verifier = request.session.pop("oauth_verifier", None)
    if not expected_state or state != expected_state or not verifier:
        raise HTTPException(status_code=400, detail="invalid oauth state")

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": REDIRECT_URI,
                "client_id": LICHESS_CLIENT_ID,
            },
        )
    if token_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="lichess token exchange failed")

    access_token = token_resp.json()["access_token"]

    async with httpx.AsyncClient() as client:
        account_resp = await client.get(ACCOUNT_URL, headers={"Authorization": f"Bearer {access_token}"})
    if account_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="lichess account fetch failed")

    request.session["access_token"] = access_token
    request.session["username"] = account_resp.json()["username"]
    return RedirectResponse(FRONTEND_URL)


@router.get("/auth/logout")
async def logout(request: Request) -> RedirectResponse:
    token = request.session.pop("access_token", None)
    request.session.clear()
    if token:
        async with httpx.AsyncClient() as client:
            await client.delete(TOKEN_URL, headers={"Authorization": f"Bearer {token}"})
    return RedirectResponse(FRONTEND_URL)


@router.get("/api/me")
async def me(request: Request) -> dict:
    token = request.session.get("access_token")
    if not token:
        return {"authenticated": False}

    async with httpx.AsyncClient() as client:
        resp = await client.get(ACCOUNT_URL, headers={"Authorization": f"Bearer {token}"})
    if resp.status_code != 200:
        return {"authenticated": False}

    data = resp.json()
    return {"authenticated": True, "username": data["username"], "title": data.get("title")}


RATED_SPEEDS = ("bullet", "blitz", "rapid", "classical")


@router.get("/api/profile")
async def profile(request: Request) -> dict:
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")

    async with httpx.AsyncClient() as client:
        resp = await client.get(ACCOUNT_URL, headers={"Authorization": f"Bearer {token}"})
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="lichess account fetch failed")

    data = resp.json()
    perfs = data.get("perfs", {})
    ratings = {
        speed: {
            "rating": perfs[speed]["rating"],
            "games": perfs[speed].get("games", 0),
            "provisional": bool(perfs[speed].get("prov", False)),
        }
        for speed in RATED_SPEEDS
        if speed in perfs
    }

    return {"username": data["username"], "title": data.get("title"), "ratings": ratings}


DEFAULT_BOARD_THEME = {"theme": "brown", "pieceSet": "cburnett"}


@router.get("/api/board-theme")
async def board_theme(request: Request) -> dict:
    token = request.session.get("access_token")
    if not token:
        return DEFAULT_BOARD_THEME

    async with httpx.AsyncClient() as client:
        resp = await client.get(PREFERENCES_URL, headers={"Authorization": f"Bearer {token}"})
    if resp.status_code != 200:
        # Most commonly: an older session without the preference:read scope.
        return DEFAULT_BOARD_THEME

    prefs = resp.json().get("prefs", {})
    return {
        "theme": prefs.get("theme", DEFAULT_BOARD_THEME["theme"]),
        "pieceSet": prefs.get("pieceSet", DEFAULT_BOARD_THEME["pieceSet"]),
    }
