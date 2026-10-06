# Practice tab

Design draft for a new tab: **choose a study, then drill it** — the app
quizzes you on your own repertoire's book moves and keeps a per-position
"knowledge" score that fades over time, so you always know what's actually
solid versus what's gone rusty. This single-study practice feature is
described in the README's [Practice section](README.md#the-practice-tab). It
uses the same study tree and optional [starting point](starting-point.md) as
the Stats page; see [How it works](README.md#how-it-works) for the shared
Explorer-weighted tree model.

**Status: implemented**, per the same "draft it, then build it" process used
for the starting-point feature. Code lives in `backend/app/practice.py`
(drill-item enumeration, the knowledge score, and the queue/attempt/summary
endpoints), `backend/app/store.py` (the `practice_state` table), and
`frontend/src/practice.ts` / `practice-session.ts` (the tab's list page and
drilling session). The rest of this doc is the original design; §5's
opponent-handling section notes the one place the implementation ended up
simpler than planned.

## 1. Motivation

The study page lets you build a repertoire tree; the Stats page tells you
how good that tree is *if you've perfectly memorized it*. Neither one tells
you whether you actually **have** memorized it, or which specific branch
you're shakiest on. That's the gap this fills: a place to rehearse the tree
move by move, and a running per-position number — not just a vague feeling —
for "do I actually know this."

The "fades with time" part matters as much as the drilling part. A position
you nailed three weeks ago and haven't looked at since is not equivalent to
one you nailed this morning, even though both currently show a perfect
streak — real memory decays, and a practice tool that doesn't model that
will happily tell you you're prepared for a line you'd actually blank on
over the board. §6 already sketches the forgetting-curve machinery this
reuses (`R(t) = exp(−t/τ)`); this doc adapts it into something one specific
study's tree — and eventually a real UI — can use directly.

## 2. Scope for v1

**In scope:**
- Practicing exactly one study's tree at a time (matches how Stats already
  works — no cross-study session in v1).
- Drilling only **your own side's** moves — the ones §5.1 calls the
  "expected answer." The opponent's replies are played *for* you (see §5
  below); there's nothing to know there, since you don't choose them.
- A per-node knowledge score, decaying over time, persisted per
  (study, node) so it survives closing the tab.
- A session queue mixing **due** reviews with **new** (never-drilled)
  positions, bounded in size.
- Starting from the study's [starting point](starting-point.md) when one is
  set, exactly like the Stats page's calculations do — same
  `_resolve_start_node_id` fallback-to-root logic, reused rather than
  reimplemented.

**Out of scope for v1** (noted here so they're not silently forgotten, not
because they're bad ideas):
- Play mode (§5.2) — sparring against Explorer-sampled opponent play with a
  value trajectory. Practice mode's opponent-move sampling (§5 below) is
  deliberately much dumber than this.
- The `hit` objective / leverage-based queue ordering from §5.1. v1 orders
  the queue by due-ness only (see §5), not by "biggest objective swing if
  you get this wrong" — leverage needs the Stats-tab machinery wired in as
  a queue-ranking signal, which is a reasonable v2.
- Cross-study dashboards ("everything due today, across all studies").
- Any visualization of knowledge *on* the Study editor's move tree (a
  heatmap coloring moves by freshness would read nicely there, reusing the
  same `.tree-move` styling hook the starting-point marker uses — left as a
  follow-up once the underlying score exists to visualize).

## 3. The knowledge score

Adapted directly from §6, one small change: §6 only starts decaying a move
*after* it's fully known (`c = 3`). Here, every position that's been drilled
at least once decays continuously from its first correct answer — a
half-learned position going stale is exactly as real as a fully-learned one
going stale, and showing a flat, non-decaying number for it would hide
that.

Each **drill item** is one tree node where it's the studied side to move
(exactly the nodes §5.1 already treats as "position + expected answer,"
since the tree already guarantees there's only ever one of your own moves
there to ask about). It carries:

```
streak      c ∈ {0,1,2,3}     consecutive correct answers (§6, unchanged)
stability   τ (days)          how slowly this item currently forgets
lastSeenAt  timestamp | null  when it was last answered (correct or not)
```

**On a correct answer:** `c += 1` (capped at 3), and `τ` grows — each
correct rep doubles it, same half-life-regression rule §6 already
specifies, just applied from the first correct answer rather than only
after reaching `c = 3`. `τ` starts at `τ₀` (a per-profile constant, §7 —
defaulted to 1 day) on a position's very first correct answer.

