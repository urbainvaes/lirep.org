# Lirep

Lirep is a web app for building and training chess opening repertoires. It
combines a Lichess-backed Opening Explorer with local Stockfish analysis to
show how a repertoire performs against real game data, and gives you a way to
practice the moves you have prepared.

The project is an independent, open-source service; it is not affiliated with
Lichess. The live site is [lirep.org](https://lirep.org).

## What it does

- **Build studies:** create a named repertoire for White or Black, add a main
  line and opponent variations on a chessboard, comment on positions, and set
  an optional starting point. Changes auto-save to SQLite.
- **Explore openings:** browse Lichess Players or Masters data, filter by
  rating and time control, and add a move to your study from the explorer.
  You can also use the optional local Lirep Explorer archive.
- **Analyze:** run Stockfish in the browser to see candidate moves and
  calculate the expected evaluation at the end of your preparation. The Stats
  page also calculates expected score and how often games remain inside your
  repertoire (coverage).
- **Practice:** drill your own prepared moves. Sessions prioritize new and due
  positions, and each position's knowledge score fades over time.
- **Share:** make studies available in the Community pages, browse public
  profiles and opening leaderboards, and import another player's study.

<a id="2-core-idea"></a>

## How it works

The Explorer provides the observed frequencies and results for moves in a
selected player pool. For analysis, Lirep follows the study's prepared moves
and weights opponent replies by those frequencies. Coverage and expected score
use observed game data; expected evaluation uses local Stockfish scores at
positions where preparation ends. This keeps the metrics tied to both the
repertoire you entered and the pool you selected.

### The study page

A study is a tree of chess positions, with a main line and variations. Moves
can be played on the board or selected from the Opening Explorer. At each
position where it is your prepared side to move, the study allows one prepared
move; opponent replies can branch. The side is chosen when the study is
created. The optional starting point tells Stats and Practice where to begin.

The editor's Stockfish analysis runs locally in a Web Worker using the bundled
WASM engine. Explorer settings (data source, database, rating threshold and
time controls) are saved per study. See the [Studies guide](frontend/doc/studies.html)
and [starting-point notes](starting-point.md).

### The Stats page

Stats assumes you always play your prepared move and weights opponent replies
by their frequency in the selected Explorer pool. It reports:

- **Expected score:** the expected fraction of a point, estimated from
  Explorer win/draw/loss results.
- **Coverage:** the share of games that remain in your prepared tree after
  each opponent reply.
- **Expected evaluation:** a locally calculated Stockfish evaluation at the
  end of preparation, weighted by Explorer move frequency.

Expected score and coverage use game outcomes, not engine evaluations.
Expected evaluation is calculated in your browser; positions are cached in
that browser's IndexedDB and are not synced between devices. Calculations are
manual and can be run separately. These are estimates: Explorer data omits
some moves and the result depends on the selected pool and your study tree.
See [stats.md](stats.md) for calculation details and assumptions.

### The Practice tab

Practice drills only the studied side's moves; opponent replies are played for
you. Sessions combine positions due for review with positions you have not
practiced yet, up to 20 items. A position's knowledge score is based on its
correct-answer streak and a simple forgetting curve. Practice state is stored
per account, study and position in SQLite. See [practice.md](practice.md) for
the implementation and design details.

### Community

The Community pages list registered players and studies their owners have
shared. Opening leaderboards rank comparable results separately for White and
Black, using either Lichess data or the local Lirep archive. Shared studies
can be viewed without editing and copied into your own account when signed in.

## Run locally

The development setup uses Python for the FastAPI backend and Node/npm for the
static Vite frontend. You need Python 3, Node.js/npm, and network access for
Lichess sign-in and hosted Explorer requests.

In one terminal, install and start the backend:

```sh
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload
```

In another terminal, install and start the frontend:

```sh
cd frontend
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies `/api` and `/auth` to the backend
on port 8000. Local Lichess OAuth uses PKCE and the default `127.0.0.1`
callback, so no Lichess app registration is needed. Use the same host and port
throughout sign-in; `localhost` and `127.0.0.1` are different origins.

The backend creates `backend/lirep.db` on first start unless `LIREP_DB_PATH`
is set. For tests, from `backend/` run:

```sh
.venv/bin/python -m unittest discover -s tests
```

Build the static frontend with `cd frontend && npm run build`; Vite writes the
result to `frontend/dist/`.

## Configuration

The backend reads environment variables and, when present, `backend/.env`.
`backend/.env.example` lists the available settings. The main options are:

| Variable | Purpose |
| --- | --- |
| `FRONTEND_URL` | Frontend origin used for redirects; defaults to `http://127.0.0.1:5173`. |
| `REDIRECT_URI` | Lichess OAuth callback; defaults to `${FRONTEND_URL}/auth/callback`. |
| `LICHESS_CLIENT_ID` | OAuth client ID; defaults to `lirep-dev` for local development. |
| `SESSION_SECRET` | Stable secret for signing sessions. Set a strong value for any persistent deployment; the development fallback changes on restart. |
| `SESSION_HTTPS_ONLY` | Override whether the session cookie is HTTPS-only. By default it follows whether `FRONTEND_URL` uses HTTPS. |
| `LIREP_DB_PATH` | SQLite database path. Defaults to `backend/lirep.db`. |
| `LOCAL_LICHESS_EXPLORER_URL` | Optional local Explorer base URL, e.g. `http://127.0.0.1:9002`. When set, Lirep is available as a source and is the default for new studies. |
| `MAX_USERS` | Sign-in limit for a deployment; defaults to 100. Set to `0` for no limit. |

For a public deployment, set a stable `SESSION_SECRET`, the public
`FRONTEND_URL` and matching `REDIRECT_URI`, and ensure HTTPS is configured
correctly. Do not use the development defaults as production secrets.

## Optional local Opening Explorer

The optional local source is the upstream Lichess Opening Explorer, packaged
and run from the `explorer/` directory. The checked-in data covers rated
standard games from February to April 2016; it is a small test archive, not a
replacement for Lichess's full Explorer. To run an already-built local
instance, follow [`explorer/README.md`](explorer/README.md), then set
`LOCAL_LICHESS_EXPLORER_URL=http://127.0.0.1:9002` in `backend/.env` and
restart the backend. Lichess-hosted Players and Masters remain available
without it.

Lichess's Explorer is queried from each user's browser, with their own
token, so every user stays within their own rate limit: one request at a
time, at least 500 ms apart, pausing a minute after a 429. Its responses are
cached in the browser (30 days, 24 hours for an individual player's games);
local Lirep responses are fetched fresh through the backend. Stockfish evaluations are cached separately in the local
browser. More detail is in [explorer-cache.md](explorer-cache.md).

## Deployment

The current deployment setup packages the backend and built frontend with
Guix and serves them through nginx. To run that stack locally, use
`deploy/run-local.sh` (default HTTP port `8080`; it reads the tracked
`deploy/deploy.env` defaults or accepts a state directory argument). See
[`deploy/manifest.scm`](deploy/manifest.scm) and
[`deploy/guix/lirep/packages.scm`](deploy/guix/lirep/packages.scm) for the
package definitions. `deploy/deploy.sh` reads the remote host and directories
from the tracked `deploy/deploy.env` defaults (or environment variables); it
syncs that file so the remote runner can read its state-directory setting too.
The older virtualenv-based approach under `deploy/backup-venv-approach/` is
retained for reference and is superseded by the Guix setup.

## Project layout

```text
backend/app/       FastAPI routes, SQLite storage, Explorer and stats logic
backend/tests/     Backend tests
frontend/          Multi-page TypeScript/Vite app and bundled Stockfish WASM
frontend/doc/      In-app user guides
explorer/          Optional local Lichess Explorer and archive instructions
deploy/            Guix packages and local/remote deployment scripts
```

Useful implementation notes: [stats.md](stats.md), [practice.md](practice.md),
[explorer-cache.md](explorer-cache.md), and [starting-point.md](starting-point.md).

## License

Lirep is licensed under the [GNU AGPL-3.0-or-later](LICENSE). The bundled
Stockfish engine and other third-party components retain their respective
licenses; see their accompanying license files and the About page.
