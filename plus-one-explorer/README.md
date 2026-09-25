# Plus One Explorer

> Measure how much advantage your opening line really yields against the moves
> people actually play — using Lichess opening-explorer statistics and engine
> evaluations — then train on the branch points that decide it.

**Status:** design phase · **Language:** Python (CLI first) · **Data:** Lichess APIs

---

## 0. Web app prototype (Chesster)

Ahead of the CLI-first roadmap below, a working web app already implements the
"opening studies" idea end to end: **Chesster** — a small FastAPI backend
(`backend/`) plus a static TypeScript/Vite frontend (`frontend/`), with
Lichess OAuth login and a real chessboard (`chessground`, the library
lichess.org itself uses).

### Running it

```bash
# backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload   # http://127.0.0.1:8000

# frontend (separate terminal)
cd frontend
npm install
npm run dev                               # http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173` and sign in with Lichess (no app registration
needed for local dev — see `backend/app/config.py`).

### Pages

| Page | What it does |
| --- | --- |
| Home | Lichess-style empty shell (header, nav, sign-in) |
| Profile | Your bullet/blitz/rapid/classical ratings, pulled from `/api/account`, with Lichess's own rating icons |
| **Studies** | Create and edit opening repertoires — see below |
| **Stats** | Expected-score card per study — see below |

The board itself renders using **your actual Lichess board theme and piece
set** (`GET /api/account/preferences`, scope `preference:read`): Chesster
hotlinks the matching background and piece SVGs straight from lichess.org's
own asset CDN rather than bundling every theme, so it always matches what you
see on lichess.org. Falls back to the default brown/cburnett look if you're
signed out or haven't re-logged-in since this was added.

### The Studies tab

A **Study** is a repertoire: a name plus a tree of positions, not just one
line. It's modeled as a flat map of nodes (`{id, san, parentId, children}`)
rather than a single move list, so a study can hold a main line plus any
number of side variations — exactly like a real PGN with variations.

Each study also has a **side** (Playing White / Playing Black), chosen **only
when first creating the study** — the picker is a `<select>` on a brand-new
study, but a plain read-only badge once it exists (enforced server-side too:
`PUT /api/studies/{id}` always keeps the study's original `side`, ignoring
whatever the client sends). It's needed for the Stats tab below to know whose
moves are "book" and whose are the opponent's, and changing it after the fact
would silently invalidate that whole calculation.

**Editing (`study.html`):**
- Play moves directly on the board. Playing a move appends it as a child of
  wherever you currently are in the tree.
- If you replay a move that's already there, it just navigates into that
  existing branch instead of duplicating it; playing something new creates a
  fresh variation — **except for the studied side's own moves**, where only
  one reply is ever allowed at a given position (the opponent can still
  branch freely). Trying to play a second, different move of your own there
  is rejected with a message telling you to delete the existing one first —
  this keeps "perfect memorization" in the Stats tab meaningful: there's
  always exactly one thing you'd play, never an ambiguous choice.
- The move list next to the board is a clickable PGN-style tree: the main
  line reads left to right, and any variation appears in parentheses. Click
  any move (mainline or variation) to jump the board there.
