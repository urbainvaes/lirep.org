# Known weaknesses

Trade-offs accepted on purpose, mostly from moving the Opening Explorer
requests and the stats calculations into the browser (see
[explorer-cache.md](explorer-cache.md)). Each entry says what can go wrong,
why it was accepted, and what could be done about it later.

## Leaderboard results are reported by the browser

Both results shown on the community leaderboards are calculated in the
user's browser and sent to the backend:

- the expected score and coverage, through
  `POST /api/studies/{id}/expected-score`;
- the expected evaluation and its Stockfish depth, through
  `POST /api/studies/{id}/expected-eval`.

The backend checks only that the values are in range (probabilities
between 0 and 1, win plus loss at most 1, a bounded evaluation and depth).
It cannot tell whether they match the study's moves and the Explorer's
data. A user who calls these endpoints by hand can post a made-up score or
evaluation for one of their own studies and put it at the top of a
leaderboard. The settings stored with a result are client-supplied too.
What the client cannot fake is the moves themselves: the moves fingerprint
saved with each result is computed by the server from the stored tree.

Why accepted: calculating in the browser is what lets each user's Explorer
requests count against their own Lichess rate limit. The expected
evaluation was already calculated in the browser (Stockfish runs there), so
this was already true of the evaluation leaderboard.

Possible mitigations:

- Recalculate a leaderboard entry on the server before ranking it, or a
  random sample of entries, and drop those that disagree. This brings back
  server-side Explorer requests, but only for the few ranked studies.
- Flag implausible results, for example an expected score far above what
  any reply's Explorer results allow.
- Let people report a suspicious entry, and hide it pending a check.

## The user's Lichess token is handed to their browser

`GET /api/lichess-token` returns the signed-in user's Lichess OAuth token
so the browser can query Lichess's Explorer itself. Any script running on
lirep.org's pages can therefore read it; through a cross-site scripting
bug, so could an attacker.

Why accepted: the token's only scope is `preference:read`. With it, someone
can read the user's Lichess account and board preferences, and spend their
Explorer rate limit; they cannot play, message, or change anything. The
response is sent with `Cache-Control: no-store`.

Keep in mind:

- **Do not add OAuth scopes** (`OAUTH_SCOPE` in `backend/app/auth.py`)
  without revisiting this: a broader token in the browser is a much larger
  risk.
- Pages build HTML from strings in several places; user-supplied text (study
  names, comments, usernames) must keep going through `escapeHtml`. A
  Content-Security-Policy header would limit the damage of a slip.

## Rate-limit pacing is per browser tab, and a guess

`explorerClient.ts` sends one Lichess request at a time, at least 500 ms
apart, and pauses 60 s after a 429. That queue lives in one tab: two tabs
calculating at once each run their own queue, so together they send
requests in parallel. The 500 ms gap is an estimate too, since Lichess
publishes no Explorer quota.

Effect: a user running several calculations in separate tabs may still be
rate-limited, which pauses (or, after a second 429, fails) their own
calculations only; other users are not affected.

Possible improvements: share the queue between tabs (a `BroadcastChannel`
or Web Locks), and tune the gap if 429s show up in practice.

## No shared Explorer cache

Explorer responses are cached per browser profile, not shared between
users: a cache fed by browsers would let anyone upload invented move
statistics and skew other people's results. As a consequence, each user's
first calculation of a study fetches every position from Lichess, paced. A
tree with 200 positions not yet cached in that browser takes about
100 seconds or more; later runs in the same browser are fast. A new device,
or cleared browser data, starts again from an empty cache.
