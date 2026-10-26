# Browse: standard openings to import

A **Browse** tab lists standard openings, each with its main line and usual
variations (the moves found in reference works such as Wikipedia's opening
articles), grouped by side and by White's first move. A player previews one
on a board and imports it into their studies in one click, then practises
it or extends it with their own moves.

It differs from Community, which ranks the studies players share: Browse is
a small catalogue kept in the repository, the same for everyone, with no
optimisation. (The optimised repertoires, by expected score, are a separate
experiment: `optimal-repertoires/`, built by
`tools/build_optimal_repertoires.py`.)

## Done

### The catalogue

- `openings/<slug>.pgn`: one opening per file, readable and editable as
  PGN: the moves, with the variations in parentheses, and tags for its name
  (`Opening`), the side the repertoire is for (`Side`), its `ECO` codes, the
  moves that define it (`Start`, the study's starting point) and a
  `Description` for its card. Fourteen so far:
  - for White: Italian Game, Ruy Lopez, Scotch Game, Queen's Gambit, London
    System, English Opening;
  - for Black: Sicilian Najdorf, French, Caro-Kann, Petrov, Scandinavian,
    Queen's Gambit Declined, King's Indian, Nimzo-Indian.
- `tools/build_browse_openings.py` checks each file (legal moves, starting
  with `Start`, one move for the repertoire's side in each position, as a
  study requires) and writes `frontend/public/openings/`: a Lirep study file
  per opening (`<slug>.lirep.json`, with `start`) and `index.json`, the
  list the page reads (name, side, ECO, group, start, main line, size,
  description), in the order of its `OPENINGS_ORDER`. Run it after changing
  a PGN file; its output is committed.

### The website

- **Browse** in every page's menu, between Tutorial and Community.
- `browse.html` / `frontend/src/browse.ts`: "Openings for White", then
  "Openings for Black", each grouped by White's first move. A card: the
  name, the description, a small board at the opening's position playing
  the main line on hover (as on Community), the ECO codes and the number of
  moves and lines, **Preview** and **Import** (or "Sign in to import").
- Preview, `browse.html?o=<slug>`: the read-only tree viewer (the shared
  opening page's), opened at the starting point, with "Import to my
  studies".
- Import reads the opening's study file with `studyFromFile` and creates the
  study with `POST /api/studies`, as the home page's Import of a file does:
  same name, side, tree and starting point, with the default Explorer
  settings. No backend change was needed: the catalogue is static files.

## Next

1. **Mobile app:** a Browse screen under Studies (a button at the end of its
   list), with the same groups and cards, the preview as the study view
   (`mobile/src/studyView.ts`), and Import; then the study appears in Studies
   and Practice at once. The service worker can cache `/openings/`.
2. **More openings:** for White, the Vienna, the King's Gambit, the Catalan,
   the Réti; for Black, the Sicilian Dragon and Sveshnikov, the Slav, the
   Grünfeld, the Dutch, the Pirc, the Berlin. One PGN file each, then the
   build script.
3. **Documentation:** a short section in `frontend/doc/studies.html` on
   Browse and what the catalogue is (standard moves, not optimised).
4. **Already imported:** mark the cards whose opening is already in the
   player's studies (by name, or by keeping the slug on the study).
5. **Tests:** run the build script in CI, so an illegal or conflicting move
   in a PGN file fails the build.

## Open questions

- **Depth.** The lines stop after 10 to 13 moves, where the opening's plans
  are set. Deeper is more to memorise; players can extend a study
  themselves, or with the editor's suggested moves.
- **Choices for the repertoire's side.** A study has one move per position
  for its side, so each file picks one (the main line, e.g. 3...Bb4 in the
  French against 3.Nc3). Other choices would be other openings in the
  catalogue (e.g. "French Defence: Classical" with 3...Nf6).
