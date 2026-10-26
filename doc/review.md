# Code audit

Reviewed **2026-10-26**, against the current working tree, including uncommitted changes. Findings and suggestions are ordered from high to low priority. This replaces the older review, which referenced removed code such as `jobs.py`.

Scope: first-party backend routes and persistence; desktop editing, imports, statistics and practice; mobile routing, API access, offline storage and service worker; selected build/deployment configuration. Generated bundles, bundled Stockfish and the vendored Explorer were not audited internally. This was a source review with targeted reproductions, not exhaustive browser/device or security testing.

**Evidence:** “Reproduced” means exercised locally with temporary SQLite databases or JavaScript harnesses running the actual source with mocked browser/network interfaces. “Source inspection” means traced in code without an end-to-end reproduction.

## High priority — P1

### 1. Private API responses and OAuth tokens persist in a shared mobile cache

**Location:** [mobile/public/sw.js](../mobile/public/sw.js#L46), especially lines 49–50 and 73–75; [auth.py](../backend/app/auth.py#L252).

The worker caches every successful GET under `/api/`, including `/api/lichess-token`, despite that endpoint returning `Cache-Control: no-store`. These explicit Cache Storage writes do not automatically honor that directive. Private data is keyed by URL with no account namespace.

Logout bypasses the worker under `/auth/`. Subsequently `/api/me` returns HTTP 200 with `authenticated: false`, which does not trigger the worker's 401-only deletion. Private studies and any fetched token remain stored. A later account on the same browser can receive the previous account's cached data when a request fails or exceeds four seconds. Revoking a token does not remove its cached response.

**Evidence:** Reproduced storing a dummy `no-store` token, then retrieving it and private study data offline after a signed-out `/api/me`. Cross-account fallback follows from the shared URL keys; it was not exercised in a real browser.

**Suggestion:** Use an explicit cache allowlist; exclude credentials and `no-store` responses. Namespace private data by verified account and explicitly purge it on logout, deletion and account changes. Recognize `authenticated: false`, not just 401.

**Rebuttal (not P1; P3 at most).** The facts are right, the impact is overstated:

- The cached token is dead after sign-out: `/auth/logout` revokes it at Lichess (`_revoke_lichess_token`), and its only scope is `preference:read`. Revoking it some other way (on Lichess) leaves a copy that is equally dead.
- The mobile app has no sign-out of its own: signing out happens on the website, whose pages the worker (scope `/m/`) doesn't control. What stays is the copy of the last answers, the same thing the worker exists to keep.
- Another account seeing it needs a second person signing in to Lirep in the same browser profile, then opening the mobile app offline or on a connection slower than 4 s; online, every answer comes from the network. On a personal phone, the usual case for an installed web app, that doesn't happen.
- The studies kept are, by default, shared with the community anyway.

Worth doing because it is cheap: don't keep `/api/lichess-token` (or any `no-store` answer), and drop the data cache when `/api/me` says `authenticated: false`. Per-account namespacing is not worth its complexity.

### 2. An empty startup flush prevents later offline events from syncing

**Location:** [mobile/src/outbox.ts](../mobile/src/outbox.ts#L66); [mobile/src/main.ts](../mobile/src/main.ts#L85).

`flush()` uses `flushing ??= (async () => { ... })()`. With an empty queue, the IIFE reaches `finally` synchronously and sets `flushing = null` before the assignment completes. The assignment then stores the already-resolved promise permanently. Future calls return that promise without checking the queue.

The app normally flushes an empty queue at startup. Answers/runs queued during a later connection failure then stay pending after reconnection; subsequent events accumulate behind them. Reloading with a nonempty queue can recover them.

**Evidence:** Reproduced empty `flush()` → failed `send()` → restore network → `flush()`: zero POSTs, event still queued.

**Suggestion:** Assign the promise before scheduling its work and clear it in a completion handler that runs after assignment. Add a regression for this exact startup/offline/reconnect sequence.

### 3. Tree validation accepts cycles and unusable chess trees

**Location:** [studies.py](../backend/app/studies.py#L70), [store.py](../backend/app/store.py#L286), [stats.py](../backend/app/stats.py#L35), [practice.py](../backend/app/practice.py#L50).

Validation checks local references and parentage, but not root reachability, cycles, duplicate children, legal SAN or the one-prepared-move rule. An isolated root plus nodes 1 and 2 pointing to each other passes, as does `startNodeId=1`. Fingerprinting then follows the cyclic parent chain indefinitely. An update can persist a malformed tree before response serialization, affecting later reads and potentially public shared-study enumeration.

Illegal SAN passes validation and later crashes practice traversal. Multiple own-side children cause statistics to use the first move while practice enumerates all of them.

**Evidence:** Reproduced acceptance of the disconnected cycle and its starting point. Separately reproduced accepted illegal SAN raising `InvalidMoveError` in practice. The infinite traversal was identified by inspection and deliberately not run.

**Suggestion:** Validate all node shapes first, then perform a bounded traversal from the root. Reject cycles, unreachable nodes, duplicate edges and excessive size/depth. Replay moves to validate legality and side constraints before writing. Add bounded failure handling for already-stored invalid rows.

### 5. Anonymity changes do not hide cached public identity promptly

**Location:** [community.py](../backend/app/community.py#L281); [auth.py](../backend/app/auth.py#L325).

The top-players cache stores already-rendered usernames and exact ratings for an hour. Enabling anonymity changes SQLite without invalidating or re-filtering that cache. The old public identity remains visible; Lichess refresh failures can extend this through the stale-cache fallback. Deletion also leaves the cached player available.

**Evidence:** Reproduced populating the leaderboard, enabling anonymity and requesting it again: the original username and exact rating were returned.

**Suggestion:** Cache raw ratings and apply current registration, aliases and privacy settings on each response. Alternatively invalidate caches across workers on privacy changes/deletion; stale fallbacks must still apply current privacy rules.

## Medium priority — P2

### 6. Account deletion retains identifiable Bullet history

**Location:** [store.py](../backend/app/store.py#L1113).

`delete_account()` removes practice state/logs but never deletes `bullet_runs`. Rows retain usernames, study IDs, timestamps and outcomes. Keeping history after deleting one study is intentional; retaining it after deleting the whole account contradicts the deletion behavior described by the code.

**Evidence:** Reproduced recording a run, deleting the account and finding its username/run still in `bullet_runs`.

**Suggestion:** Remove Bullet rows in the existing account-deletion transaction. Cover every account-owned table in a deletion regression.

### 8. Autosave silently overwrites another tab's changes

**Location:** [studies.py](../backend/app/studies.py#L233), [store.py](../backend/app/store.py#L706), [frontend/src/study.ts](../frontend/src/study.ts#L545).

Updates replace the full tree, name, settings and starting point without a revision precondition. Two tabs editing different branches can both save successfully, with the second discarding the first's work. Local editor save counters coordinate only one page.

**Evidence:** Source inspection: SQL updates condition only on owner and study ID.

**Suggestion:** Add an integer revision and update atomically with a revision precondition. Return 409 for conflicts, preserving local edits for recovery. The existing second-resolution `updated_at` is insufficient as a dependable version counter.

### 9. Retried offline events can be graded/counted multiple times

**Location:** [mobile/src/outbox.ts](../mobile/src/outbox.ts#L44), [practice.py](../backend/app/practice.py#L253), [practice.py](../backend/app/practice.py#L302).

If a POST commits but its response is lost, the outbox queues it again. Attempts/runs have no unique event ID or database duplicate guard. Retrying increases streak/stability or Bullet totals again. Separate tabs can also drain the same queue because `flushing` coordinates only one JavaScript context.

**Evidence:** Reproduced identical attempt submissions advancing the streak from 1 to 2. Network-loss and multiple-tab triggers were traced in source.

**Suggestion:** Persist a UUID with each event before sending and enforce uniqueness per account. Deduplication, grading and logging must commit together. Coordinate draining across tabs too.

### 11. Delayed answers can overwrite newer practice state

**Location:** [practice.py](../backend/app/practice.py#L231) and [practice.py](../backend/app/practice.py#L265); [store.py](../backend/app/store.py#L820).

Offline timestamps up to seven days old are accepted, but grading applies them to the latest state and unconditionally replaces `last_seen_at`. An older wrong answer replayed after a recent correct answer resets the streak and moves the timestamp backwards, affecting decay and queue order.

**Evidence:** Reproduced current answers followed by a two-day-old wrong answer: the state reset and last-seen time regressed. The response also reports `streak / 3` as knowledge even for an aged attempt.

**Suggestion:** Define chronological replay semantics: rebuild from ordered, deduplicated events or explicitly handle late events without regressing the latest state. Derive returned knowledge from the actual stored timestamp.

### 12. A different account can cause pending offline events to be discarded

**Location:** [mobile/src/outbox.ts](../mobile/src/outbox.ts#L6), [mobile/src/outbox.ts](../mobile/src/outbox.ts#L58), [mobile/src/main.ts](../mobile/src/main.ts#L85).

The global outbox stores only URLs/bodies and flushes at startup before verifying identity. If A has pending events and B signs in on the same browser, they replay using B's cookie. Ownership checks correctly reject A's study IDs, but the resulting 404 is considered permanent and removes the events. A loses the pending history.

**Evidence:** Source inspection. Owner checks prevent these requests from successfully grading B's studies; the issue is destruction of A's unsent events.

**Suggestion:** Associate queues/events with an account identifier, verify identity before flushing and leave another account's pending history untouched. Provide recovery for queues whose owner is signed out.

### 13. Storage failures silently lose offline answers immediately

**Location:** [mobile/src/outbox.ts](../mobile/src/outbox.ts#L22), [mobile/src/api.ts](../mobile/src/api.ts#L95), [mobile/src/session.ts](../mobile/src/session.ts#L185).

`write()` swallows localStorage errors yet announces that events are waiting. `send()` returns `offline`, which practice treats as safely queued. There is no memory fallback: the next `read()` reloads storage, so a failed write is lost immediately, contrary to the comment saying it survives until page closure. Quota exhaustion/blocked storage therefore gives a false assurance of later syncing.

**Evidence:** Source inspection.

**Suggestion:** Return persistence success/failure and show an unsaved warning. If using an in-memory fallback, distinguish it from durable storage and report only events actually retained.

### 14. Overlapping mobile routes can restore an obsolete screen

**Location:** [mobile/src/main.ts](../mobile/src/main.ts#L34), [mobile/src/session.ts](../mobile/src/session.ts#L23), [mobile/src/bullet.ts](../mobile/src/bullet.ts#L27).

Hash changes launch independent async routes without cancellation or generation checks. Navigate to practice, then another tab before practice loads: the older renderer can finish last and replace the newer screen. It can also assign the shared `leave` callback after another route starts, leaving the wrong resource cleanup installed or boards/timers alive.

**Evidence:** Source inspection: renderers await data before installing their screens.

**Suggestion:** Give navigation a generation/abort signal, check it before DOM writes, and dispose resources from obsolete renders. Guard inside renderers; checking only after they finish is too late.

### 15. Imported underpromotions cannot be entered correctly in practice

**Location:** [frontend/src/practice-session.ts](../frontend/src/practice-session.ts#L474), [frontend/src/bulletRun.ts](../frontend/src/bulletRun.ts#L383), [mobile/src/session.ts](../mobile/src/session.ts#L206), [frontend/src/studyFile.ts](../frontend/src/studyFile.ts#L150).

Board input always supplies `promotion: "q"`, while file import accepts legal underpromotions and engine/Explorer moves preserve promotion pieces. A prepared `=N`, `=R` or `=B` move cannot be matched through board input: practice grades the queen promotion as wrong and Bullet can fail the run.

**Evidence:** Source inspection of input handling, SAN comparison and import validation.

**Suggestion:** Add a shared promotion chooser across editor, practice, Bullet and mobile. Optional auto-queen should retain an accessible way to choose another piece.

### 16. Both TypeScript checks fail while production builds pass

**Location:** [frontend/src/tree.ts](../frontend/src/tree.ts#L259), lines 259, 261, 266 and 298; [frontend/package.json](../frontend/package.json); [mobile/package.json](../mobile/package.json).

Both projects report TS7022 implicit-`any` errors for `rowStartId`, `node`, `possibleBlackId` and `lastPlayedId` in the shared tree renderer. Both production builds run Vite without type checking, so build success does not establish compliance with the checked-in strict compiler configuration.

**Evidence:** Reproduced with installed compilers: both builds passed; desktop `tsc --noEmit` and mobile `npm run check` failed on the same four errors.

**Suggestion:** Add explicit types to break the inference cycle, expose a desktop `check` script and require type checks alongside production builds.

## Low priority — P3 suggestions and inconsistencies

### 18. Desktop practice lacks mobile's accessible feedback announcements

**Location:** [frontend/src/practice-session.ts](../frontend/src/practice-session.ts#L143); [mobile/src/session.ts](../mobile/src/session.ts#L39).

Desktop updates prompt/results, history and celebration content without live-region announcements; mobile's prompt already uses `aria-live="polite"`. Screen-reader users can miss grading feedback and round transitions.

**Suggestion:** Add scoped status/live regions and an accessible celebration announcement. Avoid re-announcing the whole history. Verify with a screen reader.

### 19. Legacy evaluation migration repeats before every Stats render

**Location:** [frontend/src/stat.ts](../frontend/src/stat.ts#L1030).

Every visit iterates `study.evals.byNode`, reconstructs each position from the root and sequentially checks IndexedDB before rendering. Already-migrated entries still incur the full scan, delaying useful content for larger legacy studies.

**Suggestion:** Mark migration completion against the payload/cache version, batch it or render first and migrate in the background. Preserve recovery when browser storage is cleared.

## Validation performed

| Check | Result |
| --- | --- |
| Desktop: `cd frontend && npm run build` | Passed. |
| Mobile: `cd mobile && npm run build` | Passed; warned about runtime resolution of `/fonts/lichess.woff2` and `/icon-192.png`. Those warnings alone do not establish a deployed asset defect. |
| Desktop: `cd frontend && ./node_modules/.bin/tsc --noEmit` | Failed: four TS7022 errors, finding 16. |
| Mobile: `cd mobile && npm run check` | Failed: same shared-source errors. |
| Backend: `cd backend && .venv/bin/python -m unittest discover -s tests` | No tests discovered; exit 5. |
| Isolated Python reproductions | Confirmed wrong fingerprint assignment, stale ranking eligibility, invalid SAN/cycle acceptance, duplicate grading, lost concurrent update, backwards offline timestamp, retained Bullet history after account deletion, and cached identity after enabling anonymity. |
| JavaScript harnesses running actual outbox/worker source | Confirmed empty-flush lockup and persistence of a dummy `no-store` token/private data after a signed-out account response. |

Reproductions used temporary databases and mocked Lichess responses. No live accounts or external services were modified. Browser harnesses test the identified logic but do not replace actual service-worker lifecycle, multiple-tab and device testing.
