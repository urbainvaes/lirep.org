import os
import secrets

from dotenv import load_dotenv

load_dotenv()

# No pre-registration is required with Lichess for OAuth apps that use PKCE
# and a 127.0.0.1 redirect URI, so this works out of the box for local dev.
# Set LICHESS_CLIENT_ID / REDIRECT_URI in a .env file once this app is
# deployed somewhere other than 127.0.0.1.
#
# REDIRECT_URI points at the *frontend* dev server (proxied to /auth/callback
# on the backend, see frontend/vite.config.ts) rather than the backend port
# directly. That way the session cookie set during /auth/login and the one
# read back during /auth/callback are always on the exact same origin the
# page was loaded from — mixing "localhost" and "127.0.0.1" between the two
# would otherwise silently drop the cookie and fail with "invalid oauth state".
LICHESS_CLIENT_ID = os.getenv("LICHESS_CLIENT_ID", "lirep-dev")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://127.0.0.1:5173")
REDIRECT_URI = os.getenv("REDIRECT_URI", f"{FRONTEND_URL}/auth/callback")

# Falls back to a random secret generated at startup. That's fine for local
# dev (it just means sessions reset when the server restarts) but a stable
# SESSION_SECRET should be set via .env for anything longer-lived.
SESSION_SECRET = os.getenv("SESSION_SECRET") or secrets.token_hex(32)

# httpx's own default is 5s across connect/read/write/pool, which is tight
# enough that a brief network blip can fail an otherwise-fine login. Used for
# every httpx.AsyncClient() that talks to lichess.org.
HTTP_TIMEOUT = 10.0

# Optional local Lichess Explorer base URL, e.g. http://127.0.0.1:9002.
LOCAL_LICHESS_EXPLORER_URL = os.getenv("LOCAL_LICHESS_EXPLORER_URL", "").rstrip("/")
DEFAULT_EXPLORER_SOURCE = "lirep" if LOCAL_LICHESS_EXPLORER_URL else "lichess"
