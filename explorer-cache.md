# Opening Explorer and evaluation caches

Companion to the [Opening Explorer panel](README.md#the-study-page) and
[stats.md's calculations](stats.md#4-two-calculations). Where each piece of
data lives:

| Data | Storage and scope | Lifetime |
| --- | --- | --- |
| Lichess Explorer responses | Browser IndexedDB `lirep-explorer`, per browser profile | 30 days; 24 hours for the player database |
| Lirep Explorer (2016 sample) responses | Not cached: the local Explorer is unlimited and never changes | — |
| Resolved default rating bucket (for a new study's picker) | Backend `rating_cache`, per username | 1-hour TTL; stale fallback on refresh failure |
| Stockfish position evals | Browser IndexedDB `lirep-position-evals`, keyed by `[username, fen]` | Until browser data is cleared; no sync |

Older databases may still contain the legacy `cloud_eval_cache` table, but
nothing reads or writes it. There is **no Lichess Cloud Eval fallback**.

## Lichess's Explorer is queried from the browser

Lichess's Opening Explorer (`explorer.lichess.org`) is rate-limited and needs
a Lichess token. Every caller — the Study editor's panel, the shared-opening
viewer, and both Stats-page calculations — goes through
`fetchExplorerData` in `frontend/src/explorerClient.ts`, which asks Lichess
**directly from the user's browser**, with the user's own token (fetched
once per page from `GET /api/lichess-token`; its only scope is
`preference:read`). Lichess allows this: it answers cross-origin requests
from any site, including with an `Authorization` header.

This matters because Lichess limits requests per IP address and per token.
When the backend proxied every request, all users shared lirep.org's single
IP and one user's large calculation could get everyone rate-limited. Now
each user spends only their own allowance. For the same reason, the
expected score is calculated in the browser, like the expected evaluation:
see [stats.md](stats.md). The backend only stores the results it is sent.

The local Lirep Explorer (the 2016 sample) is still reached through
`GET /api/explorer`, which serves nothing else.

## Pacing: one request at a time, half a second apart

Lichess's API guidelines ask clients to make one request at a time and,
after an HTTP 429, to wait a minute before trying again. `explorerClient.ts`
enforces this for all of a browser tab's Lichess Explorer requests:

- **One at a time.** Requests wait in a queue; the next one is sent only
  when the previous answer has arrived.
- **At least 500 ms apart** (`EXPLORER_REQUEST_GAP_MS`), measured from the
  end of one request to the start of the next, so a calculation walking a
  large tree never bursts at the speed of Lichess's answers. The value is a
  guess, since Lichess publishes no Explorer quota; raise it if 429s still
  occur. Cached positions skip the queue entirely.
- **After a 429, everything pauses for 60 s** (`RATE_LIMIT_PAUSE_MS`). A
  calculation's request then retries once, and its progress label says
  "Lichess asked to slow down; resuming at …"; a second 429 fails the
  calculation with a clear message.
- **Interactive requests go first.** The Study editor's panel (and the
  shared-opening viewer's) jumps ahead of a calculation's queued requests,
  so browsing stays responsive while a calculation runs. During a 429 pause
  it fails at once with "please wait a minute" rather than hanging.

Simultaneous requests for the same position and settings share one fetch.

## The browser cache

Explorer move frequencies change slowly, so `explorerClient.ts` keeps each
Lichess response in IndexedDB (`lirep-explorer`, store `responses`) for
30 days; responses from the player database, whose games change whenever
the player plays, are kept for 24 hours. The key holds the database, the
query (the actual rating buckets and speeds, or the player and side) and
the FEN, for example
`lichess|1600,1800,2000,2200,2500|blitz,rapid,classical|<fen>` or
`masters|<fen>`. A cached response carries its fetch time, which the
editor's panel shows ("Fetched 3h ago").

The cache is per browser profile, shared by the accounts used in it:
Explorer data does not depend on who asks. Another device, or a cleared
browser, fetches again. If IndexedDB is unavailable, responses are not
cached and every lookup is a (paced) request. Each calculation also keeps
the positions it has seen in memory, so transpositions within one tree
cost nothing.

Browsers cannot feed a cache shared between users: anyone could then
upload invented move statistics and skew other people's scores. Before this
change, the backend kept such a shared cache (`explorer_cache` in SQLite);
it now drops that table on startup.

## Rating bucket default

A study's `minRating` is a fixed bucket, chosen once and saved like any other
Explorer setting — not a standing "my current rating" mode re-resolved on
every request. (It used to be: `minRating: null` meant every single
`/api/explorer` call first resolved the signed-in player's rating live. That
was a lot of machinery — a Lichess account call potentially on every position
visited — for a feature whose behavior wasn't even obvious from the UI, e.g.
which of your ratings "counted" when several speeds were checked. `/api/explorer`
now just treats a `null` from a study saved before this changed as the same
static default the picker itself falls back to — no account lookup.)

`_resolve_min_rating` still exists, narrowed to the one place a live
resolution actually earns its keep: `/api/explorer-defaults`, which
pre-selects a brand-new (or otherwise-untouched) study's picker at the
player's own bracket. It still caches that bucket in `rating_cache` by
username for `RATING_CACHE_TTL_SECONDS` (one hour), surviving backend
restarts. A study whose saved `minRating` is still `null` from before this
change uses the static default, 1400. The reference
rating preference is Rapid, then Blitz, then Classical, with 1500 as the
unrated default. The chosen bucket and all higher buckets form the Players
rating filter.

## Local evaluation frontier

Expected evaluation needs more than evaluations of study nodes. At every
opponent turn, Explorer may list real replies absent from the tree; prep
ends at the resulting positions. A nonterminal studied-side leaf and an
opponent position with zero listed games also need an evaluation of the
current position. These reachable positions, starting at the effective
study starting node, are the **frontier**. Terminal results use chess rules
instead of an engine. See [stats.md §3](stats.md#3-expected-evaluation-at-the-end-of-prep)
for the weighted walk.

`findRequiredEvaluations` in `frontend/src/stat.ts` discovers only this
frontier, with Explorer data from `explorerClient.ts`. The expected
evaluation checks each frontier FEN against the signed-in account's
local browser cache and run the Study editor's Stockfish WASM engine only for
missing FENs. This is incremental across studies and tree changes on the
same account and device: a new reply may require new FENs without discarding
old results. Each successful Stockfish score is converted from UCI's
side-to-move POV to **White's POV** and saved immediately on completion. An
interrupted calculation can resume from completed positions. A search with
no usable score is not cached; if still missing in the expected-eval result,
it contributes 0 cp and is counted in `evalMisses`, not fetched from Cloud
Eval.

The browser cache is opened by `openEvaluationCache` in
`frontend/src/evalCache.ts`. Its IndexedDB database
`lirep-position-evals` has a `positions` store with numeric cp values keyed
by `[username, fen]`. It is **per account and per device/browser profile**,
not global or synced through the server. Another device needs to calculate
the positions itself; clearing browser data also forces recomputation. If
IndexedDB is blocked (including private modes where it is unavailable),
the cache is memory-only for the current page/tab visit.

Old studies may still have server-side `evals.byNode`. On loading a study's
Stats detail page, the browser converts each valid non-null legacy node
value to its FEN and imports it only when that FEN has no local cached
value. New evaluations are **not** saved back into `evals.byNode` or any
SQLite eval table. The old `POST /api/studies/{id}/evals` and
`POST /api/eval-cache/lookup` endpoints are removed. The retained
`cloud_eval_cache` table, if present in an older database, is neither a
lookup source nor a destination for new values.

The expected evaluation weights those values with Explorer frequencies in
the browser and sends only the scalar `evalCp`, `evalMisses`, the depth and
the selected `explorerSettings` to `POST /api/studies/{id}/expected-eval`.
The expected score and coverage are likewise calculated in the browser
(`frontend/src/expectedScore.ts`) and sent to
`POST /api/studies/{id}/expected-score`. The backend persists the results
and settings; it runs no engine and makes no Explorer request for either.

## Stored shapes

```jsonc
// Browser IndexedDB lirep-explorer / responses: key as described above,
// value the shaped response and its fetch time (ms since the epoch).
// "lichess|2000,2200,2500|blitz,rapid|rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" ->
{ "data": { "source": "lichess", "database": "lichess", "minRating": 2000, "opening": "King's Pawn Game",
            "totals": { "white": 1234, "draws": 456, "black": 789 }, "moves": [], "fetchedAt": "2026-10-07T11:42:03Z" },
  "fetchedAt": 1791366123000 }

// Backend rating_cache: one row per signed-in username.
{
  "username": "ExampleUser",
  "bucket": 1600,
  "fetched_at": "2026-09-23T11:42:03+00:00"
}

// Browser IndexedDB positions: key [username, fen, depth], value White-POV cp.
// Example: ["ExampleUser", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 16] -> 18
```

`rating_cache` stays small (one row per username) and checks its one-hour
TTL on reads.