- **Delete this move** removes the selected move and everything under it
  (disabled on the root — you can't delete the starting position).
  **Go to start** jumps back to the beginning.
- **Save** persists the whole tree to `/api/studies` (SQLite-backed,
  per-Lichess-account).

**Stockfish toggle:** checking "Stockfish" next to the tree runs a real
engine — [Stockfish 19, the "lite single-threaded" WASM build](https://github.com/nmrugg/stockfish.js)
— entirely client-side in a Web Worker. It analyzes with `MultiPV 5` (the
top 5 candidate moves, not just one) and shows them two ways at once:
- **On the board:** five arrows via chessground's own `drawable.autoShapes`
  API (the same mechanism, and the same board library, lichess.org's
  analysis page uses), colored in a green → red gradient by rank — reusing
  chessground's own built-in Lichess-style brushes (`green`, `paleGreen`,
  `yellow`, `paleRed`, `red`) rather than inventing new colors.
- **As a ranked list** below the toggle: each line's move (in SAN) and eval,
  with a colored dot matching its arrow. Clicking a line plays that move,
  exactly like the Opening Explorer rows.

The lite/single-threaded build was chosen deliberately: it needs no
`Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers (the
multi-threaded build requires `SharedArrayBuffer`, which does), and at
≈1.7 MB it's far smaller than the full engine — while still being much
stronger than any human. Files live in `frontend/public/engine/`
(GPLv3, see the bundled `LICENSE.txt`) and are only loaded (the engine is
only instantiated) the first time you check the box, not on every page load.
Re-analysis happens automatically every time you navigate the tree; a stale
in-flight search is stopped and its result discarded if you move again
before it finishes.

**Opening Explorer panel:** below the board, Chesster shows real move
statistics for whichever position you're currently viewing, pulled from
Lichess's own opening explorer (`GET https://explorer.lichess.org/lichess` or
`/masters`, which now requires *some* signed-in Lichess account — no special
scope, just "not anonymous"). Responses are cached persistently (shared
across every study, not just yours) rather than fetched fresh every time —
see **[explorer-cache.md](explorer-cache.md)** for why and how — so the
panel's header also shows **when** that data was fetched ("Fetched 3h ago",
exact timestamp on hover).

