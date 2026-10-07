# Backup: the first (venv-based) deployment approach

These are the first deployment files, kept for reference. They are superseded
by `deploy/manifest.scm`, `deploy/run-local.sh` and `deploy/guix/`.

## What this approach did

- `manifest.scm` listed Guix's own Python packages plus `node` and `nginx`,
  for use with `guix shell -m`.
- `run-backend.sh` ran uvicorn from the source tree (`backend/`).
- `nginx.conf` was a template to serve `frontend/dist` and proxy `/api/` and
  `/auth/` to uvicorn. It needed the `root` path and log directories edited
  by hand.
- The frontend was built outside Guix (`npm run build`) and `python-chess`
  had to be installed with pip, because it was not known to Guix.

It never ran: the manifest failed with `python-chess: unknown package`.

## Why it changed

The goal became packaging everything with Guix, so the same definitions can
later be used on a Guix System server. The new setup:

- **`deploy/guix/lirep/packages.scm`** is a local channel defining
  `python-chess` (missing from Guix), `lirep-backend` and `lirep-frontend`.
  The frontend's npm dependencies are fetched in a fixed-output derivation
  (its hash must be updated when `frontend/package-lock.json` changes).
- **`deploy/manifest.scm`** now uses these packages:
  `guix shell -L deploy/guix -m deploy/manifest.scm`.
- **`deploy/run-local.sh`** replaces `run-backend.sh` and `nginx.conf`. It
  builds the packages, generates an nginx config pointing at the built
  frontend in the store, and starts nginx (port 8080) and the backend
  (port 8000), with state in a caller-selected directory.
- **`LIREP_DB_PATH`** (in `backend/app/store.py`) lets the database live
  outside the source tree, which is needed once the backend is in the
  read-only store.

The old files are still useful if you want a quick run without Guix
packaging: a Python virtual environment for the backend and `npm run build`
for the frontend, with a hand-edited `nginx.conf`.