**`τ` keeps doubling even once `c` is already at its cap.** The two update
rules are independent: `c`'s cap only stops the *streak counter* from
climbing past 3, it doesn't stop `τ` from continuing to grow on every
correct answer after that. Concretely: you're at `c = 3` with some `τ`, and
— whatever `R(t)` currently is, even well below 100% — you answer correctly
again. The result is `c = 3` (unchanged, still capped) and `τ` doubled
again; `lastSeenAt` becomes now, so `R(t) = exp(0) = 100%` at that instant,
and the displayed score is `(3/3) · 100% = 100%` regardless of what it was
a moment before you answered. What the *prior*, decayed `R(t)` value
actually did was determine whether the position showed up as due for you to
answer in the first place (§5) — once you answer it, correctly, that stale
number is simply superseded by a fresh one. This is standard spaced-
repetition behavior (a mature item's interval keeps growing every time it's
successfully recalled, not just until it first reaches "known") — it just
isn't obvious from the `c ∈ {0,1,2,3}` capped-counter framing above, so it's
worth being explicit about it here.

**On a wrong answer:** `c` drops to 0 and `τ` resets to `τ₀` — a lapse means
next time really is "starting over" for spacing purposes, not just a
streak ding. (§6's original wording — "a lapse costs one streak step, not
the whole climb" — described lapsing *after* mastery, i.e. `c: 3 → 2`. Here,
resetting fully on any wrong answer is the simpler, harsher rule; §7 below
flags it as a parameter worth revisiting once there's real usage to look
at.)

**Retention** at any moment: `R(t) = exp(−t/τ)`, `t` = days since
`lastSeenAt`. This is the part that fades — it's 100% right after a correct
answer and decays continuously from there, faster for low-`τ` (fresh,
fragile) items than high-`τ` (well-rehearsed) ones.

**The displayed knowledge score** for a node:

```
knowledge(node) = "Not started"              if lastSeenAt is null
                 = (c / 3) · R(t) · 100%      otherwise
```

The `c / 3` factor matters: a position answered correctly *once* today
(`c = 1`, `R(t) ≈ 100%`) shows as **33%**, not 100% — one rep isn't mastery
just because it's recent. A position mastered weeks ago and gone stale
(`c = 3`, `R(t) = 40%`) shows **40%** — mastery that's faded is genuinely
worse than fresh partial progress, and the score should say so.

A node becomes **due for review** once `R(t)` drops below a threshold
(default 80%, same constant §6 already names `retention_floor`) — that's
what populates the practice queue (§5), independent of what number is
currently displayed for it.

## 4. Data model

New, separate from the study's `tree` blob — this changes far more often
than the tree structure does (every practice rep, not every edit+Save), so
it doesn't belong inside the JSON tree the way `startNodeId` does. Modeled
the same way the cache tables in [explorer-cache.md](explorer-cache.md) are:
its own SQLite table, one row per (owner, study, node):

```sql
CREATE TABLE practice_state (
  owner       TEXT NOT NULL,
  study_id    INTEGER NOT NULL,
  node_id     INTEGER NOT NULL,
  streak      INTEGER NOT NULL DEFAULT 0,
  tau_days    REAL NOT NULL DEFAULT 1.0,
  last_seen_at TEXT,          -- NULL until first attempt
  PRIMARY KEY (owner, study_id, node_id)
)
```

`knowledge(node)` (§3) is computed on read from these three columns plus
"now" — never stored as a number itself, so changing `τ₀` or the decay
formula later doesn't require a migration, just recomputation.

