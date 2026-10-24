#!/usr/bin/env sh
# Run lirep.org on this machine entirely from Guix-built packages:
#   nginx on http://127.0.0.1:8080  ->  static frontend + proxy to the API
#   uvicorn on 127.0.0.1:8000       ->  lirep-backend
#
# Set LIREP_LISTEN=0.0.0.0:8080 to accept connections from other machines.
#
# Usage: deploy/run-local.sh [state-dir]
# Set LIREP_STATE_DIR, LIREP_DEPLOY_STATE_DIR, or pass a state directory.
# Configuration is read from backend/.env if present (see .env.example);
# set FRONTEND_URL / REDIRECT_URI to http://127.0.0.1:8080 and
# /auth/callback on that origin.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
config="$root/deploy/deploy.env"
if [ -r "$config" ]; then
  . "$config"
fi
state=${1:-${LIREP_STATE_DIR:-${LIREP_DEPLOY_STATE_DIR:-}}}
if [ -z "$state" ]; then
  echo "Set LIREP_STATE_DIR or pass a state directory as the first argument." >&2
  exit 2
fi
case "$state" in
  /*) ;;
  *) state="$HOME/$state" ;;
esac
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
  # Text compresses several-fold (the studies' JSON, the scripts): much
  # quicker on a phone's connection.
  gzip on;
  gzip_types application/json application/javascript text/css image/svg+xml application/manifest+json;
  # Also through the server's front proxy, which by default forwards with
  # HTTP/1.0 (and may add a Via header).
  gzip_http_version 1.0;
  gzip_proxied any;
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
    # Pages must be fetched afresh on every visit: they name the hashed script
    # and style files, so a stale cached page keeps running an old version of
    # the site after a deploy. Re-checking isn't enough: files in the Guix
    # store all date from 1970, so nginx's validators (an ETag of date and
    # size, and Last-Modified) don't change when a page does, as a new build
    # only renames its scripts, and the browser is told its old copy is
    # current. Without validators it downloads the page each time. The hashed
    # files themselves are safe to cache.
    location ~ (\.html|/)\$ {
      add_header Cache-Control "no-cache";
      etag off;
      if_modified_since off;
    }
    # The mobile app (mobile/) at /m/: whatever deploy/build-mobile.sh last
    # linked into the state directory, so it's updated without a restart.
    # Its page is fetched afresh like the site's; its hashed files cached.
    location ^~ /m/ {
      root $state/mobile;
      try_files \$uri \$uri/ /m/index.html;
      # Its service worker too: a browser keeps an old one otherwise.
      location ~ (\.html|/|/sw\.js)\$ {
        add_header Cache-Control "no-cache";
        etag off;
        if_modified_since off;
      }
    }
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
