# Opening Explorer and evaluation caches

Companion to the [Opening Explorer panel](README.md#the-study-page) and
[stats.md's three actions](stats.md#4-three-actions). There are two active
backend SQLite caches in `backend/app/store.py` and a separate browser
evaluation cache. They have different ownership and freshness rules:

| Data | Storage and scope | Lifetime |
| --- | --- | --- |
| Lichess Explorer responses | Backend `explorer_cache`, shared across studies and accounts | 30-day TTL; 24 hours for the player database |
| Resolved default rating bucket (for a new study's picker) | Backend `rating_cache`, per username | 1-hour TTL; stale fallback on refresh failure |
| Stockfish position evals | Browser IndexedDB `positions`, keyed by `[username, fen]` | Until browser data is cleared; no sync |

Older databases may still contain the legacy global `cloud_eval_cache` table,
but nothing reads or writes it, and new databases do not create it. There is
**no Lichess Cloud Eval fallback**.

## Why cache Explorer responses?

The Study editor's live panel requests a position whenever you visit it.
**Update win probability** walks opponent-to-move positions in the tree on
the backend. In the browser, **Update evaluations** and **Update expected
evaluation** walk the reachable portion of the tree to discover evaluation
frontier positions, using `/api/explorer` at opponent-to-move nodes. The
first browser action needs only the positions; the second also needs move
frequencies for its weighted expected-eval walk.

These callers all use the backend's `fetch_explorer_cached` in
`backend/app/explorer.py`, directly or through `/api/explorer`. A repeated
query should not repeatedly reach Lichess's rate-limited Explorer. Explorer
move frequencies change slowly, making a bounded period of reuse useful.
Lichess does not publish a fixed Explorer quota; its API guidance says to
make one request at a time and, after HTTP 429, wait about a minute (or
longer) and reduce request frequency. A live Explorer 429 fails fast rather
than triggering an immediate retry.

Only responses from Lichess's Explorer are cached. The local Lirep explorer
has no rate limit and its data never changes, so its responses are fetched
fresh every time; caching them would only fill the size cap below and evict
Lichess entries.

`explorer_cache(cache_key, response, fetched_at)` stores the raw Explorer
JSON. The key has the form
`source|database|ratings|speeds|fen`: `source` is always `lichess`, and
`ratings` is the actual comma-separated bucket list passed to the provider,
not merely the configured minimum threshold. Masters queries have no rating
filter. This lets different studies or accounts reuse exactly the same
provider/query while keeping distinct settings separate. Responses older
than `EXPLORER_CACHE_TTL_SECONDS` (30 days) are fetched again and replaced,
except for the player database, whose games change whenever the player
plays: it uses `EXPLORER_PLAYER_CACHE_TTL_SECONDS` (24 hours);
there is no manual refresh bypass. The browser receives a shaped
`/api/explorer` response, including `fetchedAt`; the Study editor displays
its true age ("Fetched just now", "Fetched 3h ago", etc.). The backend
win/coverage job also has an in-run FEN map to avoid even SQLite lookups on
transpositions. Each browser calculation reuses Explorer responses in an
in-memory map for its discovery and, for expected eval, weighting passes.

Expired rows are removed at backend startup and during a throttled cleanup
(after an hour or 1,000 cache writes, whichever comes first). Cleanup also
enforces `EXPLORER_CACHE_MAX_BYTES` (512 MiB of raw keys and responses),
evicting the oldest entries first when needed. The fetched-at index makes
expiry checks and oldest-first eviction efficient. The size cap is checked
during cleanup rather than on every request; SQLite may keep freed pages in
its file for reuse instead of immediately shrinking the file on disk.

Simultaneous requests for the same uncached key share one in-flight fetch
and receive the same response or error. A failed fetch is not cached;
cancelling one waiter does not cancel the task for others. If the initiating
request closes its HTTP client while other callers still wait, the task
retries with its own client. Separate backend worker processes do not share
in-flight tasks, but still share SQLite.

The Lirep source uses its configured local rated-game archive; Lichess
offers Players and Masters. The same backend cache keys include the source,
so results from one provider cannot be mistaken for another.

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
restarts, and the win-probability job falls back to it too if a study's
saved `minRating` is still `null` from before this change. The reference
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
frontier using `/api/explorer`. Both **Update evaluations** and **Update
expected evaluation** check each frontier FEN against the signed-in account's
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

**Update expected evaluation** uses the same local frontier discovery and
evaluation, then weights those values with Explorer frequencies in the
browser. It sends only the scalar `evalCp`, `evalMisses`, and selected
`explorerSettings` to synchronous `POST /api/studies/{id}/expected-eval`.
The backend persists the study summary and settings; it does not run an
engine, access Cloud Eval, or start a job for this action. **Update win
probability** remains a backend Explorer-only job, polled through
`/api/jobs/{jobId}`. Explorer responses and rating buckets remain backend
SQLite data across restarts even though engine evaluations do not.

## Stored shapes

```jsonc
// explorer_cache: raw provider response; key includes source, database,
// actual rating buckets, speeds, and FEN (in that order).
{
  "cache_key": "lichess|lichess|1600,1800,2000,2200,2500|blitz,rapid,classical|rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "response": { "white": 1234, "draws": 456, "black": 789, "moves": [], "opening": null },
  "fetched_at": "2026-09-23T11:42:03+00:00"
}

// rating_cache: one row per signed-in username.
{
  "username": "ExampleUser",
  "bucket": 1600,
  "fetched_at": "2026-09-23T11:42:03+00:00"
}

// Browser IndexedDB positions: key [username, fen], value White-POV cp.
// Example: ["ExampleUser", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"] -> 18
```

The Explorer cache has expiry cleanup and a 512 MiB raw-payload limit;
`rating_cache` remains small (one row per username) and checks its one-hour
TTL on reads. Backend `/api/jobs` progress is in-memory rather than part of
either persisted cache.