**Staleness on tree edits**, same backstop instinct as
[starting-point.md](starting-point.md#data-model)'s "validity re-checked on
every calculation": deleting a subtree orphans its `practice_state` rows
(nothing references a `node_id` that no longer exists in the tree) — they're
simply ignored, and can be swept in a periodic cleanup rather than needing
to be deleted transactionally at delete-time. Re-adding "the same" move
later gets a **new** `node_id` (ids are never reused — see `tree.ts`'s
`nextId`) and therefore starts with no practice history. That's intentional,
not a bug to fix: if you deleted a line and rebuilt it, treating it as a
brand-new thing to learn is the honest answer, not carrying over a stale
streak from a branch that, structurally, doesn't exist anymore.

## 5. Session mechanics

**Starting a session** picks a study and builds a queue:
1. Every drill-item node (studied side to move) reachable from the study's
   [effective starting point](starting-point.md) that's either **due**
   (`R(t) < retention_floor`) or **new** (`lastSeenAt` is null).
2. Capped at a session-size setting (default 20 — an Anki-style bounded
   session, not "clear the whole backlog every time").
3. v1 ordering: due items first (oldest `lastSeenAt` first), then new items
   in tree order. **Not** leverage-ranked (§2 "out of scope") — that's a
   deliberately simple starting point, not a claim that due-order is
   optimal.
4. If that leaves the queue empty (nothing due, nothing new) but the study
   does have drill items, the queue falls back to a **voluntary review**
   rather than an empty session — practice is opt-in on demand, not
   something the schedule should be able to lock you out of just because
   it's satisfied for now. That fallback pool is **every item that isn't
   already at a full, rounded 100% knowledge**, oldest `lastSeenAt` first;
   only if literally everything is at 100% does it fall back further, to
   all of them (there's nothing left to prioritize at that point — see the
   session view's 100% celebration in §6). Excluding maxed-out items here
   isn't just about queue *contents* — it's what makes the walk (§5 below)
   actually *start* somewhere useful: since the walk only pauses to quiz at
   selected nodes and silently auto-plays everything else, a queue that
   included every item in a mostly-mastered line would force you to
   re-answer the whole already-known prefix before reaching whatever
   actually needs review. Excluding it removes those nodes from the
   selected set, so the walk auto-plays straight through that prefix and
   the session starts right at the first move that isn't already perfect,
   not at the beginning of the line.

**Walking the tree during a session:**
- At a **studied-side node** (a queue item): show the position, wait for you
  to make a move on the board.
  - **Correct** (matches the tree's recorded SAN): apply the §3 update for a
    correct answer, brief positive feedback, continue into that child.
  - **Incorrect**: apply the §3 update for a wrong answer (once — see
    below), then let you try again at the same position rather than
    immediately revealing the answer and moving on. A retry that's also
    wrong just prompts again; a retry that's correct continues into that
    child exactly like a first-try correct answer would. A **"Show
    answer"** option (available once the first attempt has been graded)
    plays the correct move and moves on, for when you're genuinely stuck
    rather than one slip away — a session should eventually finish the
    line, not dead-end on a single mistake, but it also shouldn't yank the
    answer away before you've had a real second attempt. Only the *first*
    attempt at a position is graded (recorded in the knowledge score and
    the session history); further retries at that same position don't
    grade again, so guessing repeatedly can't inflate the score.
- At an **opponent node**: the app picks the reply for you — no waiting,
  no grading, since you're not the one deciding these.

  **As shipped**, this ended up simpler than sampling: the frontend
  precomputes which branches contain a due/new item at all (a node is
  "relevant" if it's selected or has a selected descendant) and walks
  every relevant branch deterministically, skipping irrelevant ones
  entirely rather than choosing one at random. Since a branch with nothing
  due or new in it wouldn't have been sampled usefully anyway, and a branch
  *with* something due can't be skipped without losing that review, there
  turned out to be nothing left to actually sample — every branch worth
  visiting gets visited, every branch not worth visiting gets skipped, no
  randomness needed. Frequency-weighting (the original idea here) remains
  future work if this ever needs to prioritize *which* of several relevant
  branches to show first, rather than just "all of them."
- At a **leaf** (end of the prepared line, or the position leaves the tree
  entirely): the line is done; move to the next queued item.

**Ending a session:** when the queue is empty, or you stop early. Either way,
a short summary — items seen, correct/incorrect, and the study's new
aggregate knowledge (mean `knowledge(node)` over all drill-item nodes) —
matches the "Moves known / Due for review" counters §6 already names for
the (still-unbuilt) study dashboard.

## 6. UI

**A new "Practice" tab** in the site nav.

**Practice landing page:** one card per study (same visual language as the
study cards on the home page), each showing:
- Aggregate knowledge (mean `knowledge(node)` across drill-item nodes).
- Due count ("6 due for review") and new count ("12 not started").
- A **Practice** button, disabled only when the study has no moves of its
  own to drill at all. Practice is never gated by the schedule itself —
  having nothing due or new just means a session falls back to a voluntary
  review of whatever isn't already at 100% (§5), rather than refusing to
  start one. The whole point of tracking knowledge as a fading, ongoing
  number (§3) is defeated by a hard stop that says "come back later."

**Session view:** reuses the Study editor's board component (same
chessground instance, same piece/board theme lookup) with the Opening
Explorer panel hidden — this view is about recall, not looking up real
games. Below the board: the current queue position (e.g. "Item 4 of 20"),
and after each attempt, a brief correct/incorrect indicator with the SAN
either way, plus a running history of every position attempted this
session with its resulting knowledge score, so the fading/scoring
mechanism stays legible rather than a black box.

**As shipped**, the Study editor's Stockfish toggle isn't hidden after
all — it's carried over as an explicit "explore this position" option,
available at any point in the session (the prompt, mid-retry, or after an
answer). It's read-only here (arrows and a ranked eval list, no
click-to-play): practice mode is about answering from memory, not
searching for a better move, but understanding *why* a missed move was
right is squarely in scope, and re-deriving the Study editor's whole
analysis panel from scratch for that would have been wasted effort when
the existing one already does the job.

**Reaching 100% knowledge** (rounded, matching the header's own knowledge
badge — see §3 on why hitting the displayed 100% is achievable even though
the underlying aggregate almost never lands on an exact 1.0) pauses the
otherwise open-ended session with a one-time celebration instead of quietly
rolling into the next round: a short animation, then an explicit choice —
**End session** or **Continue practicing**. Fires once per tab visit, not
on every subsequent correct answer that happens to still be at 100%.

## 7. Implementation notes

- `backend/app/store.py`: new `practice_state` table (§4), migrated in like
  every other table this app has added incrementally; `get_practice_state`/
  `upsert_practice_state`/bulk `get_practice_states(owner, study_id)`
  following the existing `get_*_cache`/`set_*_cache` naming pattern (even
  though this isn't a cache — it's the closest existing convention).
- `backend/app/stats.py` or a new `backend/app/practice.py`: pure functions
  for the §3 update rules and `knowledge(node)`, plus queue-building (§5.1)
  — kept separate from the `_Evaluator` backward-induction walk in
  `stats.py`, since practice walks the tree *forward* (root/starting-point
  toward leaves) rather than backward from leaves.
- `frontend/`: new `practice.html` (+ `practice.ts`) for the landing page,
  and a session view — either its own page or a mode of `study.html`, given
  how much of the board/theme/move-tree plumbing it can share. Worth
  deciding once the session view's exact interaction (§6) is being built,
  not before.
- Reuses `_resolve_start_node_id` from `stats.py` (§2) rather than
  duplicating the "fall back to tree root if the stored id is gone" logic a
  third time.

## 8. Open questions

- Is full streak-reset-on-any-wrong-answer (§3) too harsh in practice? Anki
  and most SRS tools are gentler on lapses after real mastery. Easy to
  tune once there's a real study to test it against — flagged here so it
  isn't forgotten as "the simple version, not necessarily the right one."
- Should `τ₀` and `retention_floor` be per-profile settings (§7 of the main
  README already reserves `[mastery]` for exactly this) from day one, or
  hard-coded until there's a reason to expose them? Leaning toward
  hard-coded for v1 — nothing else in the shipped web app reads a profile
  file yet, and inventing that plumbing just for two constants is premature.
- Uniform vs. frequency-weighted opponent sampling (§5) — noted as a v1
  simplification above; revisit once practice mode is actually used.
- **Should "known" (`c = 3`) and "memory" (`R(t)`) be shown as two separate
  numbers instead of one blended `knowledge(node)`?** They're already
  tracked as two independent fields (§3) — the blending into a single `%`
  is purely a display choice, not something baked into the data model. The
  case for splitting them: right now a faded-but-once-mastered position
  (`c = 3`, `R(t) = 40%` → shows 40%) and a fresh-but-shallow one (`c = 1`,
  `R(t) ≈ 100%` → shows 33%) land on visually similar numbers for very
  different reasons — one is a mastered position that needs a refresher,
  the other has never really been proven. A UI that showed "✓ known, 40%
  fresh" versus "learning (1/3), 33%" would make that distinction legible
  without doing any math in your head. The case against: it's two numbers
  to parse instead of one, in a UI that's already showing a lot of state
  (progress, prompt, history, engine panel). Not decided; the blended
  version is what's shipped.
