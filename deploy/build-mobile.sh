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
# The app is installed in a Guix profile of its own. A profile keeps its
# build from being garbage-collected whatever user the daemon runs as (an
# unprivileged daemon can't follow --root links into a private home), and
# installing switches it to the new build at once, so the site never sees a
# missing one. The older generations are then dropped.
profile="/var/guix/profiles/per-user/$(id -un)/lirep-mobile"
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if ! guix package -L "$root/deploy/guix" -p "$profile" -i lirep-mobile >"$log" 2>&1; then
  cat "$log" >&2
  exit 1
fi
guix package -p "$profile" --delete-generations >/dev/null 2>&1 || true

# nginx serves $state/mobile/m: a link to the profile's app.
dir="$state/mobile"
if [ "$(readlink "$dir/m" 2>/dev/null || true)" != "$profile/share/lirep/mobile" ]; then
  ln -sfn "$profile/share/lirep/mobile" "$dir/m.new"
  mv -Tf "$dir/m.new" "$dir/m"
fi
# Links left by earlier versions of this script.
rm -f "$dir/current" "$dir/root-a" "$dir/root-b"
echo "== Live: $(readlink -f "$profile")"

# Check that the running nginx serves it (it doesn't if it was started
# before run-local.sh knew about /m/: restart the site once).
listen=${LIREP_LISTEN:-127.0.0.1:8080}
status=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://$listen/m/" || true)
case $status in
  200) echo "== Served at http://$listen/m/" ;;
  000) echo "== The site isn't running here; deploy/run-local.sh will serve it at /m/" ;;
  *) echo "!! http://$listen/m/ answers $status: restart the site (deploy/run-local.sh) so its nginx serves /m/" >&2 ;;
esac
