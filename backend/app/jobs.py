"""A tiny in-memory job tracker for long-running, sequential HTTP-bound work
(evaluating a tree or walking the Opening Explorer), so the frontend can poll
a job's progress instead of blocking on one long request with no feedback.

In-memory and per-process by design: this app runs as a single uvicorn
worker for one user's own studies, so there's no need for persistence across
restarts or coordination across processes.
"""

import time
import uuid
from typing import Any

_JOB_TTL_SECONDS = 3600.0

_jobs: dict[str, dict[str, Any]] = {}


def _prune() -> None:
    cutoff = time.monotonic() - _JOB_TTL_SECONDS
    stale = [
        job_id
        for job_id, job in _jobs.items()
        if job["status"] != "running" and job.get("finishedAt", time.monotonic()) < cutoff
    ]
    for job_id in stale:
        del _jobs[job_id]


def create_job(owner: str, total: int | None) -> str:
    _prune()
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"owner": owner, "status": "running", "done": 0, "total": total, "result": None, "error": None}
    return job_id


def get_job(owner: str, job_id: str) -> dict[str, Any] | None:
    job = _jobs.get(job_id)
    if job is None or job["owner"] != owner:
        return None
    return job


def set_progress(job_id: str, done: int, total: int | None = None) -> None:
    job = _jobs.get(job_id)
    if job is None:
        return
    job["done"] = done
    if total is not None:
        job["total"] = total


def finish(job_id: str, result: Any) -> None:
    job = _jobs.get(job_id)
    if job is None:
        return
    job["status"] = "done"
    job["result"] = result
    job["finishedAt"] = time.monotonic()


def fail(job_id: str, error: str) -> None:
    job = _jobs.get(job_id)
    if job is None:
        return
    job["status"] = "error"
    job["error"] = error
    job["finishedAt"] = time.monotonic()