It's **toggleable and customizable per study** — a small settings row above
the panel lets you turn it off entirely, or change:
- **Database:** "Players" (default, all rated Lichess games) or "Masters".
  Masters has no rating filter (it's already an elite-only dataset), so the
  rating picker and speed checkboxes both disable themselves in that mode.
- **Minimum rating:** defaults to **"My current rating"** — dynamically
  resolved *each time* to the bracket containing your current rating and
  every bracket above it (e.g. a 1734 rating → `1600,1800,2000,2200,2500`),
  using your **rapid** rating, falling back to blitz then classical if rapid
  is unrated (1500 default if none are established). Pick a specific
  threshold instead (e.g. "2000+") to pin it — that fixed value is then
  saved with the study instead of tracking your rating over time.
- **Speeds:** a checkbox per format — Bullet, Blitz, Rapid, Classical
  (ultra-bullet and correspondence aren't offered at all: too noisy / too
  rare to be worth the UI clutter). Blitz + Rapid + Classical are checked by
  default; at least one must stay checked.

These settings are saved as part of the study (`explorerSettings`:
`{enabled, database, minRating, speeds}`, where `minRating: null` means
"always use my current rating"), so each study remembers its own explorer
configuration — and the **Stats tab's** recalculation uses these same
settings too, not a separate hardcoded set.

Each row shows a move with its white/draw/black bar, the same three
percentages spelled out in text under the bar, and the total game count at
your level; **clicking a row plays that move**, adding it to the tree exactly
like playing it on the board — so building a repertoire out of what strong
players actually play is a couple of clicks, not manual entry.

### The Stats tab

Each study card shows an **expected score**: roughly "if I've perfectly
memorized this repertoire, what fraction of a point do I score on average
against real opposition?" It's a first, simplified implementation of the
`escore` objective sketched in §2 below — restricted to exactly the tree
you've built, rather than the full Markov-chain expansion over the whole
opening space that §2 describes.

A study's detail page adds two more views onto the same tree walk: a
**coverage chart** (how often real games are still following your prep, move
by move) and the **expected Stockfish evaluation at the end of your prep**
(via Lichess's free Cloud Eval API) — plus the study's Opening Explorer
settings, editable right there, so you can recalculate all three against a
different database/rating/speed pool without leaving the page.

See **[stats.md](stats.md)** for the full write-up: the algorithm, every
stat's exact definition, all the assumptions/simplifications baked in
(perfect memorization, capped explorer move lists, sparse cloud-eval
coverage, etc.), why recalculation is manual rather than automatic, and a
list of stats that would make sense to add next.

Not built yet: the `hit` objective (P(reach +N)) from §2 below, and the
practice/puzzle mode from §5 — the tree you build in Studies is the
foundation those will eventually also use.

---

## 1. Motivation

Opening explorers tell you what people *play* and how those games *ended*, but not:

- **What is the chance this line actually turns into a winning position?**
  A move may score 55% at my rating while almost never producing a +1 engine
  advantage; another may reach +1 in half its branches but score worse because
  players mishandle the follow-up.
- **Where should I invest training time?** Which branch points matter most for
  steering the game toward positions I can convert?
- **What does "advantage" even mean here?** A fixed cutoff like "+1" is one
  arbitrary answer. Sometimes you care about the *chance* of breaking through,
  sometimes about the *average* edge you walk out with, sometimes simply your
  *expected score*. The goal should be a choice, not a constant.

Plus One Explorer combines explorer transition statistics with engine evaluations
to answer all three, then turns the answers into drills.

## 2. Core idea

Treat an opening as a **Markov chain over positions**:

- **States** = positions (FEN nodes) reachable within a depth budget `D`.
- **Transitions** = moves played by real players, weighted by their frequency in
  the opening explorer (filtered by database, speed, and rating band).

Every node gets a value `V` computed by backward induction:

```
V(node) = leaf(node)                                   if ply >= D or goal met
V(node) = Σ_moves freq(move) / Σ_freq × V(child)       otherwise
```

The fixed threshold "+1" is **not** baked in: what varies is the *objective* —
the choice of leaf values and stopping rule. The solver is shared; objectives are
plugins.

### Objectives

| Objective | Question it answers | Definition |
| --- | --- | --- |
| `hit` | How likely do we *reach* an advantage? | `V = 1` once eval crosses threshold `T` (default ±1.0), else `0` at depth cap → hitting probability |
| `eeval` | How big is the advantage *on average*? | `leaf = eval(node)` in pawns at the frontier → expected evaluation (centipawns) under human play |
| `escore` | What does that mean in results? | like `eeval`, but leaves mapped through the Lichess win% model `50 + 50·(2/(1+e^(−0.00368208·cp))−1)` → expected score for White, 0–100% |

Notes:

- All objectives are **side-relative**: values are reported from the chosen
  player's POV (Black lines invert the sign / complement the score).
- `hit` answers "does this line *get me somewhere*", `eeval`/`escore` answer
  "where do I stand if I just play along". They often disagree, which is itself
  informative: a gambit may have low expected eval but high hit probability.
- Thresholds, depth, and objective are CLI/config options; custom leaf functions
  (e.g. material-count, mate-distance caps) can be added as new plugins later.

## 3. Features (planned)

| Feature | Description |
| --- | --- |
| Opening studies | Create and manage studies (a line/tree + pool + progress); dashboard shows the three headline metrics |
| Line analysis | Objective value for a specific move sequence, plus per-move contribution breakdown |
| Pluggable objectives | `hit` / `eeval` / `escore` (and custom leaf functions) via one shared solver |
| Tree scan | Walk all continuations of an opening; rank sidelines by objective value |
| Puzzle mode | Feeds you the position where finding the right move increases the objective the most |
| Play mode | Simulates opening play against moves sampled from real-player probabilities |
| Mastery tracking | A move is "known" after 3 correct solutions in a row, with memory decay bringing it back |
| Rating-aware stats | Player pool is configurable: rating bands, speeds, database — set once in a profile |
| Eval sources | Lichess cloud eval API first, local Stockfish fallback, SQLite cache |
| Export | JSON/CSV of the annotated tree; PGN with `%obj` annotations |

## 4. Opening studies

A **study** is the app's central object: one opening repertoire slice plus its
training state. Created from a FEN, a SAN line, an ECO code, or a PGN file:

```bash
p1x study create --name najdorf-club --profile club-1600 \
                 --line "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6"
```

Each study keeps: its root position/line, the tree grown so far, the profile
(pool + objective settings) it is scored under, and per-move mastery state.

### Dashboard metrics

Every study surfaces three headline numbers, computed under its profile:

```text
$ p1x study show najdorf-club
Study                        najdorf-club          pool: blitz 1400-1600
Line                         B90 Najdorf, 12 plies

Expected eval at end of prep                       +0.42
P(reach +1 during prep)                             31%
P(reach +2 during prep)                              9%

Moves known                                   18 / 24
Due for review                                      6
```

- **Expected eval at end of prep** — the `eeval` objective at the frontier:
  the average evaluation you walk out with against your pool's replies.
- **P(reach +1)** and **P(reach +2)** — the `hit` objective at two thresholds,
  i.e. how often human play steers the line into a clearly winning position.

The three are deliberately shown together: expected eval says how good the
*average* outcome is, the hit probabilities say how often it becomes *decisive*
— openings trade those off differently. Thresholds stay configurable; ±1 and
±2 are just the default pair.

## 5. Training modes

Two complementary modes share the same tree and objective machinery.

### 5.1 Puzzle mode

Finds the positions worth drilling and feeds them one by one.

- **Selection ("leverage")**: for each branch point compute

  ```
  leverage(node) = V(child_best) − Σ_moves p_pool(move) · V(child)
  ```

  i.e. the gain from playing the best move instead of doing what your pool
  typically does. The queue serves the highest-leverage unsolved positions,
  so every rep targets the biggest possible objective increase.
- **Prompt** is objective-aware (`hit`: *"find the move most likely to get you
  to +1"*; `eeval`/`escore`: *"keep the biggest edge"*). Answers in SAN, graded
  by resulting `V`.
- The queue order combines leverage with scheduling state (§6): due moves first,
  then highest-leverage new positions.

### 5.2 Play mode

Sparring against the statistics themselves: the tool plays out opening positions
with you, sampling opponent replies **∝ move frequency in your selected pool**
(the Markov chain from §2, made playable).

- You enter your moves in SAN; the simulator answers with pool-representative
  moves (minimum-game cutoff and smoothing configurable).
- A session runs until the depth cap, an objective stopping rule fires, or the
  game leaves analyzed coverage; then you get the **value trajectory**: `V`
  after every ply, with the plies where your choice lost more than a gap `g`
  flagged.
- Those flagged plies are **auto-enqueued into puzzle mode** — play mode is the
  discovery mechanism, puzzle mode the repair mechanism.

## 6. Mastery & scheduling

A move is only counted as **known** once its solution has been answered
correctly **three times in a row** — one lucky guess is not knowledge.

Each drill item (position + expected answer) carries:

```
streak c ∈ {0,1,2,3}        consecutive correct solutions
strength s = c / 3          1.0 ⇔ known
retention R(t) = exp(−t/τ)  forgetting curve, t = days since last review
```

- **Correct answer** → `c += 1`; wrong or skipped → `c = 0`.
- On reaching `c = 3` the move enters the known set and review intervals grow:
  each full mastery cycle doubles the time constant `τ` (half-life regression,
  FSRS-style but deliberately simple).
- **Memory decay**: as `R` falls below a threshold (default 80%), the move drops
  back into the due queue with `c −= 1` — a lapse costs one streak step, not the
  whole climb.
- Parameters (`τ₀`, retention threshold, streak length) are per-profile config,
  not hard-coded constants.

This gives the "Moves known / Due for review" counters on the study dashboard
and interleaves with leverage ranking in puzzle mode.

## 7. Settings & profiles

All statistics are computed **for a selected player pool**, never globally.
A profile is a small TOML file:

```toml
[pool]                       # who the statistics describe
db = "lichess"               # lichess | masters
speeds = ["blitz", "rapid"]  # bullet | blitz | rapid | classical
ratings = [1400, 1600]       # explorer rating buckets (e.g. 1000,1200,1400,...)

[objective]
depth = 12                   # plies before the frontier ("end of prep")
hit_thresholds = [1.0, 2.0]  # P(reach +T) shown on the study dashboard

[train]
mode_gap = 0.05              # play mode: flag plies losing more than this
min_games = 50               # ignore rarer moves when sampling opponents

[mastery]
streak = 3                   # correct answers in a row to know a move
retention_floor = 0.80       # below this predicted retention, review is due
half_life_days = 2.0         # τ₀; doubles every completed mastery cycle
```

Profiles are named (`~/.config/p1x/club-1600.toml`) and referenced everywhere:
`p1x analyze --profile club-1600 ...`. Pool choice affects transition weights,
objective values, leverage ranking, and opponent sampling alike — switching
profiles re-scores the same tree without refetching move lists. Studies store
the name of the profile they were created with.

## 8. Data sources

| Source | Endpoint | Notes |
| --- | --- | --- |
| Opening explorer | `GET https://explorer.lichess.org/{lichess,masters}\?fen=..\&speeds=..\&ratings=..` | Move list with game counts and W/D/L. Moved from the old `explorer.lichess.ovh` host and now requires a signed-in OAuth token (no special scope, just not anonymous) |
| Cloud eval | `GET https://lichess.org/api/cloud-eval?fen=..&multiPv=1` | Free, cached server evals; sparse coverage |
| Local Stockfish | UCI via `python-chess` | Fallback + verification at fixed depth/nodes |
| Openings reference | `https://github.com/lichess-org/chess-openings` | ECO names for reporting |

Free, but rate-limited, and the explorer now needs a Lichess OAuth token;
cache aggressively — opening trees are highly transpositional, key them by FEN.

## 9. Architecture sketch

```
plus_one_explorer/
├── cli.py            # argparse front-end (study / analyze / train / scan commands)
├── profile.py        # TOML profiles: pool, objective, training, mastery settings
├── store.py          # SQLite: studies, trees, eval cache, scheduling state
├── tree.py           # BFS over explorer responses, transposition-safe node store
├── objectives.py     # hit / eeval / escore plugins (leaf values + stopping rule)
├── probs.py          # shared backward-induction solver over the node graph
├── evals.py          # EvalProvider: cloud -> stockfish -> cache
├── play.py           # play mode: pool-weighted move sampling + value trajectory
├── puzzles.py        # puzzle mode: leverage ranking + due queue
├── mastery.py        # streaks, retention decay, review scheduling
└── export.py         # JSON / CSV / PGN writers
```

CLI sketch:

```bash
# studies
p1x study create --name najdorf-club --profile club-1600 --opening "B90"
p1x study list
p1x study show najdorf-club        # dashboard: 3 metrics + known/due counters

# analysis
p1x analyze --profile club-1600 --line "e4 e5 Nf3 Nc6 Bc4" --objective eeval
p1x scan   --profile club-1600 --fen start --white --plies 4 --objective escore --top 10

# training
p1x train --study najdorf-club --mode puzzle --count 10
p1x train --study najdorf-club --mode play --as white
```

## 10. Roadmap

1. **v0.1** — line analysis CLI with pluggable objectives (`hit`, `eeval`),
   cloud-eval + cache, TOML profiles
2. **v0.2** — tree scan + ranking, local Stockfish fallback, CSV/JSON export
3. **v0.3** — opening studies + dashboard metrics, SQLite storage
4. **v0.4** — puzzle mode with leverage queue and mastery scheduling
5. **v0.5** — play mode with pool sampling and value trajectory
6. **v1.0** — cross-session spaced repetition polish, web front-end (optional),
   PGN annotation export

## 11. Limitations & caveats

- Explorer frequencies reflect *human popularity*, not move quality; low-sample
  branches need smoothing (add-k or minimum-game cutoffs).
- Engine eval near ±1 is fuzzy; treat 0.8-1.2 as a gray zone (configurable).
- `eeval` is sensitive to what happens at the frontier: positions where explorer
  coverage or analysis runs out need an explicit extrapolation policy (freeze
  eval, clamp, or deepen Stockfish) — document and make it configurable.
- Draw rates differ hugely by rating band — always compare like pools (the
  profile system exists for exactly this).
- Play mode's opponent is an *average* of the pool: it never adapts and, with
  frequency sampling, rarely plays rare-but-critical replies. Use `min_games`
  tuning and treat rare sharp lines separately.
- The mastery model (streak of 3, exponential decay) is a heuristic; its
  parameters should be tuned against real recall data before being trusted.
- None of these metrics say anything about *keeping* the advantage afterwards;
  pair them with conversion-focused tactics (e.g. Lichess puzzle sets from
  winning openings).

## 12. Related tools

- **Chessbook** — repertoire trainer built on Lichess DB expected scores (no eval-threshold probabilities)
- **Lichess opening explorer / puzzle search** — raw ingredients this project composes
- Sibling script `../lichess_accuracy.py` — computes official Lichess accuracy scores from PGN dumps (same workspace)

## 13. License

TBD (likely MIT). Data courtesy of lichess.org — consider donating.
