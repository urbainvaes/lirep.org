# Opening Explorer cache

Companion doc to the "Opening Explorer panel" part of
["The Studies tab"](README.md#the-studies-tab) and
["§4" of stats.md](stats.md#4-three-actions-evaluations-win-probability-expected-evaluation).
Despite the name, this covers all three persisted caches that exist to keep
the app from re-asking Lichess for things it already knows: Explorer
responses (`explorer_cache`), resolved rating buckets (`rating_cache`), and —
the newest, and the one that actually matters most for "Update expected
evaluation" specifically — individual position evaluations
(`cloud_eval_cache`). All three live in `backend/app/store.py`.

## Why

Four things in the app call Lichess's Opening Explorer:

1. **The Study editor's live panel** — one request per position you visit
   while building a repertoire.
2. **"Update win probability"** and **"Update expected evaluation"** — one
   request per opponent-to-move position in a study's whole tree, made
   sequentially, potentially repeated every time you recalculate at
   different settings.
3. **"Update evaluations"** — the same one-request-per-opponent-node
   pattern as #2, but used only to *discover* which replies fall outside your
   tree (see "Closing the gap" below), not to compute a stat from the response.

None of those is a huge volume on its own, but Lichess doesn't publish a
fixed numeric limit for the Explorer (see below) — it's an internal, adaptive
limiter, and repeatedly re-fetching the *same* position (which #2 especially
tends to do — recalculating at a different rating threshold refetches
identical FENs) was hitting it in practice. A position's real-world move
frequencies also shift slowly — the top few moves' relative popularity in,
say, the Italian Game doesn't meaningfully change hour to hour — so refetching
the exact same query every time was pure waste, not freshness.

**Lichess's own documented policy** (there's no numeric quota published
anywhere, for the Explorer or most of their API):

> All requests are rate limited using various strategies... Only make one
> request at a time. If you receive an HTTP response with a 429 status, you
> have exceeded one of the rate limits. In most cases, waiting one minute
> before retrying will be sufficient, but some limits may require longer.
> Reduce your request frequency.

## What changed

A persistent cache table, `explorer_cache(cache_key, response, fetched_at)`,
sits in front of every real Lichess Explorer request. Both call sites above
go through the same function, `fetch_explorer_cached` in `explorer.py` — no
more duplicated fetch logic between `explorer.py` and `stats.py`.

**Cache key:** `f"{database}|{ratings}|{speeds}|{fen}"`, where `ratings` is
the exact comma-joined bucket list Lichess would see (e.g. `1600,1800,2000,2200,2500`),
not just the `minRating` threshold — so two settings that resolve to the same
underlying Lichess query hit the same cache entry, but a different threshold
correctly misses and fetches fresh. `masters` has no rating filter, so its
`ratings` component is empty.

**Deliberately not scoped to a study or a user.** A position's real-world
move frequencies don't depend on who's asking or which study they're
building — so the cache is shared globally. Two different studies (even
across different Lichess accounts using this app) that both reach the
position after 1.e4 only cost Lichess one request total, not one each.

**TTL:** `store.EXPLORER_CACHE_TTL_SECONDS`, currently 24 hours. A cache read
past that age is treated as a miss (`store.get_explorer_cache` returns
`None`), triggering a fresh fetch that overwrites the entry. This is a
judgment call, not something Lichess specifies: long enough to eliminate the
overwhelmingly common case (re-running "Update expected evaluation" a few times while
tuning settings, or opening the same early-game positions across studies),
short enough that the data is never more than a day out of date.

**Two cache levels for "Update expected evaluation":** `_Evaluator` in `stats.py` still
keeps its own in-memory `dict` cache for the lifetime of one run, in front of
the persistent one — a hand-built tree can transpose (different move orders
reaching the same position) within a single walk, so that first level avoids
even a local SQLite round-trip for those. The persistent cache is what
survives *across* runs and studies.

**429 handling stays fail-fast, not retried.** Since a cache hit already
removes the *repeat* requests that were causing the problem, the remaining
live requests (first-time or expired positions) still follow the same policy
as the Cloud Eval API's fallback (see `stats.md`): a `429` is never retried
in a short loop — Lichess's guidance is to wait a full minute, and hammering
it again seconds later would risk making things worse — so it fails
immediately with a clear "rate limited by lichess's opening explorer... wait
a minute" message instead of the old generic "explorer fetch failed".

## The other hidden request: resolving "my current rating"

Caching the Explorer response itself wasn't quite enough. "My current
rating" mode (`minRating: null`) needs the signed-in player's live rating
before it can even build the cache key — which meant a *second*, completely
uncached Lichess call (`GET /api/account`) on **every single Explorer
lookup**, regardless of whether the actual Explorer data was cached or not.
In practice this showed up as: a position visibly cached (confirmed via
`fetchedAt`) would still fail with "Explorer data unavailable right now" the
moment Lichess's account endpoint — not even the Explorer endpoint — hit a
rate limit, since the request never got far enough to check the Explorer
cache at all.

Fixed with `_resolve_min_rating` in `explorer.py`, backed by a **persisted**
per-username cache (`store.rating_cache`, `RATING_CACHE_TTL_SECONDS` = 1
hour) — used by `/api/explorer`, `/api/explorer-defaults`, "Update win
probability", and "Update expected evaluation" alike (one function, four
call sites — same pattern as `fetch_explorer_cached`). Two effects:

