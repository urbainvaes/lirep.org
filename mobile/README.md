# Lirep mobile

Lirep for phones: a web app served at **lirep.org/m/**, to add to the home
screen ("Add to Home Screen" on iPhone, "Install app" on Android), where it
opens full screen like an app. It reproduces the website's features with
less text, starting with what a phone is best at: the studies and practice.

It is developed apart from the website, in this folder with its own build,
but it shares the website's code: it imports the board, the practice walk,
the badges and the tree helpers from `frontend/src` (as `@web/…`), and it
uses the same backend, on the same site, with the same sign-in. So the app
and the website always compute and record the same things.

## What it does so far

- **Studies** (the website's home page): each study with its badge and its
  expected score and evaluation, White's then Black's, in your order. Tap
  the row for the study itself, or the chart icon for saved stats, freshness
  labels and links to the website's full Stats page and editor.
- **A study**, read-only: the analysis below as a screen, from the study's
  starting point, along its prep: your prepared move as a button (and a blue
  arrow), or the opponent's prepared replies as buttons, in the study's
  order, with how often each is played when the Explorer's answer is already
  in the browser; a move's comment above them. Moves off the prep are greyed,
  with "Back to prep".
- **Practice** (the website's Practice page), the app's home screen: each
  study's knowledge, as a ring, and its positions due and new, in the same
  order as Studies, and the total due at the top.
- **A practice session**, from Practice or a study's stats: the board across the screen, the
  same queue and rules as on the website (`doc/practice.md`), your answers
  recorded the same way; a dot per answer (green, red), the board's flip, and
  a brief "100%" the first time the study is fully known.
- **Bullet**, from the bullet at the end of each Practice row: the website's game
  (`frontend/src/bulletRun.ts`), with the clock and Start under the board and
  the options (the line's choice, auto-restart, loading missing Explorer
  data) as chips.
- **Community:** the leaderboards, by expected score or evaluation, White's
  then Black's; your studies marked. A row opens the study on the website.
- **Analysis**, from the microscope in practice (always there; the
  session pauses meanwhile) and after a Bullet run (its line, a wrong move
  included): a layer over the screen, on the position and its line. ‹ › and
  the row of moves step through it; your moves, on the board or tapped in
  the Explorer or Stockfish's chips, replace the rest of the line (they
  aren't saved in the study). Explorer and Stockfish are toggles, remembered
  as on the website. The study's prep shows there too, as in a study. The
  back arrow, or the phone's back, closes it.

In the practice and Bullet screens, the board sits low on the screen, as in
the Lichess app: the prompt or result just above it, the clock just below,
the buttons in a bar at the bottom.

Archived studies are left out, as on the website's Practice page. Signing in
goes through Lichess and comes back to the app (`/auth/login?next=/m/`).

## Offline

The app works offline, from what it last loaded:

- Its service worker (`public/sw.js`, registered in production builds only)
  keeps the app's page and files, the board's images and sounds, Stockfish,
  and the API's answers (studies, practice, queues, leaderboards). Online,
  the API answers come from the network, unless it takes over 4 seconds;
  offline, from the copies. Signing out drops them.
- Practice answers and Bullet runs made offline wait in an outbox
  (`src/outbox.ts`, in the browser) and go out in order once the server
  answers again, each with the time it happened (`answeredAt`,
  `finishedAt`), which the server believes if it's in the last 7 days. A
  note above the bottom bar says "Offline" and how many wait.
- The Explorer's data and Stockfish's evaluations are the browser's caches,
  as on the website.

The site's nginx serves `sw.js` without validators, like the pages, so that
browsers see a new one.

## Working on it

```sh
cd mobile
npm install
npm run dev      # http://127.0.0.1:5174/m/
```

The dev server sends `/api` and `/auth` to the backend on port 8000, and the
site's fonts and icons to the website's dev server on port 5173, so run both
as usual. `npm run check` type-checks; `npm run build` writes `dist/`.

## Deploying

The app is built and deployed apart from the website, without restarting
it:

- `deploy/build-mobile.sh` builds it with Guix (`deploy/guix/lirep/mobile.scm`)
  and installs it in a Guix profile of its own,
  `/var/guix/profiles/per-user/$USER/lirep-mobile`, which the state
  directory's `mobile/m` links to and the site's nginx (`deploy/run-local.sh`)
  serves at `/m/`. Installing switches the profile at once, so the new
  version is live without a restart, and the profile keeps it from being
  garbage-collected (a GC root under a private home would not, with an
  unprivileged `guix-daemon`); older generations are deleted.
- `deploy/deploy-mobile.sh` copies the app's sources (`mobile/`, the shared
  `frontend/src/`, `deploy/`) to the server and runs `build-mobile.sh` there.
  `-n` shows what would be copied.

The Guix package fetches the app's libraries in a fixed-output step, with
network access: on a machine whose `guix-daemon` gives those steps network
through `slirp4netns`, that program must be installed. When
`mobile/package-lock.json` changes, update the package's hash: build with a
wrong one and copy the "actual" hash from the error.

The first time, the site's nginx must be restarted once to know about `/m/`
(`deploy/deploy.sh` on the server, or `run-local.sh` here); `build-mobile.sh`
says so if it isn't served.

## Next steps

1. **Stats:** calculating them on the phone,
   with the website's code.
2. **The editor:** adding moves on the board, with the Explorer and
   Stockfish.
3. **Community.** The forum and the documentation stay on the website.

The address can move to mobile.lirep.org later: nginx would serve the app
there and pass `/api` and `/auth` to the same backend, which would then also
need to accept that address for the Lichess sign-in.

## Less text

- Icons rather than labelled buttons; numbers rather than sentences
  ("53.2% · +0.43").
- The study's badge, or its knowledge ring, as its summary.
- Explanations stay on the website's documentation.
