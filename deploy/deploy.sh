#!/usr/bin/env sh
# Deploy lirep.org to the server in one step:
#   1. copy the source over (never the secrets, the database, or Explorer data)
#   2. build the Guix packages there, so the restart is quick
#   3. restart the app (and start the Explorer if it is not running) in tmux
#
# Loads tracked deploy/deploy.env defaults; environment variables can override them.
# Usage: deploy/deploy.sh [-n] [--no-restart] [--no-explorer]
#   -n             show what would be copied, change nothing
#   --no-restart   copy and build, but leave the running app alone
#   --no-explorer  restart the app but never start the Explorer (for example
#                  while its database is being replaced)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
config="$root/deploy/deploy.env"
if [ -r "$config" ]; then
  . "$config"
fi
host=${LIREP_DEPLOY_HOST:-}
remote_dir=${LIREP_DEPLOY_DIR:-}
state_dir=${LIREP_DEPLOY_STATE_DIR:-${LIREP_STATE_DIR:-}}
host_override=no
dry=""
restart=yes
explorer=yes
for arg in "$@"; do
  case $arg in
    -n) dry="-n" ;;
    --no-restart) restart=no ;;
    --no-explorer) explorer=no ;;
    --) host_override=yes ;;
    *)
      if [ "$host_override" = no ]; then
        host=$arg
        host_override=yes
      else
        echo "Unexpected argument: $arg" >&2
        exit 2
      fi
      ;;
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

echo "== Copying to the configured deployment target"
rsync -a --delete $dry --itemize-changes \
  --exclude=/.git/ --exclude=node_modules/ --exclude=.venv/ \
  --exclude=__pycache__/ --exclude=/frontend/dist/ \
  --exclude=/backend/.env --exclude='/backend/*.db*' \
  --exclude=/explorer/db --exclude=/explorer/data/ --exclude='/explorer/*.log' \
  --exclude=target/ --exclude='/Screenshot_*' \
  "$root/" "$host:$remote_dir/"
[ -n "$dry" ] && exit 0

echo "== Building packages on the server"
ssh "$host" "cd '$remote_dir' && guix build -L deploy/guix lirep-backend lirep-frontend lila-openingexplorer"

[ "$restart" = no ] && exit 0

echo "== Restarting"
# Runtime paths are supplied separately, never embedded in the repository.
ssh "$host" sh -s -- "$explorer" "$remote_dir" "$state_dir" <<'REMOTE'
  explorer=$1
  app_dir=$2
  state_dir=$3
  case "$state_dir" in
    /*) ;;
    *) state_dir="$HOME/$state_dir" ;;
  esac
  cd "$app_dir/deploy"

  # Stop the old app, then wait until it has really let go of its port (a
  # starting app that finds the port busy would otherwise die at once).
  tmux kill-session -t lirep-app 2>/dev/null || true
  i=0
  while curl -sf -m 1 http://127.0.0.1:8000/api/health >/dev/null 2>&1 && [ $i -lt 20 ]; do
    sleep 1; i=$((i+1))
  done
  if curl -sf -m 1 http://127.0.0.1:8000/api/health >/dev/null 2>&1; then
    echo "old app still answering after 20 s; stopping it"
    pkill -u "$USER" -f "[u]vicorn app.main" || true
    sleep 2
  fi

  # remain-on-exit keeps the window (and its output) if the app dies.
  tmux new-session -d -s lirep-app "LIREP_STATE_DIR='$state_dir' ./run-local.sh" \; set-option -t lirep-app remain-on-exit on

  # Wait for the app to answer through nginx before calling it a success.
  ok=no
  i=0
  while [ $i -lt 90 ]; do
    if curl -sf -m 2 http://127.0.0.1:8080/api/health >/dev/null 2>&1; then ok=yes; break; fi
    sleep 1; i=$((i+1))
  done
  if [ "$ok" != yes ]; then
    echo "!! The app did not come up within 90 s. Its output:"
    tmux capture-pane -p -t lirep-app 2>/dev/null | tail -30
    exit 1
  fi
  echo "app is answering"

  if [ "$explorer" = yes ] && ! pgrep -u "$USER" -f "[b]in/lila-openingexplorer" >/dev/null; then
    tmux new-session -d -s lirep-explorer "./run-explorer.sh"
    echo "started the Explorer"
  fi
  tmux ls
REMOTE
echo "== Done: https://lirep.org"
