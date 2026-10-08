# Local Lichess Opening Explorer

This directory holds a local Lichess opening-explorer instance, seeded with
the February, March and April 2016 archives of rated standard games (about
16.7 million games: 5,015,361, 5,801,234 and 5,922,667). At about 3 GB
compressed in total, these older months are intended as a test dataset, not a
substitute for Lichess's full historical Explorer. Other months can be added
with `download-month.sh YYYY-MM` and `import-month.sh YYYY-MM`; expect roughly
5 GB of database per month of 2016 data.

The games are published by Lichess under CC0. The Explorer implementation is
the upstream `lichess-org/lila-openingexplorer` project, licensed AGPL-3.0-or-
later; its license and attribution are preserved in `upstream/`.
The local importer skips an invalid game and continues its batch, rather than
discarding subsequent valid games in that batch.

The PGN archives and generated database are local data and are ignored by Git.
An archive is only needed while it is imported and can be deleted afterwards;
the database holds everything the Explorer serves. A 2016 archive is about
1 GB compressed. Upstream documents an imported
database below roughly three times the compressed PGN size.

## Launching (already built and imported)

If `explorer/db/` already has data in it (check with `ls explorer/db/` — this
repository's copy does), the one-time build/import below is already done and
you just need to start the server:

```sh
bash explorer/start-server.sh
```

This runs the already-built binary at
`explorer/upstream/target/release/lila-openingexplorer`, listening only on
`127.0.0.1:9002`, and serves whatever's already in `explorer/db/` — no
rebuild, download, or reimport needed. Leave it running in its own terminal
(or under a process manager); there's nothing else to start alongside it. It
logs occasional `blacklist request failed: 401 Unauthorized` lines on
stderr/`server.log` — that's the upstream project trying to sync Lichess's
moderation blacklist without an API key configured for it, and is harmless;
the Explorer itself still works.

Then point the backend at it, either inline:

```sh
cd backend
LOCAL_LICHESS_EXPLORER_URL=http://127.0.0.1:9002 .venv/bin/uvicorn app.main:app --reload
```

or by setting `LOCAL_LICHESS_EXPLORER_URL=http://127.0.0.1:9002` in
`backend/.env` (see `backend/.env.example`) so every future `uvicorn` launch
picks it up automatically. Choosing Lichess as a study's Explorer source
always uses the hosted Explorer regardless of this setting; Masters remains
available only for that source. If the local URL is configured, new studies
default to Lirep; otherwise they default to Lichess.

## One-time build and import

Only needed the first time, or to rebuild from scratch / import a different
month's archive.

The archive is downloaded with a resumable transfer and SHA-256
verification:

```sh
bash explorer/download-month.sh
```

Install Rust, Cargo, Clang/libclang, and liburing. From the repository root:

```sh
(cd explorer/upstream && cargo build --release)
(cd explorer/upstream/import-pgn && cargo build --release --bin import-lichess)
```

Wait for the archive download to finish, then start the server (see
"Launching" above):

```sh
bash explorer/start-server.sh
```

In another terminal, import the archive. Import can take many hours:

```sh
bash explorer/import-month.sh
```

Alternatively, `bash explorer/import-when-downloaded.sh` waits for the active
download to finish, verifies its checksum, and starts the import automatically.
