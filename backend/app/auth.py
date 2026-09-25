import base64
import hashlib
import logging
import secrets
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from .config import FRONTEND_URL, HTTP_TIMEOUT, LICHESS_CLIENT_ID, REDIRECT_URI
from .store import register_user

logger = logging.getLogger(__name__)

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


def _sign_in_error(message: str) -> RedirectResponse:
    # A full-page redirect to a static frontend page with a plain-English
    # explanation, instead of leaving the browser on /auth/callback showing
    # this backend's raw JSON error body (which is what a raised
    # HTTPException would render here). Also logged server-side, since the
    # message shown to the user is deliberately short on some internals
    # (raw exception text, exact status codes) that are more useful here
    # than on the page itself.
    logger.warning("sign-in failed: %s", message)
    return RedirectResponse(f"{FRONTEND_URL}/sign-in-error.html?message={quote(message)}")


def _lichess_error_detail(resp: httpx.Response) -> str:
    """A short, specific description of a non-200 response from lichess.org,
    pulling out whatever error text it sent rather than just a bare status
    code — Lichess's OAuth/API error bodies are usually
    `{"error": "...", "error_description": "..."}` or `{"error": "..."}`."""
    try:
        data = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}"
    detail = data.get("error_description") or data.get("error") or data.get("message")
    return f"HTTP {resp.status_code}: {detail}" if detail else f"HTTP {resp.status_code}"


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
        return _sign_in_error(f"Lichess sign-in was not completed: {error_description or error} (error code: {error}).")

    if not code or not state:
        missing = ", ".join(name for name, value in (("code", code), ("state", state)) if not value)
        return _sign_in_error(
            f"Lichess's redirect back was missing required parameter(s): {missing}. This usually means the "
            "sign-in link was opened again after already being used, or was cut off. Please try signing in again."
        )

    expected_state = request.session.pop("oauth_state", None)
    verifier = request.session.pop("oauth_verifier", None)
    if not expected_state or not verifier:
        return _sign_in_error(
            "No sign-in session was found for this request. The most common cause is starting the sign-in on one "
            'address (e.g. "localhost:5173") and being redirected back to a different one (e.g. "127.0.0.1:5173") '
            "— browsers treat those as separate sites, so the cookie set when you clicked Sign in isn't sent back. "
            "It can also happen if cookies are blocked for this site, or if too long passed on the lichess.org "
            "page before approving. Please reload the page at the same address you started from and try again."
        )
    if state != expected_state:
        return _sign_in_error(
            "This sign-in request doesn't match the one that was started (the link may have already been used, "
            "or a sign-in was started in another tab in the meantime). Please try signing in again."
        )

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
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
    except httpx.HTTPError as exc:
        return _sign_in_error(
            f"Could not reach lichess.org to complete sign-in ({type(exc).__name__}: {exc}). "
            "Please try again in a moment."
        )
    if token_resp.status_code != 200:
        return _sign_in_error(
            f"lichess.org rejected the sign-in request ({_lichess_error_detail(token_resp)}). Please try again."
        )

    access_token = token_resp.json()["access_token"]

    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
            account_resp = await client.get(ACCOUNT_URL, headers={"Authorization": f"Bearer {access_token}"})
    except httpx.HTTPError as exc:
        return _sign_in_error(
            f"Could not reach lichess.org to fetch your account ({type(exc).__name__}: {exc}). "
            "Please try again in a moment."
        )
    if account_resp.status_code != 200:
        return _sign_in_error(
            f"Could not retrieve your lichess.org account details ({_lichess_error_detail(account_resp)}). "
            "Please try again."
        )

    account = account_resp.json()
    request.session["access_token"] = access_token
    request.session["username"] = account["username"]
    request.session["title"] = account.get("title")
    register_user(account["username"])
    return RedirectResponse(FRONTEND_URL)


@router.get("/auth/logout")
async def logout(request: Request) -> RedirectResponse:
    token = request.session.pop("access_token", None)
    request.session.clear()
    if token:
        try:
            async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
                resp = await client.delete(TOKEN_URL, headers={"Authorization": f"Bearer {token}"})
            if resp.is_error:
                logger.warning("Lichess token revocation failed: HTTP %s", resp.status_code)
        except httpx.HTTPError as exc:
            logger.warning("Could not revoke Lichess token during logout: %s", type(exc).__name__)
    return RedirectResponse(FRONTEND_URL)


@router.get("/api/me")
async def me(request: Request) -> dict:
    username = request.session.get("username")
    if not username or not request.session.get("access_token"):
        return {"authenticated": False}
    return {"authenticated": True, "username": username, "title": request.session.get("title")}


RATED_SPEEDS = ("bullet", "blitz", "rapid", "classical")


@router.get("/api/profile")
async def profile(request: Request) -> dict:
    token = request.session.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="not authenticated")

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
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

    return {
        "username": data["username"],
        "title": data.get("title"),
        "userNumber": register_user(data["username"]),
        "ratings": ratings,
    }


DEFAULT_BOARD_THEME = {"theme": "brown", "pieceSet": "cburnett"}


@router.get("/api/board-theme")
async def board_theme(request: Request) -> dict:
    token = request.session.get("access_token")
    if not token:
        return DEFAULT_BOARD_THEME

    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(PREFERENCES_URL, headers={"Authorization": f"Bearer {token}"})
    if resp.status_code != 200:
        # Most commonly: an older session without the preference:read scope.
        return DEFAULT_BOARD_THEME

    prefs = resp.json().get("prefs", {})
    return {
        "theme": prefs.get("theme", DEFAULT_BOARD_THEME["theme"]),
        "pieceSet": prefs.get("pieceSet", DEFAULT_BOARD_THEME["pieceSet"]),
    }
