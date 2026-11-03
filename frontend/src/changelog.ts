import { fetchMe, renderAuthArea } from "./layout";
import { pieceBadgeHtml, PIECES, TIERS, tierThreshold } from "./scoreTiers";

// The Changelog page: what changed, newest first, by day. Each change shows
// a one-line summary; clicking it opens the details, and for recent changes
// a figure. The entries are written by hand, for players rather than from
// the commit messages, so related commits are often one entry.

interface Change {
  area: string;
  summary: string;
  details: string; // HTML
  figure?: () => string; // HTML, built when the page renders
}

interface Day {
  date: string; // YYYY-MM-DD
  changes: Change[];
}

const kbd = (key: string) => `<kbd class="changelog-kbd">${key}</kbd>`;

// The tiers' thresholds for both sides, with the badges themselves: built
// from scoreTiers.ts, so the figure follows any change to the tiers.
function tiersFigure(): string {
  const rows = TIERS.map(
    (t) => `<tr>
      <td>${pieceBadgeHtml(t.tier, "sm")} ${t.label}</td>
      <td>${tierThreshold(t.white, "white")}%</td>
      <td>${tierThreshold(t.white, "black")}%</td>
    </tr>`,
  ).join("");
  return `<figure class="changelog-figure">
    <table class="changelog-tiers">
      <thead><tr><th>Tier</th><th>White</th><th>Black</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <figcaption>The tiers, from the expected score of the whole study. Black's thresholds are ${tierThreshold(TIERS[0].white, "white") - tierThreshold(TIERS[0].white, "black")} points lower, since Black scores less on average.</figcaption>
  </figure>`;
}

// The pieces by expected evaluation, each in a tier's colour: built from
// scoreTiers.ts, like the tiers' figure.
function piecesFigure(): string {
  const tiers = ["legendary", "brilliant", "gold", "silver", "bronze", "none"] as const;
  const rows = PIECES.map(
    (p, i) => `<tr>
      <td>${p.label}</td>
      <td>${i === PIECES.length - 1 ? `under +${PIECES[i - 1].from.toFixed(2)}` : `+${p.from.toFixed(2)} or more`}</td>
      <td>${tiers.map((t) => pieceBadgeHtml(t, "sm", p.piece)).join(" ")}</td>
    </tr>`,
  ).join("");
  return `<figure class="changelog-figure">
    <table class="changelog-tiers">
      <thead><tr><th>Piece</th><th>Expected evaluation</th><th>From Legendary to no tier</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <figcaption>The piece, from the expected evaluation in pawns for the studied side (shown from White's point of view: for Black, −1.00 or less is the king); its colour stays the expected score's tier.</figcaption>
  </figure>`;
}

function trophyFigure(): string {
  return `<figure class="changelog-figure">
    <div class="changelog-mock-card">
      <div class="changelog-mock-card__head">
        <div>
          <div class="changelog-mock-card__title">Najdorf, main lines</div>
          <div class="changelog-mock-card__meta">Black · 214 moves</div>
        </div>
        <span class="changelog-mock-card__trophy">${pieceBadgeHtml("gold", "sm")}</span>
      </div>
      <div class="changelog-mock-card__actions"><span>Open</span><span>Practice</span></div>
    </div>
    <figcaption>A study's card on the home page: the king at the top right, in the tier's colour, opens its Stats page.</figcaption>
  </figure>`;
}

function bulletFigure(): string {
  return `<figure class="changelog-figure">
    <div class="changelog-mock-bullet">
      <div class="changelog-mock-bullet__clock"><span>0:47</span><small>+2s a move</small></div>
      <div class="changelog-mock-bullet__options" role="presentation">
        <span class="is-on">Explorer frequencies</span><span>Uniform frequencies</span><span>Cycle</span>
      </div>
      <div class="changelog-mock-bullet__buttons"><span class="is-primary">Retry this line</span><span>Analysis</span></div>
    </div>
    <figcaption>One minute, plus two seconds a move, to play your whole line; the computer's replies follow the chosen frequencies.</figcaption>
  </figure>`;
}

