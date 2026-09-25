# Stats page

Deep-dive companion to the ["The Stats tab"](README.md#the-stats-tab) section
of the main README. Everything here lives in `backend/app/stats.py` (the
computation) and `frontend/src/stat.ts` / `frontend/src/stats.ts` (the UI).

All three stats below are computed by the **same backward-induction walk**
over a study's tree — the restricted, single-tree version of the general
Markov-chain idea from [§2 "Core idea"](README.md#2-core-idea) of the main
README. They differ only in what value a leaf gets and how values combine:

| Stat | Leaf value | Combine rule |
| --- | --- | --- |
| Expected score | 1 / 0.5 / 0 (win/draw/loss) or the position's W/D/L rate | weighted average by real move frequency |
| Coverage | 1 if still in-book, dropped otherwise | probability mass still following the tree |
| Expected eval | Stockfish cp (local Stockfish, or Cloud Eval as a fallback) | weighted average by real move frequency |

**Expected score and Coverage are 100% Opening Explorer-derived — always.**
Every number either of them produces comes from Explorer win/draw/loss
counts (plus deterministic chess rules for an outright checkmate/stalemate
in the tree, which needs no external data at all). Neither ever calls
Stockfish or the Cloud Eval API, not even as a fallback, not even for a move
outside your tree — `_score_from_wdl` in `stats.py` computes a win rate
directly from the Explorer's own per-move counts, which is *already*
everything needed for that move's contribution. This is a deliberate,
load-bearing design choice, not an accident of how the code happens to be
written today: **these two stats must never be approximated from an engine
evaluation** (e.g. by inverting Lichess's cp→win% formula, quoted in the main
README's [§2 "Core idea"](README.md#2-core-idea), to back out a "cp
equivalent" from a win rate), because that would silently blend two
different things the README's own Objectives table treats as distinct —
objective engine assessment (`eeval`) and real-world result rate (`escore`)
— and explicitly notes "often disagree, which is itself informative." Only
**§3 below, Expected evaluation**, ever needs an actual Stockfish number, and
it always uses a real one.

## 1. Expected score

Shown as a percentage with a medal (🥇 ≥ 60%, 🥈 ≥ 55%, 🥉 ≥ 50%). Answers:
*"if I've perfectly memorized this repertoire, what fraction of a point do I
score on average against real opposition?"* This is the `escore` objective
from §2, restricted to exactly the tree you've built rather than a full
depth-budget expansion over the whole opening space.

A draw counts as half a point — same as chess scoring, and same as Lichess's
own "expected score" stat on profile pages. A single win/loss-only number
would throw away real information: a repertoire that draws 80% of the time
isn't equivalent to one that loses 80% of the time, even though neither
"wins."

**The algorithm**, walking the tree from the root (`_Evaluator.score` in
`stats.py`):

1. **At a finished game** (checkmate/stalemate/etc., detected with
   `python-chess`): score 1 if the studied side won, 0 if they lost, 0.5 for
   a draw.
2. **At a position where it's the studied side's move:** assume **perfect
   memorization** — they always play the tree's recorded move (there's only
   ever one, see "Assumptions" below). Score = the score of that child.
3. **At a position where it's the opponent's move:** fetch the Opening
   Explorer's move list for this exact position (same database/rating/speed
   settings as the study's `explorerSettings`), and take a weighted average
   over *all* of the opponent's real replies, weighted by how often each is
   actually played:
   - If a reply matches a branch you've prepared, recurse into it.
   - If a reply isn't in your tree, your preparation ends right there — its
     contribution is that single move's own win/draw/loss rate (which the
     explorer already reports per move), not a recursive expansion.

## 2. Coverage

The line chart on a study's detail page. `coverage[i]` = the probability that
a real game, sampled the same way as the expected-score walk, is *still
following a line inside your tree* after both sides have made their
`(i+1)`-th move. It answers a different question from expected score: not
"how well do I do", but "how often do I even get to use this prep before the
opponent goes somewhere I haven't covered."

Computed by `_Evaluator.coverage`, which reuses the same explorer-response
cache as `score` (so it's nearly free to compute right after `score` has
already walked the tree once): walk the tree tracking a probability mass
starting at 1.0; at the studied side's move the mass passes through unchanged
(you always have your one prepared reply); at the opponent's move, the mass
splits across their real replies by frequency, and any mass that goes to a
move outside your tree is dropped (it's left the book). The chart plots the
remaining mass at each of the opponent's move numbers.

**Why coverage never drops on your own move:** by the one-move-per-position
rule (see "Assumptions" below), you always have exactly one prepared reply,
so every drop in the chart comes from an opponent move you haven't covered —
which is exactly what you want to see when deciding where to extend your
prep next. The chart's hover tooltip also shows how many distinct branches
(`nodeCountsByMove` in `stat.ts`) you've memorized a response to by that
point, purely structural (no explorer data needed).

## 3. Expected evaluation at the end of prep

*"If both sides play according to real-world tendencies until my preparation
runs out, what does Stockfish think of the resulting position?"* This is the
`eeval` objective from the main README's [§2 "Core
idea"](README.md#2-core-idea), restricted to this study's tree.

**The algorithm, in one sentence:** assume the studied side always plays the
prepared move; the moment the opponent plays something there's no prepared
follow-up for, evaluate the resulting position with Stockfish, weighted by
how often that opponent move is actually played.

Walking the tree exactly like `score()` does (`_Evaluator.eval_score` in
`stats.py`):

1. **Studied side's move:** recurse into the one prepared child. No choice,
   no Stockfish needed.
2. **Opponent's move:** for each of their real replies (from the same
   Opening Explorer response `score()` already fetches at this position,
   weighted by frequency):
   - **in your tree** → recurse; the eval bubbles up from further down the
     line, same process.
   - **not in your tree** → prep ends right here. Evaluate the position
     *after* that move with Stockfish — this is the only place a real engine
     call happens — and weight it by that move's real-world frequency.
3. **Checkmate/stalemate reached inside the tree:** an exact `±100,000`
   ("mate") value, sign depending on who's winning — no Explorer or Stockfish
   needed at all.
4. **Edge cases** (rare in practice): the studied side reaches a leaf with no
   decided continuation, or the Explorer reports zero games for a position —
   both just evaluate that position directly, no weighting to do.

**No additional Opening Explorer calls are needed for this stat.** Step 2
reuses the *exact same* Explorer response `score()`/`coverage()` already
fetch at that position (same FEN, same in-run cache) — it already lists
every real reply and its frequency, which is everything needed to decide
what to recurse into and what to hand to Stockfish. The only genuinely new
ingredient this stat needs, that the Explorer can't provide, is the
Stockfish evaluation itself.

**Where that Stockfish evaluation comes from:** "Calculate evaluations" (§4)
computes *both* halves of step 2 **locally in your browser**, with the same
WASM engine (`frontend/src/engine.ts`) used for live analysis in the Study
editor, like Lichess's own free analysis board — not just step 1's in-tree
leaves. It walks every opponent-to-move tree node, reads that position's
(already-cached) Explorer response to find replies not covered by your tree,
and evaluates those resulting positions too, exactly the ones step 2 would
otherwise need. See `explorer-cache.md`'s "biggest hidden request" section
for the full story of why this mattered enough to build. **Live Lichess Cloud
Eval is only ever a fallback** for a position "Calculate evaluations" hasn't
covered yet — never evaluated at all, or the tree/settings changed since the
last run — and whatever it fetches that way is itself persisted afterward
(same shared cache, see below), so it's at most a one-time cost per position,
not a recurring one.

**Sign convention:** stored evals (`byNode`) are always kept in **White's
point of view**, regardless of the study's side — a position's eval doesn't
care who's studying it, so this keeps the cache source-agnostic. The two
sources disagree on their own native convention, so each converts before
storing/using the value: the Cloud Eval API already answers in White's POV
directly; the engine's UCI protocol reports scores **relative to the side to
move**, so the browser flips the sign whenever it's Black to move before
sending the result to the backend. `eval_score` then applies one more
side-relative flip — multiplying by `-1` for a black study — only at the
point where a stored (White-POV) value becomes *this stat's* result, matching
§2's "all objectives are side-relative" rule and the existing win-probability
stat.

**Mate capping:** a forced mate can't be averaged with an ordinary centipawn
value (there's no finite number of centipawns a mate is "worth"), so it's
capped at `±100,000` — a value large enough to dominate any weighted average
it appears in, standing in for "this branch is just winning/losing," without
needing actual infinite-precision arithmetic.

## 4. Three actions: evaluations, win probability, expected evaluation

The Stats detail page splits recalculation into three independent actions,
because they have genuinely different dependencies, costs, and *where they
run*. Each has its own button and its own progress bar, deliberately styled
the same way (a plain percentage fill, no indeterminate animation) —
consistent visual language for "this is running," regardless of which one:

| | Depends on | Runs | Button |
| --- | --- | --- | --- |
| Stockfish evals (tree positions + off-tree opponent replies) | The tree, **and** the current Opening Explorer settings (only to *discover* off-tree replies — see below) | **In your browser** (local Stockfish WASM) | **Update evaluations** |
| Win probability, coverage | The tree **and** the current Opening Explorer settings | On the backend (needs your Lichess session) | **Update win probability** |
| Expected evaluation | The tree, current Opening Explorer settings, **and** ideally the evaluations above | On the backend (needs your Lichess session) | **Update expected evaluation** |

All three buttons keep a fixed label regardless of whether the stat's ever
been computed before — no "Calculate" vs. "Recalculate" distinction to
track; they always just say what they do.

**Update evaluations** does two passes, both client-side
(`calculateEvaluationsLocally` in `stat.ts`):

1. **Discovery** (`findOffTreePositions`): for every tree node, and for every
   opponent-to-move node specifically, fetch that position's Opening Explorer
   response (via `/api/explorer` — already persistently cached, see
   `explorer-cache.md`, so this is fast and doesn't add Lichess load) and
   collect the FEN of every real reply that *isn't* one of your tree's
   children. These are exactly the positions §3's "opponent played something
   you didn't prepare for" case would otherwise need Cloud Eval for.
2. **Evaluation**: analyze every tree position *and* every discovered
   off-tree position with the same Stockfish WASM engine used in the Study
   editor.

The result is sent to `POST /api/studies/{id}/evals` in one request —
`byNode` (keyed by tree node id, this study's own) and `byFen` (keyed by
FEN, global — written straight into the shared `cloud_eval_cache` table,
`save_evals` in `stats.py`) — a plain, fast, synchronous save, since the slow
part already happened in the browser. Both never change for a fixed
tree/Explorer-response pair regardless of *which* rating/speed pool you're
studying against, so they're computed once and reused by every subsequent
"Update expected evaluation" run, for this study and (for the off-tree half)
any other study that happens to reach the same positions. Re-running this
button re-analyzes everything from scratch, not an incremental diff — cheap
to do since it's just local CPU time, no network cost either way, other than
the already-cached Explorer lookups discovery needs — so there's rarely a
need to, unless the tree changed.

A small green **✓** next to the button means the stored evals cover *every*
current tree position (`evalsAreCurrent` in `stat.ts` — every tree node id
is a key in `byNode`); it disappears the moment you add a move the stored
evals haven't seen yet, as a reminder rather than a requirement — "Update
expected evaluation" still works either way, just with more live fallback
calls if you skip re-running this first.

**Update win probability** and **Update expected evaluation** both show the
study's **Opening Explorer settings** (database, minimum rating, time
controls) directly, with the same controls as the Studies editor, and both
persist any change to them the same way (`POST .../win-probability` or
`.../expected-eval`, each taking an optional `explorerSettings` body — not a
one-off "preview," the same way editing them in the study editor would).
They're genuinely separate backend jobs (`_run_win_probability_job` /
`_run_expected_eval_job` in `stats.py`), each merging its own fields into the
study's `stats` row without touching the other's — see "Stored shape" below
— so either can be run without the other ever having been, and running one
doesn't force recomputing the other. This is also why the split matters
functionally, not just visually: win probability is always cheap and safe
(100% Explorer-derived, see the guarantee at the top of this doc), while
expected evaluation is the one that can still need live Cloud Eval calls —
separating them means asking for one never risks the other's rate limit.

**Update expected evaluation makes it visually obvious when evaluations
aren't ready.** If `evals` doesn't exist yet for the study at all, the button
renders as a warning color (amber, not the usual blue) and its caption
switches to an explicit "haven't been calculated yet — click 'Update
evaluations' first, or this may be slow and can hit Lichess's rate limit."
It still works either way (falling back to live Cloud Eval per position, the
same as before this existed) — this is a nudge, not a hard block, since a
handful of brand-new positions after a small tree edit isn't worth forcing a
detour for.

This makes it possible to ask "how does my prep hold up against 2000+ blitz
players vs. against masters?" — recalculating win probability and/or expected
eval repeatedly at different settings — without ever re-analyzing the
(unchanging) engine evals each time.

**Progress bars:** all three now render identically — a plain percentage
bar, no marching-stripes animation — but they get their percentage very
differently, matching where each one actually runs. "Update evaluations"
needs no server round-trip per position at all: after a brief indeterminate
flash while discovery finds off-tree positions (there's no total to show a
percentage of until that finishes), the browser loop itself drives an exact
count (tree nodes + discovered off-tree positions), no polling involved. The
other two still kick off backend background jobs
(`POST /api/studies/{id}/win-probability` or `/expected-eval`, each
returning `{jobId}`) that the frontend polls via `GET /api/jobs/{jobId}`
every 400ms (`backend/app/jobs.py` is a small in-memory, per-owner job
tracker — intentionally not persisted across restarts, since this is a
single-user, single-process app); their real total isn't knowable up front
(it depends on branching factors reported live by the Explorer), so the
frontend just estimates it as the tree's node count (`stat.ts`'s
`runProgressJob`) — a reasonable proxy, capped at 100% if the real count runs
a little past it, giving a plain growing bar instead of a true indeterminate
one.

