# Code audit — bugs and QoL gaps

Findings from a full read-through of the backend (`backend/app/*.py`) and frontend
(`frontend/src/*.ts`) source, cross-checked against `practice.md`, `stats.md`,
`starting-point.md`, and `explorer-cache.md` to exclude anything that's already a
documented, deliberate simplification. Each item points at the exact code and
describes a concrete trigger, not a hypothetical.

Everything with a clear, low-risk fix has already been fixed (see git log) and
removed from this list. What's left below are the ones that need a real design
decision or carry enough risk that they're better left for a deliberate choice
rather than a drive-by fix.

## Bugs

### Low severity

- **`studies.py` `PUT /api/studies/{study_id}` — no optimistic concurrency
  check.** Always overwrites unconditionally based on owner+id, with no
  version/`updated_at` comparison against what the client last loaded. Two tabs
  editing the same study (easy to do — one for browsing, one for editing) will
  have one save silently clobber the other's edits with no warning. Fixing
  this properly means adding a version/timestamp column and a conflict
  response the frontend actually surfaces to the user — a real feature, not a
  one-line fix.

- **`practice.py` `record_attempt` — read-then-write race on `practice_state`
  with no locking.** Two concurrent attempts for the same node (e.g. the same
  session open in two tabs landing on the same due item) can both read the
  same prior state; whichever write lands second silently overwrites the
  first's grading update, dropping one answer's effect. Low impact (a dropped
  update, not corruption) and a genuinely rare trigger (SQLite's own
  connection-per-request already serializes most of this) — a real fix needs
  either a DB-level transaction with a row lock or an atomic read-modify-write,
  and it's not obviously worth the complexity at this app's scale.

- **`jobs.py` `_prune()` (`:19-27`) only runs from `create_job()`, not on a
  timer.** If the app runs a long time with jobs created only occasionally,
  finished entries past `_JOB_TTL_SECONDS` linger in memory until the next job
  happens to be created. Harmless at the documented single-user scale — fixing
  it would mean adding a background timer task for a problem that doesn't
  currently cause any observable issue, so left as-is rather than fixed
  speculatively.

## Quality-of-life gaps

- **No way to "peek" at a practice position without a graded wrong answer
  first.** `frontend/src/practice-session.ts` only reveals the "Show answer"
  button after a first attempt has already been graded wrong (`:157-159`,
  `:366-367`, `:463-465`) — which resets streak/stability via `apply_answer`.
  A user who's genuinely blank on a position and wants to peek rather than
  guess-and-get-graded has no option to do that without a real penalty. Left
  open since it's a real UX/design tradeoff (should peeking be free, or cost
  something less than a full wrong answer?), not a bug to just patch over.

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
found to match their documented design: explorer.py's in-flight request
de-duplication and cache TTL/pruning in store.py; the practice-queue fallback
logic in `practice.py`; `stat.ts`'s `coverage()`/`outcomes()` parity handling;
the retry/no-regrade mechanics in `practice-session.ts` (`handleRetry` never
re-POSTs, matching `practice.md`); and the AttemptResult/PracticeSummary/queue
response shapes, which the frontend and `practice.py` agree on exactly.
