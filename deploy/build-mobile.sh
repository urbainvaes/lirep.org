#!/usr/bin/env sh
# Build Lirep's mobile app (mobile/) with Guix and put it live at /m/, on
# this machine: the nginx that deploy/run-local.sh starts serves whatever is
# linked in the state directory, so the new version is served at once,
# without restarting anything. deploy/deploy-mobile.sh runs this on the
# server.
#
# Usage: deploy/build-mobile.sh [state-dir]
# The state directory is run-local.sh's: LIREP_STATE_DIR,
# LIREP_DEPLOY_STATE_DIR, or the first argument.
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
mkdir -p "$state/mobile"

echo "== Building the mobile app"
# --root keeps the build from being garbage-collected while it's served;
# building again replaces it, and the previous build can then be collected.
guix build -L "$root/deploy/guix" --root="$state/mobile/current" lirep-mobile >/dev/null

# nginx serves $state/mobile/m: a link into the current build, made once.
if [ ! -L "$state/mobile/m" ]; then
  ln -s current/share/lirep/mobile "$state/mobile/m"
fi
echo "== Live: $(readlink -f "$state/mobile/current")"

# Check that the running nginx serves it (it doesn't if it was started
# before run-local.sh knew about /m/: restart the site once).
listen=${LIREP_LISTEN:-127.0.0.1:8080}
status=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://$listen/m/" || true)
case $status in
  200) echo "== Served at http://$listen/m/" ;;
  000) echo "== The site isn't running here; deploy/run-local.sh will serve it at /m/" ;;
  *) echo "!! http://$listen/m/ answers $status: restart the site (deploy/run-local.sh) so its nginx serves /m/" >&2 ;;
esac