**Data-integrity note (Cloud Eval fallback only):** the small remaining
Cloud-Eval-API usage inside "Update expected evaluation" still needs the
same care a purely local engine doesn't: since a stored eval is cached
long-term, a *real* miss (a genuine `404` — Lichess has no cloud eval for a
position) must never be confused with a *transient* failure (rate limiting,
a network hiccup) and baked into the cache as a wrong answer. `_fetch_eval`
only ever caches a `404` as `None`; a `429` specifically is **never
retried** — Lichess's own guidance is to back off a full minute after one,
and a short retry loop
would just risk an escalating ban — so it fails the whole job immediately
with a clear "rate limited, try again in a minute" message instead. A plain
server hiccup (5xx) still gets a couple of short retries, since those usually
clear on their own.

**Opening Explorer requests are cached too, persistently.** The much larger
source of Explorer traffic — one request per opponent-to-move position in the
tree, every single "Update win probability" or "Update expected evaluation"
run — is backed by a persistent, cross-study cache rather than hitting
Lichess fresh every time; the same fail-fast `429` policy applies there too.
See **[explorer-cache.md](explorer-cache.md)** for the full writeup.

## Explicit assumptions / simplifications

Worth stating since these are easy to get wrong silently, and they apply to
all three stats above (they're all the same tree walk):

- **You always play your one prepared move.** The editor enforces this by
  construction: a position where it's the studied side's move can only ever
  have one recorded child. There's never an ambiguous "which of my own
  alternatives would I actually pick" case for any of these calculations to
  guess at.
- **Leaving your own prep uses a neutral estimate, not a guess.** If the tree
  ends on *your* move, expected score falls back to the position's overall
  explorer statistics (not a specific continuation), and expected eval falls
  back to that position's own cloud eval.
- **The explorer's move list is capped** (its own default is the top ~12
  moves per position). Extremely rare replies outside that list aren't
  individually accounted for; in practice they're a small fraction of games
  at any well-populated position.
