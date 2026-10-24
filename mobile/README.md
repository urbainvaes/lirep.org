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
  expected score and evaluation, White's then Black's, in your order.
- **Practice** (the website's Practice page): each study's knowledge, as a
  ring, and its positions due and new; the studies with something due first,
  and the total due at the top.
- **A practice session**, from either list: the board across the screen, the
  same queue and rules as on the website (`practice.md`), your answers
  recorded the same way.
- **Bullet**, from the bullet at the end of each row: the website's game
  (`frontend/src/bulletRun.ts`), with the clock and Start under the board and
  the options (the line's choice, auto-restart, loading missing Explorer
  data) as chips.

In the practice and Bullet screens, the board sits low on the screen, as in
the Lichess app: the prompt or result just above it, the clock just below,
the buttons in a bar at the bottom.

Archived studies are left out, as on the website's Practice page. Signing in
goes through Lichess and comes back to the app (`/auth/login?next=/m/`).

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
  and puts it live on this machine, at `/m/` of the site that
  `deploy/run-local.sh` runs: that nginx serves whatever build is linked in
  the state directory.
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

1. **Stats:** the saved results first, then calculating them on the phone,
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
