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

This fallback is empirical, not an intrinsic evaluation of the position: it
reflects what players in the selected pool actually played next, including
prepared follow-ups. A favorable Explorer result may depend on a continuation
the user has not prepared. This is not a flaw in using empirical results; it is
a limitation of treating the pool's average outcomes as a proxy for the user's
own unprepared play.

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

## 4. Two calculations

Both run in the browser and are started from the Stats page: **Recalculate**
runs both, one after the other, and each result's own button runs it alone.
The other buttons are disabled while one runs; each result has its own
progress display.

| Calculation | Work | Persistence |
| --- | --- | --- |
| **Expected score** | The weighted tree walk for win/draw/loss probabilities and coverage (`frontend/src/expectedScore.ts`), with Explorer data from the browser | `POST /api/studies/{id}/expected-score` with the results and `explorerSettings`; the backend checks the ranges and saves them |
| **Expected evaluation** | Discover the frontier, run Stockfish only for FENs absent from this browser's cache, then the weighted walk | `POST /api/studies/{id}/expected-eval` with `evalCp`, `evalMisses`, the depth and `explorerSettings` |

All Explorer data comes from `explorerClient.ts`, which asks Lichess's
Explorer directly from the browser, one request at a time and at least
500 ms apart, pausing a minute after a 429; see
[explorer-cache.md](explorer-cache.md). Since the browser calculates the
results, the server cannot check them beyond their ranges; this is the
price of each user's Explorer requests counting against their own Lichess
rate limit rather than the server's.

An existing FEN evaluation is reused across tree edits and studies **on
that account and device**. A new reply or changed Explorer settings can
expose new frontier FENs, which the expected evaluation evaluates first.
Only frontier FENs, not every tree node, are analyzed. Each successful
evaluation is persisted as soon as it finishes, so an interrupted run can
resume without repeating completed work. If the engine yields no score,
the position remains missing and can be retried on a later run.

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

The expected score's progress bar estimates its total from the tree's size,
because the Explorer's branching is not known in advance; the expected
evaluation shows its discovery phase, then an exact count of positions to
evaluate. No server-side engine or Cloud Eval work is done.

The Stats page's Explorer settings (source, database, minimum rating,
speeds) and Stockfish depth decide which replies are weighted and how deep
positions are evaluated. Each calculation sends the settings it used and
saves them as the study's settings; changing the controls alone saves
nothing and only marks results calculated with other settings as out of
date. The two results can be calculated at different settings; each merges
only its own fields rather than clearing the other.

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
  searches can take time. Lichess Explorer responses are cached in the
  browser for 30 days (24 hours for the player database); the local Lirep
  explorer is not cached.

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
