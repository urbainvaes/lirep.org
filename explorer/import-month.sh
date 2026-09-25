#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
archive="$root/explorer/data/lichess_db_standard_rated_2016-03.pgn.zst"
checksum="$archive.sha256"
importer="$root/explorer/upstream/import-pgn/target/release/import-lichess"

if [[ ! -f "$archive" ]]; then
  printf 'Missing archive: %s\n' "$archive" >&2
  exit 1
fi
if [[ ! -x "$importer" ]]; then
  printf 'Build the importer first: (cd explorer/upstream/import-pgn && cargo build --release --bin import-lichess)\n' >&2
  exit 1
fi

cd "$(dirname "$archive")"
sha256sum --check "$checksum"
exec "$importer" --endpoint http://127.0.0.1:9002 "$archive"