function foldFigure(): string {
  return `<figure class="changelog-figure">
    <div class="changelog-mock-moves">
      <div><b>6.</b> Be3 e5</div>
      <div class="changelog-mock-moves__fold">▸ <b>7.</b> Nb3 Be6 <span class="changelog-mock-moves__stat">31% · 52.4%</span> <span class="changelog-mock-moves__count">(18)</span></div>
      <div class="changelog-mock-moves__fold">▸ <b>7.</b> Nf3 Be7 <span class="changelog-mock-moves__stat">12% · 54.1%</span> <span class="changelog-mock-moves__count">(7)</span></div>
      <div class="changelog-mock-moves__fold">▸ <b>7.</b> Nde2 Be7 <span class="changelog-mock-moves__stat">4% · 51.0%</span> <span class="changelog-mock-moves__count">(3)</span></div>
    </div>
    <figcaption>Closed folds in the move list: how often the reply is played, its expected score, and now, in parentheses, the number of moves inside.</figcaption>
  </figure>`;
}

function focusFigure(): string {
  return `<figure class="changelog-figure">
    <div class="changelog-mock-keys">
      <div>${kbd("Space")} or ${kbd("Z")}<span>focus mode on or off</span></div>
      <div>${kbd("Esc")}<span>leave focus mode</span></div>
      <div>${kbd("↑")} ${kbd("↓")}<span>previous / next variation</span></div>
      <div>${kbd("C")}<span>comment on the position</span></div>
    </div>
    <figcaption>The editor's new keys. Focus mode hides the site's header and gives the board the window's whole height.</figcaption>
  </figure>`;
}

