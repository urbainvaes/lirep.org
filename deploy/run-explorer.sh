#!/usr/bin/env sh
# Run the Guix-built Lichess opening explorer on 127.0.0.1:9002.
# The program is packaged; its database is data and stays outside the store.
#
# Usage: deploy/run-explorer.sh [database-dir]   (default: explorer/db)
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
db=${1:-$root/explorer/db}
# The package skips upstream's Lichess "blacklist" polling unless a token is
# configured (export EXPLORER_BEARER or EXPLORER_BEARER_FILE to enable it).
explorer=$(guix build -L "$root/deploy/guix" lila-openingexplorer)
exec "$explorer/bin/lila-openingexplorer" --bind 127.0.0.1:9002 --db "$db"
