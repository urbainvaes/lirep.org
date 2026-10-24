#!/usr/bin/env sh
# Deploy Lirep's mobile app to the server in one step, apart from the site:
#   1. copy over what the app is built from: mobile/, the website's code it
#      shares (frontend/src/) and deploy/ (its Guix package and scripts)
#   2. build it there and put it live at /m/ (deploy/build-mobile.sh), with
#      no restart: the site keeps running
#
# The website itself is deployed with deploy/deploy.sh. Its source on the
# server may then be ahead of what it runs (frontend/src/), until the next
# deploy.sh.
#
# Loads tracked deploy/deploy.env defaults; environment variables can override them.
# Usage: deploy/deploy-mobile.sh [-n]
#   -n   show what would be copied, change nothing
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
config="$root/deploy/deploy.env"
if [ -r "$config" ]; then
  . "$config"
fi
host=${LIREP_DEPLOY_HOST:-}
remote_dir=${LIREP_DEPLOY_DIR:-}
state_dir=${LIREP_DEPLOY_STATE_DIR:-${LIREP_STATE_DIR:-}}
dry=""
for arg in "$@"; do
  case $arg in
    -n) dry="-n" ;;
    *) echo "Unexpected argument: $arg" >&2; exit 2 ;;
  esac
done

: "${host:?Set LIREP_DEPLOY_HOST}"
: "${remote_dir:?Set LIREP_DEPLOY_DIR}"
: "${state_dir:?Set LIREP_DEPLOY_STATE_DIR}"
case "$host" in
  *[!A-Za-z0-9@._-]*) echo "LIREP_DEPLOY_HOST contains unsupported characters" >&2; exit 2 ;;
esac
case "$remote_dir" in
  ''|-*|*[!A-Za-z0-9_./-]*) echo "LIREP_DEPLOY_DIR must be a simple relative or absolute path" >&2; exit 2 ;;
esac
case "$state_dir" in
  ''|-*|*[!A-Za-z0-9_./-]*) echo "LIREP_DEPLOY_STATE_DIR must be a simple relative or absolute path" >&2; exit 2 ;;
esac

echo "== Copying the mobile app's sources"
# -R keeps the paths below "./": mobile/ lands in <remote_dir>/mobile/.
rsync -aR --delete $dry --itemize-changes \
  --exclude=node_modules/ --exclude=/mobile/dist/ --exclude=__pycache__/ \
  "$root/./mobile/" "$root/./frontend/src/" "$root/./deploy/" \
  "$host:$remote_dir/"
[ -n "$dry" ] && exit 0

echo "== Building it on the server and putting it live"
ssh "$host" "cd '$remote_dir' && deploy/build-mobile.sh '$state_dir'"
echo "== Done: https://lirep.org/m/"
