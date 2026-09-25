#!/usr/bin/env sh
# Start the API on 127.0.0.1:8000. Configuration comes from backend/.env
# (see backend/.env.example); set LIREP_DB_PATH to keep the SQLite file
# somewhere persistent.
cd "$(dirname "$0")/../backend" || exit 1
exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --proxy-headers