1. **Fewer account calls**, the same way the Explorer cache means fewer
   Explorer calls — a whole editing session no longer means one account
   fetch per position visited, just one per hour (per user).
2. **Graceful degradation on rate limit.** If a *refresh* attempt (past the
   1-hour TTL) gets rate-limited, it falls back to the stale cached bucket
   (`store.get_rating_cache(username, allow_stale=True)`) rather than failing
   the request outright — a rating bucket that's an hour or two stale is
   virtually always still correct anyway, and "probably still right" beats
   "definitely fails" when the alternative is refusing to serve Explorer data
   that's sitting right there in cache. Only a *first-ever* resolution for a
   user (nothing cached yet, anywhere) still fails hard on a rate limit,
   since there's no fallback value to use.

**Persisted deliberately, not in-memory** — this was the actual bug, caught
in testing: an in-memory version was tried first, and it correctly cached
within one process's lifetime, but a backend restart wipes in-memory state,
which silently threw away an otherwise-still-fresh resolution and forced a
live account call it didn't actually need. Symptom: a position confirmed
cached (via its own `fetchedAt`) still failed after a restart, purely
because *its* rating-bucket lookup had no memory of anything. Since this app
restarts often during development (and any deploy restarts it too), the
in-memory version's supposed savings — "cheap enough to just re-resolve
after a restart" — didn't hold in practice nearly as often as intended, and
the whole point of caching it was to avoid exactly the live call that a
restart would then force anyway.

## The biggest hidden request: evaluating moves outside your own tree

Caching Explorer responses and rating buckets still wasn't enough to stop
"Update expected evaluation" from hitting a rate limit on an otherwise fully-cached
study. The reason: `eval_score` (the expected-eval calculation — see
`stats.md` §3) doesn't just walk your tree. At every opponent-to-move
position, it looks at *every* real reply the Explorer reports, not just the
one(s) you've prepared for — and for each reply that **isn't** in your tree
("the opponent played something you didn't prepare for"), it needs an engine
evaluation of the resulting position to know how that branch of prep would
have gone. That position was never part of any study's tree, so it was never
touched by "Update evaluations" (which only walks tree nodes) and had no
persisted value anywhere.

In a real study this adds up fast: a repertoire with a typical branching
factor easily has over a hundred such positions across its whole tree — every
single one needing a live, **uncached** Cloud Eval request, on **every**
"Update expected evaluation" run, forever, regardless of how well everything else was
cached. If Lichess's Cloud Eval endpoint is rate-limited at all, the very
first of these fails the whole run — which is exactly what "everything else
is cached but it still hits the rate limit" looks like from the outside.

