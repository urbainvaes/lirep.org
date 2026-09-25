# Stats page

Deep-dive companion to ["The Stats page"](README.md#the-stats-page) and the
general tree-walk idea in [§2 "Core idea"](README.md#2-core-idea). Win
probability and coverage run in `backend/app/stats.py`; expected evaluation
runs in `frontend/src/stat.ts`. Study cards on the home page are rendered by `frontend/src/studyCard.ts`.

All three calculations assume the studied side always plays its one prepared
move. At an opponent turn, the Opening Explorer supplies the frequency of
each listed reply in the selected pool. The calculations differ at the edge
of the tree:

| Stat | At the edge of preparation | Where calculated |
| --- | --- | --- |
| Expected score / win and loss probabilities | Explorer win/draw/loss results | Backend job |
| Coverage | Drop probability mass that leaves the tree | Backend job |
| Expected evaluation | Local Stockfish centipawns, weighted by Explorer move frequency | Browser |

**Expected score and coverage never use engine evaluations.** They measure
real game outcomes and the chance of staying in book, not objective position
quality. Expected evaluation uses actual local Stockfish results, never a
win-rate-to-centipawn conversion or a Lichess Cloud Eval fallback.

## 1. Expected score and win probability

The `escore` objective: *"If I've memorized this repertoire, what fraction
of a point do I score on average against real opposition?"* A win counts
1, a draw 0.5, a loss 0. The backend's `_Evaluator.outcomes` walks from the
study's effective starting node:

1. A finished game has its exact win/draw/loss outcome.
2. On the studied side's turn, follow its sole prepared move. If there is no
   child, use that position's overall Explorer results; if there are no games,
   use a neutral 0.5 expected score.
3. On the opponent's turn, weight each Explorer-listed reply by its games
   divided by the total games **in the listed moves**. Recurse into prepared
   replies. For an unprepared reply, use that move's own Explorer W/D/L
   distribution and stop that branch. With no listed games, use neutral 0.5.

The study detail shows win and loss probabilities; draws are the remainder.
Expected score is `winProbability = winRate + 0.5 * drawProbability`.
Study cards on the home page show the expected score, and their Stats
button opens the study's Stats page, whose legend gives the score tiers
(gold at 60%+, silver at 55%+, bronze at 50%+, otherwise below breakeven).
Calculations are started on the Stats page; the cards have no
Calculate/Recalculate button.

## 2. Coverage

`_Evaluator.coverage` tracks the probability that play remains in the study
after each opponent move from the effective starting point. Mass starts at
1; the studied side's prepared move carries it forward, and opponent moves
split it by Explorer frequency. Mass going to an unprepared reply leaves the
book. The chart records remaining mass after each opponent move and shows
a separate structural count of remembered moves in its tooltip. The backend
reuses its in-run Explorer responses from the expected-score walk, as well
as the persistent Explorer cache described in
[explorer-cache.md](explorer-cache.md).

## 3. Expected evaluation at the end of prep

The `eeval` objective: *"If both sides play according to real-world
tendencies until preparation runs out, what does Stockfish think of the
resulting position?"* `findRequiredEvaluations` and `expectedEvaluation`
in `frontend/src/stat.ts` walk only the reachable portion of the tree from
the effective starting node:

1. A terminal position has its exact result: checkmate is capped at
   `±100,000` cp and a draw is 0. No Explorer or engine call is needed.
2. At the studied side's turn, follow the sole prepared child. If none
   exists, the position itself is an evaluation frontier.
3. At the opponent's turn, fetch the move list via `/api/explorer`. Recurse
   into prepared replies. Each listed unprepared reply with games creates a
   frontier position *after* that move. With no listed games, the current
   position is the frontier instead.
4. For the expected-eval result, weight each opponent reply's child value
   by its fraction of games among listed moves. Values at frontier positions
   come from the browser's FEN cache or local Stockfish. A position without
   a usable local evaluation contributes **0 cp**; `evalMisses` reports the
   number of such required positions. There is no Cloud Eval fallback.

The browser uses the same Stockfish WASM engine as the Study editor. Stats
offers Quick (depth 8), Balanced (12), and Thorough (16, the default); live
Study and Practice analysis remain at depth 16. UCI scores are relative to
the side to move, so the browser converts them to **White's point of view**
before caching `[FEN, depth] -> cp`.
The weighted result is then converted to the studied side's point of view
and displayed in pawns (`cp / 100`). Engine-reported mates use a
distance-sensitive value near the `±100,000` cap. The cap is a finite
stand-in for a decisive result when averaging with ordinary cp values.

## 4. Three actions

All actions are manual and independent. The study detail disables the other
buttons while an action runs; each action has its own progress display.

| Button | Work | Persistence |
| --- | --- | --- |
| **Update evaluations** | Discover the current frontier with `/api/explorer`, run Stockfish only for FENs absent from this browser's cache | Save each completed evaluation in browser IndexedDB |
| **Update win probability** | Backend Explorer-only job for win/draw/loss probabilities and coverage | Merge its fields into the study's `stats` row |
| **Update expected evaluation** | Discover/evaluate any missing frontier FENs locally, then perform the weighted tree walk locally | Synchronous `POST /api/studies/{id}/expected-eval` with only `evalCp`, `evalMisses`, and `explorerSettings`; backend saves the study summary |

Both browser actions share the same frontier discovery and evaluation code.
An existing FEN evaluation is reused across tree edits and studies **on
that account and device**. A new reply or changed Explorer settings can
expose new frontier FENs; running **Update expected evaluation** evaluates
them itself if needed, so **Update evaluations** is optional, not a
prerequisite. Only frontier FENs, not every tree node, are analyzed. Each
successful evaluation is persisted as soon as it finishes, so an interrupted
run can resume without repeating completed work. If the engine yields no
score, the position remains missing and can be retried on a later run.

On loading the detail page, legacy server-side `evals.byNode` values on the
study are mapped from node IDs to FENs and imported into the browser cache
if that FEN has no local value. New evaluations do not update that study
field. The former `POST /api/studies/{id}/evals` and
`POST /api/eval-cache/lookup` endpoints are removed. The old global SQLite
`cloud_eval_cache` table may remain in older databases but is not consulted
or written (and is not created in new databases); it does not sync
evaluations between devices or accounts.

The browser cache is keyed by signed-in username and FEN in IndexedDB.
It is **per account, per device/browser profile**, not synced to the backend
or other devices. Clearing browser data requires local recomputation (apart
from legacy `byNode` values still stored on a study). If IndexedDB is
unavailable, including in private browsing modes that block it, results
are held only in memory for the current page/tab visit.

Older study-level expected-evaluation summaries are still shown but marked
as legacy until recalculated locally; the replacement summary records
`evalOrigin: "local"` so it is not mistaken for a result that may have used
the former shared FEN cache.

**Update win probability** calls `POST /api/studies/{id}/win-probability`,
receives `{jobId}`, and polls `GET /api/jobs/{jobId}`. Job progress is
in-memory and does not survive a backend restart. The UI estimates its
total using tree size because the Explorer branching factor is not known
in advance. **Update evaluations** shows an indeterminate discovery phase,
then an exact count of missing FENs; **Update expected evaluation** shows
discovery and local engine progress before saving the summary, without
starting a backend job or polling `/api/jobs`. No server-side engine or
Cloud Eval work is done for either evaluation action.

The detail page's editable Explorer source, database, minimum rating, and
speed settings affect which replies the browser discovers and weights.
**Update win probability** and **Update expected evaluation** each send
the selected `explorerSettings` and persist them on the study. Simply
changing the controls or clicking **Update evaluations** does not save
settings. Win/coverage and expected eval can be recalculated separately
at different settings; each merges only its own metric fields rather than
clearing the other result. Explorer responses and automatic rating buckets
remain persistently cached on the backend (see
[explorer-cache.md](explorer-cache.md)).

## Assumptions and limits

- The studied side always plays its single prepared move. Neither calculation
  models user mistakes or alternative choices on that turn.
- Only Explorer-listed moves are weighted; the move list is capped (roughly
  the top dozen), so rare omitted replies do not contribute individually.
- `minRating` is a fixed threshold pinned to the study, chosen once from the
  player's own bracket when the study is created (see explorer-cache.md) —
  it doesn't track the player's rating afterward.
- The engine searches to a fixed local depth, not the depth of a cloud engine
  farm. A missing local score contributes 0 to expected evaluation and is
  counted in `evalMisses`, not looked up elsewhere.
- Calculations start at `startNodeId` if set and still present, otherwise the
  tree root; see [starting-point.md](starting-point.md).
- Recalculation is manual because Explorer lookups and local Stockfish
  searches can take time. Backend Lichess Explorer responses are cached for 30 days (24 hours for
  the player database); the local Lirep explorer is not cached.

## Stored shape

The backend persists summary fields on the study's `stats` JSON, independently
updated by the win/coverage job and the expected-eval POST:

```jsonc
{
  "winProbability": 0.5276,
  "winRate": 0.3714,
  "lossProbability": 0.3162,
  "coverage": [0.253, 0.164, 0.068],
  "winProbabilityCalculatedAt": "2026-09-23T09:12:00+00:00",
  "nodesEvaluated": 47,
  "explorerCalls": 22,
  "evalCp": 34.2,
  "evalMisses": 1,
  "evalCalculatedAt": "2026-09-23T09:14:00+00:00",
  "evalOrigin": "local",
  "source": "lichess",
  "database": "lichess",
  "minRating": 1600,
  "speeds": ["blitz", "rapid", "classical"]
}
```

These are study-level summary values, **not** a repository of position
evaluations. Browser IndexedDB's `positions` store holds numeric cp values
under `[username, fen]` keys. The study's legacy `evals` JSON may still
contain `byNode` for import, but new calculations do not write it.

## Ideas for future stats

Not built yet:

- **`hit` probability**: the share of lines whose end-of-prep evaluation
  exceeds a chosen threshold, using the same expected-eval tree walk.
- **Weakest branch report**: identify the opponent replies that contribute
  most to a low expected score.
- **Confidence / sample size**: flag Explorer positions with few games.
- **Stats history**: retain earlier summaries instead of overwriting them.
- **Frequency-weighted prep depth**: summarize when real games leave prep.
