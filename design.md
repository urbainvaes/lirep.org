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
