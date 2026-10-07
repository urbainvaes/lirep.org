#!/usr/bin/env sh
# Run lirep.org on this machine entirely from Guix-built packages:
#   nginx on http://127.0.0.1:8080  ->  static frontend + proxy to the API
#   uvicorn on 127.0.0.1:8000       ->  lirep-backend
#
# Set LIREP_LISTEN=0.0.0.0:8080 to accept connections from other machines.
#
# Usage: deploy/run-local.sh [state-dir]
# Set LIREP_STATE_DIR or pass a state directory as the first argument.
# Configuration is read from backend/.env if present (see .env.example);
# set FRONTEND_URL / REDIRECT_URI to http://127.0.0.1:8080 and
# /auth/callback on that origin.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
state=${1:-${LIREP_STATE_DIR:-}}
if [ -z "$state" ]; then
  echo "Set LIREP_STATE_DIR or pass a state directory as the first argument." >&2
  exit 2
fi
mkdir -p "$state/logs" "$state/tmp"

backend=$(guix build -L "$root/deploy/guix" lirep-backend)
frontend=$(guix build -L "$root/deploy/guix" lirep-frontend)
nginx=$(guix build nginx | head -1)

cat > "$state/nginx.conf" <<CONF
daemon off;
pid $state/nginx.pid;
error_log $state/logs/error.log;
events {}
http {
  access_log $state/logs/access.log;
  include $nginx/share/nginx/conf/mime.types;
  types { application/manifest+json webmanifest; }
  client_body_temp_path $state/tmp/body;
  proxy_temp_path $state/tmp/proxy;
  fastcgi_temp_path $state/tmp/fcgi;
  uwsgi_temp_path $state/tmp/uwsgi;
  scgi_temp_path $state/tmp/scgi;
  server {
    listen ${LIREP_LISTEN:-127.0.0.1:8080};
    root $frontend/share/lirep/frontend;
    # Bots probe for paths that don't exist; the 404 is in the access log, no
    # need to repeat it in the error log.
    log_not_found off;
    # Pages must be re-checked on every visit: they name the hashed script and
    # style files, so a stale cached page keeps showing an old version of the
    # site (old links, old icon) after a deploy. The hashed files themselves
    # are safe to cache.
    location ~ (\.html|/)\$ { add_header Cache-Control "no-cache"; }
    location /api/  { proxy_pass http://127.0.0.1:8000; proxy_set_header Host \$host; proxy_set_header X-Forwarded-Proto \$scheme; }
    location /auth/ { proxy_pass http://127.0.0.1:8000; proxy_set_header Host \$host; proxy_set_header X-Forwarded-Proto \$scheme; }
  }
}
CONF

# A previous run may have left its nginx behind (nginx treats the SIGHUP that
# tmux sends when a session is killed as "reload", not "quit"), and it would
# keep the port, so stop it first.
if [ -f "$state/nginx.pid" ] && kill -0 "$(cat "$state/nginx.pid")" 2>/dev/null; then
  echo "Stopping a leftover nginx ($(cat "$state/nginx.pid"))"
  kill -QUIT "$(cat "$state/nginx.pid")"
  sleep 1
fi

cd "$root/backend"   # so backend/.env is picked up
# An explicit LIREP_DB_PATH (environment or backend/.env) wins over the default.
if [ -z "${LIREP_DB_PATH:-}" ] && ! grep -qs '^LIREP_DB_PATH=' .env; then
  export LIREP_DB_PATH="$state/lirep.db"
fi
"$backend/bin/lirep-backend" &
api=$!
# -e/-p: nginx opens its compiled-in (read-only, store) error log before
# reading the config, which prints a harmless but alarming warning.
"$nginx/sbin/nginx" -p "$state/" -e "$state/logs/error.log" -c "$state/nginx.conf" &
web=$!
trap 'kill $api 2>/dev/null; kill -QUIT $web 2>/dev/null' EXIT INT TERM HUP
wait $web
