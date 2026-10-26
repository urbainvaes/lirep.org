# Design improvements

Remaining design points from a review of the frontend code (October 2026).
They come from reading the HTML, CSS and TypeScript, not from user testing,
so check each one against the rendered pages before acting on it. Done so
far: a landing page for signed-out visitors, and the Studies and Stats tabs
merged into the home page.

## 1. Menu: what's left

The Studies and Stats tabs are merged into the home page, leaving Practice,
Community, Doc and About. Two optional follow-ups:

- A badge on Practice counting due positions (e.g. "Practice · 12").
- Doc and About together under a single Help item.

## 2. Make the expected score readable at a glance

A card shows e.g. "Expected score 54.3%", but a new user can't tell whether
that is good. The Stats detail page already has score tiers (the piece
legend in `stat.ts`); reuse them on the cards, as a tier colour or a short
word ("solid", "risky"), so the number carries meaning without a click.

## 3. Show what's due for practice on each card

Home page cards show only the score (the Practice tab's cards already show
knowledge and due counts). A line such as "8 positions due", or a small
knowledge bar, would give a reason to come back, and spaced repetition only
works if people return.

## 4. Replace hover-only explanations

The expected-score explanation on the study cards is a `title` attribute,
which never shows on phones. Reuse the click-to-open info box from the About
page's comparison table there, and wherever else a `title` carries real
information rather than a mere hint.

## 5. Check the site on a phone

The stylesheet has only five `@media` rules in about 2,750 lines. The menu
collapses below 980px, but the community, players and comparison tables
rely on horizontal scrolling. Check them on a real phone; many Lichess users
are on mobile.

## 6. Add a screenshot to the landing page

The landing page describes the metrics in words. A screenshot of a study's
Stats page under the buttons would make the pitch much more concrete.

## 7. Redesign a study's Stats page (done)

Today the page reads, top to bottom: header, three result cards (win
probability, expected evaluation, practice knowledge), an "Analysis" block
with the Stockfish depth and "Update evaluations", the two "Update …"
buttons, the Opening Explorer settings (collapsed, below the buttons they
affect), then the coverage chart. Problems:

- The inputs of a calculation are scattered: the depth is at the top of
  "Analysis", the Explorer settings are folded away at the bottom, and
  nothing says which settings feed which button.
- Three buttons for two numbers. "Update evaluations" is a step that
  "Update expected evaluation" already runs first; on its own it only
  warms the browser cache.
- Results are far from what produced them: a card doesn't show whether
  the current settings or tree differ from the ones it was calculated
  with, and the coverage chart (from the win-probability job) sits at the
  bottom, away from the win-probability card.
- Nothing tells the user whether a number will appear on the community
  leaderboards, or why not.

Proposed layout:

1. **Header**: tier badge, name, side, starting point if set, and links
   to the study and to Practice.
2. **Calculation settings**, one panel: Explorer (source, database,
   rating, time controls or player) and Stockfish depth (Quick / Balanced
   / Thorough). Collapsed, it reads as one line, e.g. "Lichess · 1600+ ·
   blitz, rapid · Stockfish depth 16 · Edit". Next to the depth: "Balanced
   or more to appear on the evaluation leaderboard". Below the panel, one
   primary button, **Recalculate**, running both calculations; the per-card
   buttons below stay for running one alone.
3. **Expected score** card with the win/draw/loss split and the coverage
   chart under it (both come from the same job).
4. **Expected evaluation** card, with the "N positions cached on this
   device" count in place of the "Update evaluations" button.
5. **Practice knowledge**, smaller, linking to Practice.

Each result card would show the settings and date it was calculated with,
a "settings changed since" or "moves changed since" marker when it is out
of date, and its leaderboard status: "Ranked #3 for White", or "Not ranked:
depth 8, recalculate at Balanced or more".

Decided: changing a setting marks the results calculated with other
settings as out of date; nothing recalculates until Recalculate. The
Stockfish depth is saved with the expected evaluation, as the Explorer
settings are, and the page opens with the study's saved depth (falling
back to this browser's last choice for a study never calculated).

## 8. Redesign the study editor (done)

Today, top to bottom: a name row (name, side, flip button, starting-point
badge); the board and the move tree side by side, with a comment box and
a row of buttons (Lichess analysis, Go to start, delete move, starting
point, shortcuts) under the tree; the Opening Explorer and Stockfish as
two large cards below; and a footer with the save status, the sharing
checkbox and "Delete study". Problems:

- The Explorer and Stockfish are below the fold on a laptop, so checking
  a position means scrolling away from the board. The Stockfish card is
  mostly empty space.
- The Explorer shows Lichess's move list but not your repertoire: nothing
  marks which replies you have prepared, or which popular ones you haven't.
  That is what the editor is for, and coverage on the Stats page already
  measures it.
- The Explorer settings here are the same settings the Stats page
  calculates with, but nothing says so; changing them here silently makes
  the stats out of date.
- No link to the study's Stats page or to Practice; the save status,
  sharing and "Delete study" are at the bottom of the page.
- On a phone, the name row and the moves card overflow the screen width.
- The comment box always takes room, even when most positions have none.

Proposed layout:

1. **Header**: name (editable), side, starting-point badge; on the right,
   the save status ("Saved"), links to Stats and Practice, and a "⋯" menu
   with sharing and "Delete study".
2. **Board** on the left, with navigation buttons under it (start, back,
   forward, end, flip), as on Lichess.
3. **Right column**: the move tree, then a tool panel with two tabs,
   **Explorer** and **Stockfish**, so the tools sit next to the board at
   any screen height. Stockfish becomes a compact line or two of
   evaluation instead of a card.
4. **Explorer tab**: the settings collapse to the same one-line summary
   as on the Stats page, with a note that they also drive the study's
   stats. Each move row is marked when it's in your tree. On the
   opponent's turn, popular replies you haven't prepared are flagged
   ("not prepared · 14% of games"); on your turn, your prepared move is
   highlighted, and a missing reply is pointed out.
5. **Comment**: an "Add a comment" link that opens the box, shown open
   when the position already has one.
6. **Move actions** (delete, set as starting point, open in Lichess) in
   a small toolbar above the tree, with text labels on wide screens.
7. **Phone**: header wraps; board, navigation, tabs, then the tree;
   nothing wider than the screen.

Decided: unprepared replies are flagged from 5% of games; Explorer and
Stockfish are tabs (Stockfish runs only while its tab is shown); sharing
and "Delete study" are in the "⋯" menu. The shared-opening viewer
(`opening.ts`) still has the old layout.
