#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
archive="$root/explorer/data/lichess_db_standard_rated_2016-03.pgn.zst"
checksum="$archive.sha256"
expected_bytes=1042258644

while [[ ! -f "$archive" ]]; do sleep 30; done
while :; do
  actual_bytes="$(stat -c %s "$archive")"
  if (( actual_bytes > expected_bytes )); then
    printf 'Archive is larger than expected (%s bytes).\n' "$actual_bytes" >&2
    exit 1
  fi
  (( actual_bytes == expected_bytes )) && break
  sleep 30
done

(cd "$(dirname "$archive")" && sha256sum --check "$checksum")
until curl --fail --silent http://127.0.0.1:9002/monitor >/dev/null; do sleep 10; done
exec bash "$root/explorer/import-month.sh"
