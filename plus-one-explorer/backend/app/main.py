from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from .auth import router as auth_router
from .config import SESSION_SECRET
from .store import init_db
from .studies import router as studies_router

app = FastAPI(title="Chesster")
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, same_site="lax", https_only=False)
app.include_router(auth_router)
app.include_router(studies_router)

init_db()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}