const DAYS: Day[] = [
  {
    date: "2026-11-04",
    changes: [
      {
        area: "Editor",
        summary: "The first and last buttons under the board change lines",
        details: `<p>In the study editor, ▲ and ▼ under the board now go to the previous and the next line, as ↑ and ↓ do, in place of the
          start and the end of the line (still Shift+↑ and Shift+↓). Each is greyed out where there is no line that way.</p>`,
      },
      {
        area: "Everywhere",
        summary: "Tips, behind a ? in the header",
        details: `<p>A <strong>?</strong> after the theme toggle shows or hides tips; they show until you hide them, and the ? is blue
          while they do. On the home page, “Getting started”: how to create a study from scratch, or to start from a standard opening
          found on Browse. On the Practice page, what the knowledge score, due and new, and Bullet are. In the study editor, a panel above the board explains each button, with its icon, what the expected score
          is, and that you keep one move after each opponent's move; the editor is greyed out under it until it's hidden. Each tip has <em>Hide this tip now</em>, which hides it until you come back to the
          page, and <em>Hide all tips</em>, which switches the ? off.</p>`,
      },
      {
        area: "Browse",
        summary: "Every opening's expected score and evaluation, and blitz 1600+ by default",
        details: `<p>Each opening on Browse now shows its badge and its expected result, calculated with Lichess's blitz games rated
          1600+ and Stockfish at depth 16. A preview opens the Explorer with those settings, and an imported opening keeps them, so its
          Stats page compares. A new study starts with them too.</p>`,
      },
      {
        area: "Editor",
        summary: "The Explorer keeps to six moves after Suggest moves",
        details: `<p>Coming back from Suggest moves or the settings, the Explorer could show all its moves, a dozen at times, and leave the
          move list little room. It shows six again, scrolling for the rest.</p>`,
      },
      {
        area: "Mobile app",
        summary: "Add to prep from the app",
        details: `<p>In the app's analysis, a line out of prep that doesn't replace a move of yours, after an opponent's reply the study
          doesn't answer, or past the end of the prep, can now be added to the study with Add to prep. Nothing is deleted: the line goes
          in after the moves already there. As with Replace prep, a practice session or a Bullet run starts again once the analysis
          closes.</p>`,
      },
    ],
  },
  {
    date: "2026-11-03",
    changes: [
      {
        area: "Everywhere",
        summary: "The header steps aside while you scroll down",
        details: `<p>As on Lichess, the site's header slides away when you scroll down a page and comes back as soon as you scroll
          up.</p>`,
      },
      {
        area: "Editor",
        summary: "The side, starting point and “Saved” under the moves",
        details: `<p>The study's line at the top is shorter: its side, starting point and save status are now in small print at the bottom
          of the moves, the side and starting point on the left (click the starting point to go there), “Saved” on the right.</p>`,
      },
      {
        area: "Community",
        summary: "Everyone sees a shared study's games",
        details: `<p>The games attached to a shared study now open read-only for everyone, from the game count on its card, whatever name
          the author shares under. For an author who is anonymous or uses a pen name, the games they played themselves are left out,
          since a game's players would give the name away; the card counts only the games you can see.</p>`,
      },
      {
        area: "Mobile app",
        summary: "Practice offline goes on as it would online",
        details: `<p>Offline, practice no longer asks the same positions again after a round: the app keeps your positions' progress and
          builds the next rounds itself, by the same rules as the server, through what's due and new, then optional review. Your answers
          are sent when the connection is back, as before.</p>
          <p>The dots above the board show each position's streak, offline too: orange, then yellow, then green once it's known. The
          study's knowledge, in the session and on the Practice list, counts the answers made offline.</p>
          <p>When nothing is due, Done and Practise more appear in a popup over the board, instead of in the bar at the bottom.</p>`,
      },
    ],
  },
  {
    date: "2026-10-29",
    changes: [
      {
        area: "Editor",
        summary: "Your moves in red where a transposition disagrees",
        details: `<p>When two lines reach the same position with you to move but prepare different moves there, those moves show in red,
          with a wavy underline, and their tooltip says what the other lines play. In the editor and the read-only view.</p>`,
      },
      {
        area: "Mobile app",
        summary: "Replace prep from the app",
        details: `<p>In the app's analysis, a line that leaves the prep with a move of yours other than the study's can replace it, as on
          the website, after a confirmation. From a practice session or a Bullet run, the session starts again once the analysis closes;
          Bullet's analysis now shows the prep too.</p>`,
      },
    ],
  },
  {
    date: "2026-10-28",
    changes: [
      {
        area: "Editor",
        summary: "Out of prep, and Replace prep",
        details: `<p>Playing a move of yours other than the one the study has there no longer gets refused: the line goes on out of prep,
          in place of the move list and in the warning colour, and nothing of it goes into the study. An “Out of prep” bar offers Back
          to prep (${kbd("Esc")}) and Replace prep, which, after asking, puts the new line in place of your old move and everything
          after it.</p>`,
      },
    ],
  },
  {
    date: "2026-10-27",
    changes: [
      {
        area: "Browse",
        summary: "Standard openings to preview and import",
        details: `<p>A new Browse page, in every page's menu, lists standard openings for White and for Black, grouped by White's first
          move: each with a short description and a board playing its main line. Preview opens it in the read-only viewer; Import makes
          it one of your studies, from the opening's starting point.</p>`,
      },
      {
        area: "Games",
        summary: "Comments on positions, and the viewer's own tools",
        details: `<p>A game's comments now go on its positions, as in the editor, and are saved in its PGN; a comment written before on the
          whole game shows on its starting position. The game viewer's Explorer and Stockfish start from the study's settings, changed
          for the page only by their own gear; the section and Delete are in a “⋯” menu. A shared opening's games can be opened
          read-only from its game count on the leaderboards.</p>`,
      },
      {
        area: "Account",
        summary: "Badge appearance, saved with your account",
        details: `<p>The Account page's Appearance sets how badges look, on the website and in the mobile app: their shine (Vivid,
          glowing and sparkling; Subtle, the top tiers shimmering, the default; or Flat, still) and their pieces (your Lichess board's
          piece set by default, or Staunty or Pixel), with every badge shown in a table of tiers by pieces, each with its expected score
          and evaluation. They're saved with your account, so every device uses them.</p>`,
      },
      {
        area: "Stats",
        summary: "Save keeps the calculation settings",
        details: `<p>The settings panel's Done only closed it, and settings changed there were lost on reload. Save now makes them the
          study's settings; results calculated with others are then marked out of date.</p>`,
      },
      {
        area: "Everywhere",
        summary: "A study's variation on a line of its own, and the king in check highlighted",
        details: `<p>A name with a colon, “Caro-Kann Defense: Advance Variation”, shows the opening as the card's title and the variation
          under it, small and in italics, on the home page, Practice and Community.</p>
          <p>Boards highlight the king in check, and a check now plays the move's own sound, as on Lichess. A study whose stored moves
          are damaged now shows on its owner's home page with the reason, instead of disappearing.</p>`,
      },
    ],
  },
  {
    date: "2026-10-26",
    changes: [
      {
        area: "Practice",
        summary: "A clear end to what's due, and knowledge as a ring",
        details: `<p>When nothing is due or new, a session stops with a summary, Done and Practice more, instead of starting another
          round; optional rounds are labelled. Show answer is offered before any move and counts as a miss, and a right move after a miss
          says so rather than Correct.</p>
          <p>Each study's knowledge is a ring at the top right of its card, filling up in green, and the studies are listed in the home
          page's order.</p>`,
      },
      {
        area: "Stats",
        summary: "Expected evaluation from White's point of view, ranked only when current",
        details: `<p>The expected evaluation is shown from White's point of view, as on Lichess: negative when Black is better, for Black's
          studies too. The leaderboards rank only results calculated for a study's current moves and starting point; the others say why
          on their card.</p>
          <p>Links to Lichess's analysis board keep the same side at the bottom as here.</p>`,
      },
      {
        area: "Mobile app",
        summary: "Studies along their prep, and Practice first",
        details: `<p>A study's row in the app opens it read-only along its prep: your prepared move as a button and an arrow, or the
          opponent's prepared replies with how often each is played. Moves off the prep are greyed, with Back to prep. The app now opens
          on Practice, with the studies in their own tab.</p>`,
      },
    ],
  },
  {
    date: "2026-10-25",
    changes: [
      {
        area: "Stats",
        summary: "Hybrid values use Stockfish under 100 games, up from 50",
        details: `<p>With the Hybrid end-of-prep value, a line's end is now worth the Explorer's results only when its last move has at
          least 100 games, Stockfish's value otherwise: a score over 50 games is still uncertain by about 7 points, over 100 by
          about 5. Hybrid scores calculated before are marked out of date on the Stats page; recalculate to update them.</p>
          <p>Suggested moves now consider your 6 most played moves in a position, up from 4.</p>`,
      },
      {
        area: "Home",
        summary: "Archive studies instead of deleting them",
        details: `<p>The bin on a study's card is now an archive box: the study moves to an archive, with an Undo for a few seconds. Archived
          studies keep everything, practice history included, but leave the Practice and Community pages. “Show archived”, after your
          studies, shows them apart, faded; from there, Restore brings one back and the bin deletes it for good.</p>`,
      },
    ],
  },
  {
    date: "2026-10-24",
    changes: [
      {
        area: "Home",
        summary: "Duplicate a study from its card",
        details: `<p>A new icon next to the bin on each study card makes a copy of the study under a new name, offered as the study's own
          plus “(copy)”. The copy has the same moves, comments, starting point, settings, games and calculated results; it starts with
          no practice history and isn't shared, so it doesn't appear twice on the leaderboards.</p>`,
      },
    ],
  },
  {
    date: "2026-10-22",
    changes: [
      {
        area: "Stats",
        summary: "A study's badge shows its expected evaluation too",
        details: `<p>The badge on a study's card and Stats page now combines its two results. The expected score still gives its colour
          and shine; the expected evaluation now gives the piece: a pawn under +0.25, then a knight, bishop, rook and queen, and the king
          from +1.00, the same for both sides. A study whose evaluation hasn't been calculated keeps the king. The Stats page's legend,
          opened by clicking the badge, explains both.</p>
          <p>Bronze, silver and gold are lighter and crisper, gold now shimmers gently, and Brilliant shines more.</p>`,
        figure: piecesFigure,
      },
    ],
  },
  {
    date: "2026-10-20",
    changes: [
      {
        area: "Home",
        summary: "A study's tier as a trophy on its card",
        details: `<p>Each study card on the home page now shows its tier, as the king in the tier's colour used on the Stats page,
          at the card's top right; it replaces the Stats button. The king grows and tilts when you hover over it, its tooltip gives the
          tier and the expected score, and a click opens the study's Stats page. A study not calculated yet shows a grey king.</p>`,
        figure: trophyFigure,
      },
      {
        area: "Stats",
        summary: "New thresholds for the two top tiers, and badges that loop seamlessly",
        details: `<p>The second-highest tier now starts at 59% and Legendary at 60% for White (55% and 56% for Black), so that the top
          tiers are within reach of a well-prepared repertoire rather than out of sight.</p>
          <p>The animated badges no longer jump at the end of each cycle: their gradients end on the colour they start with, and
          each cycle shifts them by exactly one repeat, so the last frame matches the first.</p>`,
        figure: tiersFigure,
      },
      {
        area: "Bullet",
        summary: "Choose how the computer picks its lines, see where a run ended, and restart by itself",
        details: `<p>Bullet now lets you choose how the computer chooses its replies:</p>
          <ul>
            <li><strong>Explorer frequencies</strong>: each reply as often as it is played in the Explorer, as in a real game;</li>
            <li><strong>Uniform frequencies</strong>: each of your study's replies equally often, so rare lines come up too;</li>
            <li><strong>Cycle</strong>: every line once, in random order, before any comes back.</li>
          </ul>
          <p>At the end of a run, the final position's Stockfish evaluation and Explorer row are shown, with a link to Lichess's
          analysis board. After a success, the next run can start by itself. Bullet also has its own
          <a href="/doc/bullet.html">documentation page</a>.</p>`,
        figure: bulletFigure,
      },
      {
        area: "Editor",
        summary: "A closed fold says how many moves it holds",
        details: `<p>When a variation is folded, the number of moves inside it now follows its figures, in parentheses: you can see at
          a glance which branches are deep and which are a single move.</p>`,
        figure: foldFigure,
      },
    ],
  },
  {
    date: "2026-10-19",
    changes: [
      {
        area: "Practice",
        summary: "Bullet: a run through your preparation against the clock",
        details: `<p>A new way to practise: play through your preparation with one minute on the clock plus two seconds a move,
          the computer replying as players do in the Explorer. A Lichess-style clock sits under the board, the month's successes
          above it, and reaching the end of the preparation is celebrated.</p>
          <p>After a failed run, the next one replays the same line, so you can fix the mistake right away; the start button says
          <em>Retry this line</em> or <em>New run</em>. Any run can be opened on Lichess's analysis board, up to where it ended.
          Bullet runs are recorded apart from the spaced-repetition knowledge, so they don't change your review schedule.</p>`,
      },
      {
        area: "Everywhere",
        summary: "Focus mode wherever there's a board",
        details: `<p>The editor's focus mode comes to the read-only viewer (recorded games, others' studies) and to practice:
          ${kbd("Space")} or ${kbd("Z")} toggles it, ${kbd("Esc")} leaves it, and your choice is remembered on every page.</p>`,
        figure: focusFigure,
      },
      {
        area: "Editor",
        summary: "How lines' ends are valued is now a setting of the study",
        details: `<p>The gear chooses how the expected score values the end of a line (Explorer, Stockfish or Hybrid) and Stockfish's
          depth. The choice is saved with the study, and the move list's figures and the Stats page both follow it.</p>`,
      },
      {
        area: "Practice",
        summary: "The board fits the window on a laptop",
        details: `<p>On a laptop screen, the practice and Bullet boards are sized so that the whole board, the clock and the start
          button fit without scrolling, even outside focus mode. On phones, the page no longer scrolls sideways.</p>`,
      },
      {
        area: "Community",
        summary: "No pawns in the leaderboards' rows",
        details: `<p>Each leaderboard is already for one side, so the pawn showing the side in every row was removed.</p>`,
      },
    ],
  },
  {
    date: "2026-10-17",
    changes: [
      {
        area: "Stats",
        summary: "Score tiers by side, with two new top tiers that shine",
        details: `<p>The tiers now depend on your side: White scores about 52% on average in the Explorer, Black about 48%, so
          Black's thresholds are 4 points lower. Bronze is the side's average; above Gold come two new tiers, whose badges are
          animated: a glint for the first, an iridescent gradient, a halo and sparkles for Legendary. The animations stay still
          if your system asks for less motion.</p>`,
      },
      {
        area: "Editor",
        summary: "A focus mode, and an editor that fits the window",
        details: `<p>The board is now sized to the height left below the header, so the editor fits without scrolling. Focus mode
          (the ⛶ button under the board, ${kbd("Z")} or ${kbd("Space")}) hides the site's header and the study's bar and gives
          the board the whole height. Entering full screen turns it on, leaving full screen turns it off again.</p>`,
      },
      {
        area: "Editor",
        summary: "A cleaner toolbar and a compact study bar",
        details: `<p>The move list's toolbar is a band across its card: the switches first (Fold branches, Auto-fold), then the
          icons (comment, Lichess analysis, starting point, delete). The starting point is a flag icon, crossed out to clear it.
          The Explorer and Stockfish toggles look like switches. The study's side, name and save status sit in a compact bar
          under the header, and variations are indented less, leaving more room for the moves.</p>
          <p>${kbd("C")} opens the comment box for the current position.</p>`,
      },
    ],
  },
  {
    date: "2026-10-16",
    changes: [
      {
        area: "Editor",
        summary: "The expected score live in the move list (experimental)",
        details: `<p>The editor now computes the expected score as you edit, from the Explorer data your browser already holds.
          At each branching, every opponent reply shows how likely it is to be reached and its expected score; the replies your
          study lacks are summed in an <em>Other replies</em> row. Where Explorer data is missing, a <em>Calculate</em> button
          loads only the positions needed, in the background.</p>
          <p>With <em>Fold branches</em> on, each move at a branching is a fold; <em>Auto-fold</em> closes the variations you
          leave.</p>`,
      },
      {
        area: "Editor",
        summary: "↑ and ↓ move between variations",
        details: `<p>${kbd("↑")} and ${kbd("↓")} go to the previous or next variation at the nearest branching, and up a level past
          the last one; ${kbd("Shift")}+${kbd("↑")} and ${kbd("Shift")}+${kbd("↓")} go to the start and end of the line. The same
          in the read-only viewer.</p>`,
      },
      {
        area: "Editor",
        summary: "Explorer settings behind a gear, shared with the Stats page",
        details: `<p>The tools card loses its settings line: a gear swaps the tools for the Explorer settings, the same form as on
          the Stats page. The Explorer's rows are more compact, without frames. On phones, the tool tabs show only their icons.</p>`,
      },
      {
        area: "Header",
        summary: "A Tutorial tab replaces Doc",
        details: `<p>The Tutorial page walks through what Lirep does; the documentation is linked from the end of the About page.</p>`,
      },
      {
        area: "Stats",
        summary: "Fairer expected scores and leaderboards",
        details: `<p>A line ending with a move too rare for the Explorer to list now counts as an even 50%, instead of averaging the
          opponent's replies after it. The expected-score leaderboard ranks all scores from the same Explorer together, each row
          saying how its lines' ends were valued. Coverage no longer asks the Explorer about positions past the end of a line:
          same results, fewer requests.</p>`,
      },
    ],
  },
  {
    date: "2026-10-14",
    changes: [
      {
        area: "Stats",
        summary: "Expected evaluation: the same lines as the expected score, capped at ±10 pawns",
        details: `<p>The expected evaluation now evaluates exactly the positions the expected score values, averaging centipawns
          instead of scores. Each evaluation is capped at ±10 pawns, a mate counting as 10: uncapped, a mate after a rare blunder
          (0.15% of the games in one study) could move the average by more than a pawn. Older evaluations show as out of date
          and aren't ranked until recalculated.</p>`,
      },
    ],
  },
];

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

function renderChangelog(root: HTMLElement): void {
  root.innerHTML = DAYS.map(
    (day) => `
      <section class="changelog-day">
        <h3 class="changelog-day__date"><time datetime="${day.date}">${formatDate(day.date)}</time></h3>
        <ul class="changelog-list">
          ${day.changes
            .map(
              (change) => `
            <li>
              <details class="changelog-item">
                <summary>
                  <span class="changelog-item__area">${change.area}</span>
                  <span class="changelog-item__summary">${change.summary}</span>
                  ${change.figure ? `<span class="changelog-item__has-figure" title="With a figure" aria-label="With a figure">▣</span>` : ""}
                </summary>
                <div class="changelog-item__body">
                  ${change.details}
                  ${change.figure ? change.figure() : ""}
                </div>
              </details>
            </li>`,
            )
            .join("")}
        </ul>
      </section>`,
  ).join("");
}

async function init(): Promise<void> {
  const root = document.getElementById("changelog");
  if (root) renderChangelog(root);
  renderAuthArea(await fetchMe());
}

init();