- **Ratings are current, not historical**, unless you've pinned a specific
  threshold on the study — the "auto" default re-resolves your rating bucket
  every time you recalculate.
- **Local Stockfish depth is capped** (the same `SEARCH_DEPTH` as the Study
  editor's live analysis) — deep enough to be meaningfully accurate for an
  opening position, but it's a fixed-depth search on your own machine, not a
  cloud engine farm's deeper analysis. The only remaining *coverage* gap
  (as opposed to depth) is the small Cloud Eval fallback for out-of-tree
  opponent continuations, which can still genuinely miss (`404`) on obscure
  positions — those fall back to `0.0` and are counted in `evalMisses`.
- **Explorer data isn't cached across studies or across time**, and per-node
  evals aren't cached across *tree edits* — adding a move creates a node with
  no stored eval yet, live-fetched on the next "Calculate scores" until you
  re-run "Calculate evaluations". Within one run, positions repeated via
  transpositions are cached for that run only.

**Why these are manual buttons, not automatic:** the stats algorithm makes
one Opening Explorer request per position in your tree where it's the
opponent's move (plus a cloud-eval request per uncached leaf), and the evals
algorithm makes one cloud-eval request per node in the tree — both made
**sequentially**, since each depends on knowing which branch to expand next.
For a tree with dozens of branches, that's dozens of sequential HTTP
round-trips to Lichess: seconds, not milliseconds (hence the progress bars —
see §4). Recomputing this on every page load (or after every move while
editing) would make the app feel slow for no benefit, since a repertoire
doesn't change from one page view to the next.

## Stored shape

Cached on the study row as two separate columns, matching the two buttons:

```jsonc
// stats — from "Calculate scores", depends on explorerSettings
{
  "winProbability": 0.5276,
  "coverage": [0.253, 0.164, 0.068, 0.053, 0.035, 0.0008],
  "evalCp": 34.2,
  "evalMisses": 1,
  "calculatedAt": "2026-09-23T09:12:00+00:00",
  "database": "lichess",
  "minRating": 1600,
  "speeds": ["blitz", "rapid", "classical"],
  "nodesEvaluated": 47,
  "explorerCalls": 22
}

// evals — from "Calculate evaluations" (computed in the browser), independent of explorerSettings
{
  "byNode": { "0": 12.0, "1": -140000.0, "2": 34.2 },
  "calculatedAt": "2026-09-23T09:10:00+00:00",
  "misses": 0
}
```

The same "Calculate evaluations" request also sends `byFen` (off-tree
opponent replies, discovered via the current Opening Explorer settings —
see §4) — but that part isn't stored here at all. It's global, not
study-scoped, so it goes straight into the shared `cloud_eval_cache` table
instead; see `explorer-cache.md`'s "Stored shape" for that one's exact
shape.

`byNode` keys are tree node ids (as strings, since JSON object keys always
are); values are centipawns from **White's point of view** regardless of the
study's side (the sign flip to the studied side's POV happens when `stats`
consumes them). A capped mate value (`±100,000` for an actual checkmate on
the board, or a distance-adjusted value near it for a "mate in N" the engine
found without reaching it) means that node is decisive; `null` would mean a
miss, though local Stockfish practically never produces one — it's kept for
shape compatibility with the Cloud Eval fallback path, which can.