Fixed the same way as the other two: `store.cloud_eval_cache`, a
**global, FEN-keyed** cache (not tied to any study or tree — a position's
evaluation doesn't care what tree it happened to be reached from), consulted
by `_fetch_eval` in `stats.py` before ever calling Lichess. Two properties
worth calling out:

- **A real value is trusted forever, no TTL.** Unlike Explorer stats (which
  drift as new games get played) or a rating bucket (which changes as you
  play), a fixed position's engine evaluation is a fact that doesn't change
  over time. A miss (`cp` is `None` — no cloud eval available yet) *does*
  get a TTL (`CLOUD_EVAL_MISS_TTL_SECONDS`, 24h, same reasoning as the
  Explorer cache's staleness window) so it's retried later rather than
  treated as permanently unknowable.
- **Progress survives a failed run.** Since every successful lookup is
  persisted immediately (not batched up and saved only at the end), a run
  that dies partway through a rate limit doesn't lose what it already
  fetched — the next attempt picks up from wherever it left off instead of
  starting over from zero.

### Closing the gap: populate it locally, before "Update expected evaluation" ever needs it

The cache above still meant "Update expected evaluation" needed to be the
one making these Cloud Eval calls, live, at least once per position —
durable across runs, but still a real Lichess dependency the *first* time.
That's now avoidable: "Update evaluations" (see `stats.md` §4) evaluates
these exact positions **itself, locally, before "Update expected
evaluation" is ever run** — Stockfish already runs in the browser for tree
positions, so there was never a technical reason the off-tree ones had to go
through Cloud Eval at all, just an architectural gap between two features
built somewhat separately.

The browser doesn't know in advance which off-tree positions exist — that
depends on live Explorer data — so `findOffTreePositions` in `stat.ts` walks
every opponent-to-move tree node, fetches that position's Explorer response
(via `/api/explorer`, already persistently cached above, so this step is
fast and adds no Lichess load of its own), and collects every real reply not
matched by a tree child. Those FENs get evaluated by the same local engine
as tree nodes, then sent to the backend as `byFen` in the same
`POST /api/studies/{id}/evals` request `byNode` already used — written
straight into this same `cloud_eval_cache` table (`save_evals` in
`stats.py`), indistinguishable from an entry the server's own Cloud Eval
fallback would have written.

The result: when "Update evaluations" has been run, "Update expected
evaluation" finds everything it needs already cached and never touches
Cloud Eval at all — not just on the second run, but the first one too. The
live Cloud Eval fallback in `stats.py` still exists, and still matters, but
only for a position that's genuinely new: the tree or Explorer settings
changed since the last "Update evaluations" run, or that button's simply
never been clicked for this study.

### Not recomputing what's already cached, either

Populating the cache is only half the win — the other half is not throwing
that work away and redoing it. Early on, "Update evaluations" unconditionally
re-ran Stockfish on *every* tree position and *every* discovered off-tree
position on every click, even ones it (or another study, or the server's own
Cloud Eval fallback) had already evaluated. For a tree with, say, 34 nodes
and 143 off-tree replies, that's 177 fresh Stockfish searches every single
time, even when nothing had changed since the last run.

Fixed by making `calculateEvaluationsLocally` (`stat.ts`) incremental:

- **Tree nodes**: skip any node id already present in the study's own
  `evals.byNode` — that map is already sitting in memory (it came down with
  the study), no extra request needed to check it.
- **Off-tree positions**: bulk-check the discovered FENs against the shared
  cache via a new, deliberately generic endpoint,
  `POST /api/eval-cache/lookup` (`stats.py`) — send a list of FENs, get back
  a `{fen: cp}` map of whichever ones already have a *real* stored value.
  A stored **miss** (`cp` is `None` — Cloud Eval had nothing) is treated as
  "not cached" here, not "skip": local Stockfish can essentially always
  produce a real value where Cloud Eval couldn't, so a former miss still
  gets a real local evaluation instead of being stuck as a permanent gap.

Only the positions that come back from *neither* check get a fresh Stockfish
search; everything else is copied straight into the result unchanged. The
returned `byNode`/`byFen` still cover every currently-relevant position
either way (reused + newly computed combined) — callers reading the result
can't tell which positions were actually recomputed this run, which is the
point: the *interface* (`byNode`/`byFen`, keyed by node id / FEN, values in
centipawns from White's POV) stays the same regardless of how much or how
little work a given call actually did, whether that's "recompute all 177"
or "recompute 0, everything was already covered."

**Why a generic lookup endpoint, not something evals-specific:** the
underlying data — "does a real eval already exist for this FEN" — has
nothing to do with studies, trees, or "Update evaluations" specifically; any
future feature that touches individual positions can ask the same question
the same way. `/api/eval-cache/lookup` takes a bare list of FENs and returns
a bare `{fen: cp}` map, with no study id, no tree, no side, nothing tied to
today's one caller — deliberately, so it doesn't need to change shape if
what calls it does.

## The "fetched" indicator

Since Explorer data shown to you might now be reused from up to a day ago
instead of always being freshly fetched, the Study editor's live panel says
so: a small label in the panel header — "Fetched just now" / "Fetched 3h
ago" / "Fetched 1d ago" — with the exact timestamp available on hover. This
comes from `fetchedAt` in the `/api/explorer` response (added to
`_shape_response` in `explorer.py`), which is the cache entry's `fetched_at`
on a hit, or "now" on a fresh fetch — either way, it's the true age of the
data you're looking at, not a fixed "just fetched" claim.

## Stored shape

```jsonc
// one row per (database, ratings, speeds, fen) combination — see explorer_cache table
{
  "cache_key": "lichess|1600,1800,2000,2200,2500|blitz,rapid,classical|rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "response": { "white": 1234, "draws": 456, "black": 789, "moves": [...], "opening": null },
  "fetched_at": "2026-09-23T11:42:03+00:00"
}
```

`response` is the raw Lichess Explorer JSON, stored as-is (before
`_shape_response` reshapes it for the frontend) — so the same cached row
serves both `/api/explorer`'s shaped response and `stats.py`'s raw
`data.get("moves", [])` access without needing two different cache formats.

```jsonc
// one row per username — see rating_cache table
{
  "username": "ExampleUser",
  "bucket": 1600,
  "fetched_at": "2026-09-23T11:42:03+00:00"
}
```

```jsonc
// one row per fen — see cloud_eval_cache table. cp is null for a (retryable) miss.
{
  "fen": "r1b1k1nr/ppp1qppp/2nb4/1B1pp3/5P2/1P2PN2/PBPP2PP/RN1QK2R b KQkq - 2 6",
  "cp": -18.5,
  "fetched_at": "2026-09-23T12:30:00+00:00"
}
```

## Explicit assumptions / limitations

- **Up to 24 hours stale**, by design (see TTL above). A position whose top
  moves are shifting unusually fast (freshly viral in some online event,
  say) won't reflect that until the entry expires.
- **No manual "refresh now" bypass.** If you specifically want the latest
  numbers for one position, the only way today is to wait out the TTL — not
  a real limitation in practice (repertoire prep isn't time-sensitive at
  hour-to-hour granularity), but worth noting since it wasn't asked for.
- **Global and unbounded.** The table has no eviction policy or size cap —
  fine at this app's scale (one user, a handful of studies, each with tens
  of nodes), but would need one (e.g. delete rows past some age, or cap row
  count) if this were ever shared by many users' many studies.
- **In-memory job progress, on-disk everything else.** Unlike `jobs.py`
  (intentionally per-process, lost on restart — a job's progress isn't
  meaningful after the process that was running it is gone anyway), both the
  explorer cache and the rating cache are normal SQLite tables — they survive
  backend restarts, which is the point: the whole reason either exists is to
  persist across separate app runs, not just within one calculation.
