# Study starting point

Companion doc to ["The Studies tab"](README.md#the-studies-tab) and
["The Stats tab"](README.md#the-stats-tab) / [stats.md](stats.md). Covers a
new, optional per-study field: which position a study's calculations should
treat as move one, instead of always the real starting position.

## Motivation

Every stat on the Stats page — win probability, coverage, expected
evaluation — is currently computed by walking the tree from the *actual*
starting position of the game (`tree.rootId`). That's the right default, but
it's not always the question you want answered. If your repertoire is really
about a specific, well-known tabiya reached after a few "obvious" or
near-forced moves, you may not care how the stats look diluted by the
(usually very high) probability of even reaching that position — you want to
know: *assuming I'm already here, how does the rest of my prep hold up?*

Example: a study starts `1.b3 e5 2.Bb2 Nc6`, and everything interesting
about the repertoire begins at that point. Marking that position as the
study's starting point makes every stat answer "from here," not "from the
first move of the game" — coverage starts at 100% there instead of already
having decayed through moves 1-2, and win probability / expected eval stop
being weighted by how often Black even plays into that exact sequence.

## What it does *not* change

- **The tree itself.** Every position, every move, every branch stays
  exactly as built — this is a *lens* on the existing tree, not a way to
  trim it. You can still navigate to, edit, and delete moves before the
  starting point exactly as before.
- **Move numbers shown in the move list.** The Study editor's PGN-style
  view keeps showing true, absolute move numbers (`1.b3 e5 2.Bb2...`) —
  marking `2.Bb2` as the starting point doesn't renumber it as "move 1."
  Real move numbers are what you use to navigate and edit; the starting
  point is a separate, purely computational concept.
- **Explorer/eval caching.** `explorer_cache` and `cloud_eval_cache` are
  keyed by FEN, not by study or by "move number from some starting point" —
  entirely unaffected.

## What it does change

- **Where the backward-induction walk begins.** `score`, `coverage`, and
  `eval_score` (see `stats.md`) all already take a `node_id` to start
  walking from; today that's always `tree.rootId`. With a starting point
  set, it's that node instead. Everything downstream is identical — the
  algorithms don't know or care that they didn't start at the real root.
- **Coverage's move numbers.** Since coverage counts moves *from wherever
  the walk started*, "move 1" on the chart becomes the first opponent reply
  *after* the starting point, not after the game's first move. The Stats
  page notes this explicitly when a study has a non-default starting point,
  to avoid the exact "why does this only go to move 3" confusion a plain
  move count invites.

## Data model

A new, optional per-study field, alongside `side` and `explorerSettings`:

```jsonc
"startNodeId": 4  // or null — "no override, use the tree's real root"
```

`null` (the default for every existing and new study) means exactly what
happens today: walks start at `tree.rootId`. A study never *needs* a
starting point — this is purely opt-in.

**Validity is re-checked on every calculation, not just when set.** If the
node a study's `startNodeId` points to gets deleted (its whole subtree
removed), the stored id would no longer exist in the tree. Rather than
erroring, the backend falls back to `tree.rootId` automatically whenever the
stored id isn't found — the same "degrade gracefully, don't fail" instinct
used elsewhere in this app (e.g. the Explorer/rating caches' stale-fallback
behavior). The editor also proactively clears `startNodeId` client-side the
moment you delete a subtree containing it, so the stored value shouldn't
usually even go stale in the first place — the backend check is a backstop,
not the primary mechanism.

## UI

**Setting it, in the Study editor:** a new button next to "Go to start" /
"Delete this move" — **"Set as starting point"** when the currently-selected
move isn't already the starting point, or **"Clear starting point"** when it
is (clearing resets to the real root, i.e. `null`). No separate confirmation
dialog — same low-friction pattern as the rest of the editor's move actions.

**Showing it, in the tree:** the designated node's move text is colored a
distinct yellow (`#e0c93f`), separate from the existing "this is your move"
(blue text) and "you're here" (highlighted background) states. If a node is
both the starting point and one of your own moves, the starting-point color
takes precedence — it's the more specific thing to call out in that spot.

**Showing it, next to the study name:** a small badge in the name row (where
the side badge already lives) — "Starts at move N" (from the position's own
true move number) when a starting point is set, omitted entirely when it's
just the real root (the common case, no need to state the obvious).

**Showing it, on the Stats page:** when a study has a starting point set,
the win-probability and expected-eval cards' meta text says so ("from move
N onward"), and the coverage section's explanation is qualified the same
way — so looking at the Stats page alone (without also checking the editor)
is still enough to understand what the numbers actually mean.

## Implementation notes

- `backend/app/store.py`: new nullable `start_node_id` column on `studies`,
  migrated in like every other column this app has added incrementally.
- `backend/app/studies.py`: `StudyIn.startNodeId: int | None = None`,
  threaded through `create_study`/`update_study` the same way `side` is.
- `backend/app/stats.py`: `_Evaluator.coverage` gains a `start_node_id`
  parameter (it currently hardcodes `tree["rootId"]` internally — `score`
  and `eval_score` already take a `node_id` argument, so they need no
  signature change at all). Both job functions resolve the effective start
  node once (falling back to root if the stored id is missing from the
  current tree) and pass it to all three calculations.
- `frontend/src/tree.ts`: `renderTree`/`renderLine` take a `startNodeId`
  parameter purely for the visual marker — they don't change *what* gets
  rendered, only how one node is styled.
- `frontend/src/study.ts`: local editor state gains `startNodeId`, mutated
  by the new button, included in the save payload, and defensively cleared
  if the current delete action would remove it.
