# Code audit — bugs and QoL gaps

Findings from a full read-through of the backend (`backend/app/*.py`) and frontend
(`frontend/src/*.ts`) source, cross-checked against `practice.md`, `stats.md`,
`starting-point.md`, and `explorer-cache.md` to exclude anything that's already a
documented, deliberate simplification. Each item points at the exact code and
describes a concrete trigger, not a hypothetical.

## Bugs

### High severity

- **`frontend/src/practice-session.ts:477-492` (`onMove`) / `:443-467`
  (`handleFirstAttempt`) — concurrent grading race can double-count an attempt.**
  `awaitingNodeId`/`firstAttemptGraded` aren't locked until after the `await
  recordAttempt(...)` call resolves, and chessground's `movable.dests`
  (`board.ts:41-49`, set with `free: false`) isn't refreshed until
  `setBoardPosition()` runs again — so a second drag on a different
  originally-legal piece, fired while the first POST to
  `/api/studies/{id}/practice/attempt` is still in flight (slow network, or just a
  fast double input), re-enters `handleFirstAttempt` for the same node before the
  first call's state updates land. `roundDone`/`quizzesDone`/`correctCount` get
  double-incremented, `addHistoryEntry` runs twice, and two independent POSTs hit
  the backend's `apply_answer` (`backend/app/practice.py:91-100`), which will
  apply two updates to the same position (e.g. two "correct" answers double the
  `tau_days` growth and can push `streak` up by 2 in one interaction) — silently
  corrupting that position's knowledge score. If both are correct, both can also
  read `celebrated === false` before either sets it, double-firing the 100%
  celebration and double-advancing `stepIndex`.

- **`backend/app/studies.py` `StudyIn.tree: dict` — no schema validation on the
  tree a client PUTs/POSTs.** Nothing checks that `nodes`/`rootId`/`nextId` are
  present or that every `parentId`/`children` reference resolves. A malformed
  tree written through any client (a frontend serialization bug, a stray direct
  API call — this exact session had to hand-validate a tree with python-chess
  before writing one via curl, precisely because nothing else would have caught a
  mistake) gets persisted as-is. Every later read
  (`GET /api/studies/{id}`, the stats job's `_get_node`/`_resolve_start_node_id`,
  practice's `_drill_item_nodes`) then crashes with an uncaught `KeyError` → raw
  500, with no recovery short of hand-editing the SQLite row.

### Medium severity

- **`backend/app/explorer.py` `fetch_explorer`/`fetch_explorer_cached` — no
  handling for connection-level failures.** Only HTTP 429 and other non-200
  status codes are turned into friendly `HTTPException`s. A connection failure
  (`httpx.ConnectError`, `ConnectTimeout`, `ReadTimeout` — lichess.org briefly
  down, or the local explorer at `LOCAL_LICHESS_EXPLORER_URL` not running)
  propagates unhandled through `fetch_and_cache` and out of
  `GET /api/explorer` as a bare, undetailed 500 — unlike every other error path
  in the codebase (`auth.py` wraps every `httpx.HTTPError` with a user-facing
  message). Trigger: open the Study editor while lichess.org is unreachable or
  the local explorer process is down; the Explorer panel shows an opaque error
  instead of "could not reach the explorer."

- **`frontend/src/study.ts` (`renderEditor`) — a new study can silently persist
  `minRating: null` and then query the wrong rating bucket forever.** If
  `/api/explorer-defaults` fails to load (network blip — `fetchExplorerDefaults`
  swallows errors and returns `null`), a new study's `minRating` falls back to
  `null`. That gets written on the first autosave
  (`ExplorerSettings.minRating: int | None = None` in `studies.py` accepts it
  as-is). The rating `<select>` then *displays* the current resolved default
  bucket (`ratingOptionsHtml`'s `selected ?? defaultBucket`), but
  `explorerUrl()` omits `minRating` entirely when it's `null`, so the actual
  query silently falls back to `explorer.py`'s static
  `_bucket_for(DEFAULT_REFERENCE_RATING)` (a 1500-based bucket) — wrong for
  anyone whose real bracket differs — until the user manually touches the
  dropdown. Also affects any study saved before the one-time-default feature
  existed.

- **`frontend/src/practice-session.ts:64-72` (`recordAttempt`) /
  `:448-451` (`handleFirstAttempt`) — a failed save is invisible to the user.**
  `recordAttempt` returns `null` on any non-ok response (expired session, 401,
  500), with no retry and no error surfaced. `handleFirstAttempt` proceeds
  anyway: it still shows correct/incorrect, still logs a history entry (minus
  the knowledge percentage), still advances the walk. Trigger: session cookie
  expires mid-session during a long practice run — every subsequent attempt
  silently fails to persist, and the user only finds out later when knowledge
  scores haven't moved.

- **`frontend/src/practice-session.ts` `init()` (~line 556-560) has no
  try/catch around its `Promise.all`, unlike `practice.ts`'s `init()`
  (`:59-68`), which explicitly wraps its fetches.** A thrown fetch (offline,
  DNS failure) becomes an unhandled promise rejection and leaves the page
  blank/stuck with no error state, instead of the "backend not running" empty
  state `practice.ts` shows in the same situation.

- **`frontend/src/practice-session.ts` `loadStudy`/`loadQueue` vs.
  `practice.ts` — auth/server errors are indistinguishable from "genuinely
  empty."** Both treat any non-ok response as empty: `loadQueue` returns `[]`,
  `loadStudy` returns `null`. `init()` then shows "Study not found," and a
  queue-only failure shows `"{name}" has no moves of its own to practice yet.` —
  both misleading when the real cause is a transient or auth error.

### Low severity

- **`studies.py` `PUT /api/studies/{study_id}` — no optimistic concurrency
  check.** Always overwrites unconditionally based on owner+id, with no
  version/`updated_at` comparison against what the client last loaded. Two tabs
  editing the same study (easy to do — one for browsing, one for editing) will
  have one save silently clobber the other's edits with no warning.

- **`main.py:13` — `SessionMiddleware(..., https_only=False)` is hardcoded**,
  unlike every other deployment-relevant setting (client id, frontend URL,
  session secret all come from `config.py`/`.env`). Since this app is headed
  toward a real `lirep.org` deployment, forgetting to flip this before going
  live over HTTPS means the session cookie (which carries the Lichess access
  token) is never marked `Secure`.

- **`practice.py` `record_attempt` — read-then-write race on `practice_state`
  with no locking.** Two concurrent attempts for the same node (e.g. the same
  session open in two tabs landing on the same due item) can both read the
  same prior state; whichever write lands second silently overwrites the
  first's grading update, dropping one answer's effect. Low impact (a dropped
  update, not corruption) but a real, plausible trigger — related to, but
  distinct from, the frontend double-submit race above.

- **`practice.py` `record_attempt` only checks that `nodeId` exists in the tree
  at all**, not that it's an actual drill-item node for the studied side. A
  stray call with an opponent-node or root id is silently upserted into
  `practice_state` and then never surfaces anywhere (queue/summary only read
  back `_drill_item_nodes`) — inert today since the frontend only ever posts a
  real `awaitingNodeId`, but there's no server-side guard if that changes.

- **`frontend/src/stat.ts:406` (`trimTrailingCoverageZeros`) uses
  `displayed.at(-1)`, which needs ES2022 lib; `tsconfig.json` targets ES2021.**
  Confirmed currently failing: `npx tsc --noEmit` reports `TS2550` at this
  line. Doesn't break `vite build` (esbuild doesn't type-check), so it's
  invisible at runtime, but any CI/pre-commit step running `tsc --noEmit` is
  currently broken by this one line.

- **`frontend/src/stat.ts:140-150` (`terminalCp`) — comment doesn't match
  behavior.** The comment claims threefold-repetition and 50-move-rule
  positions "aren't covered" and get engine-analyzed like non-terminal
  positions. In fact `chess.js`'s `isDraw()` already returns `true` for both,
  so `if (chess.isDraw()) return 0;` (line 148) already short-circuits them to
  a flat 0 like any other draw — they never reach the engine. Functionally
  fine (consistent with `findRequiredEvaluations`'s equivalent
  `isGameOver()` check), just a misleading comment for the next reader.

- **`jobs.py` `_prune()` (`:19-27`) only runs from `create_job()`, not on a
  timer.** If the app runs a long time with jobs created only occasionally,
  finished entries past `_JOB_TTL_SECONDS` linger in memory until the next job
  happens to be created. Harmless at the documented single-user scale, just
  not actually time-triggered despite the TTL naming.

## Quality-of-life gaps

- **No way to "peek" at a practice position without a graded wrong answer
  first.** `frontend/src/practice-session.ts` only reveals the "Show answer"
  button after a first attempt has already been graded wrong (`:157-159`,
  `:366-367`, `:463-465`) — which resets streak/stability via `apply_answer`.
  A user who's genuinely blank on a position and wants to peek rather than
  guess-and-get-graded has no option to do that without a real penalty.

- **No `aria-live` anywhere in the practice session view.** The prompt result
  text ("Correct!", "Not quite — try again", "The move was X") and new
  practice-history entries all update via plain `textContent`/`innerHTML` with
  no `aria-live` region, so screen-reader users get no announcement of a
  graded result or a new history row — they'd have to manually re-navigate to
  notice anything happened. The 100%-celebration overlay is similarly silent
  and doesn't move focus into it. `stat.ts`'s eval-count span already uses
  `aria-live="polite"` elsewhere in the codebase, so this is an inconsistency,
  not a project-wide gap.

- **`frontend/src/stat.ts` `init()` — legacy-eval migration loop re-runs on
  every page load.** It iterates every entry in `study.evals.byNode` and does
  an awaited IndexedDB `cache.get()`/`cache.set()` per entry, sequentially,
  before `renderPage()` runs — for a large study, this repeats a full
  migration pass on every single visit (nothing marks it done or clears
  `study.evals`), delaying first render each time even when nothing is
  actually stale.

## Notes on what was checked and found correct

The following were specifically traced by hand (not assumed from memory) and
found to match their documented design, so they're excluded above:
explorer.py's in-flight request de-duplication and cache TTL/pruning in
store.py; the practice-queue fallback logic in `practice.py`; `stat.ts`'s
`coverage()`/`outcomes()` parity handling; the retry/no-regrade mechanics in
`practice-session.ts` (`handleRetry` never re-POSTs, matching `practice.md`);
and the AttemptResult/PracticeSummary/queue response shapes, which the
frontend and `practice.py` agree on exactly.
