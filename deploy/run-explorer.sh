#!/usr/bin/env sh
# Run the Guix-built Lichess opening explorer on 127.0.0.1:9002.
# The program is packaged; its database is data and stays outside the store.
#
# Usage: deploy/run-explorer.sh [database-dir]   (default: explorer/db)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
db=${1:-$root/explorer/db}
# Upstream retries its Lichess "blacklist" request every 5 seconds forever
# when it fails (it needs a Lichess-issued token we do not have).  Point it
# at a closed local port so no traffic reaches lichess.org; set LILA_URL to
# override (for example with a real URL and EXPLORER_BEARER).
export LILA_URL=${LILA_URL:-http://127.0.0.1:1}
explorer=$(guix build -L "$root/deploy/guix" lila-openingexplorer)
exec "$explorer/bin/lila-openingexplorer" --bind 127.0.0.1:9002 --db "$db"
