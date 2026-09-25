# Local Lichess Opening Explorer

This directory holds a local Lichess opening-explorer instance and the March
2016 archive of 5,801,234 rated standard games used to seed it. At about 1.04
GB compressed, this older month is intended as a test dataset, not a substitute
for Lichess's full historical Explorer.

The games are published by Lichess under CC0. The Explorer implementation is
the upstream `lichess-org/lila-openingexplorer` project, licensed AGPL-3.0-or-
later; its license and attribution are preserved in `upstream/`.
The local importer skips an invalid game and continues its batch, rather than
discarding subsequent valid games in that batch.

The PGN archive and generated database are local data and are ignored by Git.
The archive is about 1.04 GB compressed. Upstream documents an imported
database below roughly three times the compressed PGN size.

## Build and import

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

Wait for the archive download to finish, then start the server:

```sh
bash explorer/start-server.sh
```

In another terminal, import the archive. Import can take many hours:

```sh
bash explorer/import-month.sh
```

Alternatively, `bash explorer/import-when-downloaded.sh` waits for the active
download to finish, verifies its checksum, and starts the import automatically.

The server listens only on localhost at port 9002. Set
`LOCAL_LICHESS_EXPLORER_URL=http://127.0.0.1:9002` in the backend environment
to make Lirep available in the source selector. Choosing Lichess always uses
the hosted Explorer; Masters remains available only for that source. If the
local URL is configured, new studies default to Lirep; otherwise they default
to Lichess.

For example, start the app backend with the local database enabled using:

```sh
cd backend
LOCAL_LICHESS_EXPLORER_URL=http://127.0.0.1:9002 .venv/bin/uvicorn app.main:app --reload
```
