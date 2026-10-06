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
