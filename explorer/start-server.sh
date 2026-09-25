#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
server="$root/explorer/upstream/target/release/lila-openingexplorer"

if [[ ! -x "$server" ]]; then
  printf 'Build the Explorer first: (cd explorer/upstream && cargo build --release)\n' >&2
  exit 1
fi

exec "$server" --bind 127.0.0.1:9002 --db "$root/explorer/db"
