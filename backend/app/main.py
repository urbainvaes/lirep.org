from fastapi import FastAPI
from starlette.middleware.sessions import SessionMiddleware

from .auth import router as auth_router
from .config import SESSION_SECRET
from .explorer import router as explorer_router
from .practice import router as practice_router
from .stats import router as stats_router
from .store import init_db
from .studies import router as studies_router

app = FastAPI(title="lirep.org")
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET, same_site="lax", https_only=False)
app.include_router(auth_router)
app.include_router(studies_router)
app.include_router(explorer_router)
app.include_router(stats_router)
app.include_router(practice_router)

init_db()


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}
