#!/usr/bin/env bash
# Usage: download-month.sh [YYYY-MM]   (default: 2016-03)
# Downloads one month of Lichess standard rated games (CC0), resumable, and
# verifies it against the checksum published at database.lichess.org.
set -euo pipefail

month="${1:-2016-03}"
root="$(cd "$(dirname "$0")/.." && pwd)"
name="lichess_db_standard_rated_$month.pgn.zst"
archive="$root/explorer/data/$name"
checksum="$archive.sha256"
url="https://database.lichess.org/standard/$name"

mkdir -p "$(dirname "$archive")"
if [[ ! -f "$checksum" ]]; then
  curl --fail --silent --location https://database.lichess.org/standard/sha256sums.txt \
    | grep -F "  $name" > "$checksum"
fi
curl --fail --location --continue-at - --retry 12 --retry-delay 10 --output "$archive" "$url"
(cd "$(dirname "$archive")" && sha256sum --check "$checksum")
