# Bullet practice

A timed run through a study (`frontend/src/bullet.ts`, opened by
`practice-session.html?id=…&mode=bullet`). User documentation:
`frontend/doc/practice.html#bullet`.

## How it works now

- **Clock:** 1 minute, plus 2 seconds per correct move. It runs only on the
  player's moves; the computer's replies (after a 250 ms pause) don't use it.
- **The computer's moves:** only the replies the study has, each weighted by
  its game count in the Opening Explorer, with the study's Explorer settings.
  A reply the Explorer doesn't list has weight 0; a position without Explorer
  data, or whose replies all have 0 games, gets a uniform choice.
- **Explorer data:** only what the browser already holds (its IndexedDB
  cache, see `explorer-cache.md`), read once before the first run with
  `cachedExplorerData`. Nothing is fetched from Lichess, so its rate limit
  can't stall the clock. The 2016 sample is read from the backend.
- **The player's moves:** the prepared move, the first child at that
  position (as for the expected score). Any other move ends the run, with
  the prepared move shown as an arrow.
- **Success:** reaching a position with no move after it in the study (the
  end of a line, whoever is to move), before the clock runs out.
- **After a failure,** the next run replays the computer's replies of the
  failed one (`replay`), then draws as usual past them; a success ends the
  replay. The start button says "Retry this line" or "New run".
- **Stats:** one row per run in `bullet_runs` (owner, study, success, reason
  `finished`/`time`/`wrong`, moves, time used, finish time), recorded by
  `POST /api/studies/{id}/bullet/runs`. `/api/practice/summary` returns each
  study's successes out of all runs and out of the last 30
  (`BULLET_RECENT_RUNS`). Runs don't touch the spaced-repetition knowledge.

## Possible improvements

### Explorer data
- **Store the reply weights on the server**, per study: for each position
  where the opponent moves, the game counts of the study's replies, keyed by
  FEN and saved with the Explorer settings they came from. Runs would then
  work on any device, and beyond the browser cache's 30 days. The editor's
  live calculation and the Stats page's calculation already read every one
  of these positions and could upload them.
- **A "Load the missing Explorer data" button** on the Bullet screen, fetching
  in the background only the positions without data (as Calculate does in
  the editor), instead of sending the player to the editor.
- **A floor for rare replies:** a reply the Explorer doesn't list is never
  played now. A small minimum weight would still test it now and then.

### The run
- **Clock presets** (e.g. 30 s + 1 s, 1 min + 2 s, 3 min + 2 s), remembered in
  the browser, and their stats kept apart.
- **A time penalty** for a wrong move (e.g. −5 s and the prepared move
  played) as an alternative to ending the run.
- **Premoves**, as in Lichess bullet: playing your next move while the
  computer's reply is coming.
- **Unprepared replies:** optionally let the computer play replies the study
  doesn't have, as in a real game, ending the run as "out of book" (a success,
  or counted apart) to show how often preparation runs out early.
- **Sounds and feedback:** a tick in the last 10 seconds, a distinct sound for
  the end of a run.
- **Start from another position:** a branch of the study, chosen on the board
  or in the editor, to drill one variation.

### Stats
- **Per line:** which line each run went down and where wrong moves happen,
  to show the weakest lines (and perhaps feed them to spaced repetition).
- **Records:** fastest successful run, longest streak of successes.
- **History:** a chart of the success rate over time, and Bullet runs in the
  Practice page's activity calendar.
- **Community:** a leaderboard of fastest runs per shared study.

### Interface
- **Phones:** check the layout of the clock and the board on a narrow screen,
  where the panel goes under the board.
- **Focus mode** (as in the editor): only the board and the clock.