## Ideas for future stats

Not built yet, in rough order of how naturally they extend the same
tree-walk machinery:

- **`hit` probability** — the third objective from §2: instead of an average
  eval, "what fraction of the time does the position cross +1.0 (or a
  threshold you pick) by the end of my prep?" Same walk as expected eval,
  just a different leaf function (`1` if `|eval| > T`, else `0`) — cheap to
  add once expected eval exists, and answers a genuinely different question
  (a sharp gambit can have low expected eval but high hit probability).
- **Weakest branch report** — instead of one aggregate expected-score number,
  surface the specific opponent replies dragging it down most (weight ×
  (0.5 − score) per branch, sorted descending). Turns "your score is 53%"
  into "the score is 53% mostly because of your line against 3...Qb6."
- **Confidence / sample size** — positions with only a handful of recorded
  games give a noisy win/draw/loss estimate; a low-games-count badge (or a
  confidence interval) on the coverage chart and on leaf nodes would flag
  where the underlying data is thin, separate from where your own prep is
  thin.
- **Stats history over time** — `calculatedAt` is already stored per
  recalculation; keeping a short history (instead of overwriting in place)
  would let a study show a trend line as it's built out, or after the
  Opening Explorer's real-world move frequencies shift over time.
- **Prep depth, weighted by frequency** — the average ply at which prep
  actually ends, weighted by how often real games reach that point (distinct
  from coverage's per-move-number breakdown: a single number, "on average
  your prep runs out around move 9").
