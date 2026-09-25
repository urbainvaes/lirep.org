#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
archive="$root/explorer/data/lichess_db_standard_rated_2016-03.pgn.zst"
checksum="$archive.sha256"
url="https://database.lichess.org/standard/lichess_db_standard_rated_2016-03.pgn.zst"

curl --fail --location --continue-at - --retry 12 --retry-delay 10 --output "$archive" "$url"
(cd "$(dirname "$archive")" && sha256sum --check "$checksum")
