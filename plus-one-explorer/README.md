# Plus One Explorer

> Measure how much advantage your opening line really yields against the moves
> people actually play — using Lichess opening-explorer statistics and engine
> evaluations — then train on the branch points that decide it.

**Status:** design phase · **Language:** Python (CLI first) · **Data:** Lichess APIs

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
| Opening explorer | `GET https://explorer.lichess.ovh/{lichess,masters}\?fen=..\&speeds=..\&ratings=..\&moves=..` | Move list with game counts and W/D/L |
| Cloud eval | `GET https://lichess.org/api/cloud-eval?fen=..&multiPv=1` | Free, cached server evals; sparse coverage |
| Local Stockfish | UCI via `python-chess` | Fallback + verification at fixed depth/nodes |
| Openings reference | `https://github.com/lichess-org/chess-openings` | ECO names for reporting |

All are free; respect rate limits (~20 req/s explorer, less for cloud-eval) and
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
