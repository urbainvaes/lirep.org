import { LIREP_DATASET } from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface Summary {
  players: number;
  studies: number;
  sharedStudies: number;
  maxUsers: number;
  activeThisWeek: number;
}

interface Opening {
  rank: number | null;
  id: number;
  name: string;
  side: "white" | "black";
  owner: string;
  mine: boolean;
  winProbability: number | null;
  reason: string | null;
  source: "lichess" | "lirep" | null;
  database: "lichess" | "masters" | null;
  minRating: number | null;
  speeds: string[];
  calculatedAt: string | null;
  moves: number;
  lines: number;
}

// A row of the leaderboard by expected evaluation (/api/community/openings-by-eval).
interface EvalOpening {
  rank: number;
  id: number;
  name: string;
  side: "white" | "black";
  owner: string;
  mine: boolean;
  evalCp: number;
  depth: number;
  source: "lichess" | "lirep";
  database: "lichess" | "masters";
  minRating: number | null;
  speeds: string[];
  calculatedAt: string | null;
  moves: number;
  lines: number;
}

type ExplorerSettingsRow = Pick<Opening, "source" | "database" | "minRating" | "speeds">;

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

// Same format as on a study's Stats page: pawns from the studied side's point
// of view, with forced mates (capped near 100,000 cp) spelled out.
function formatEval(cp: number): string {
  if (Math.abs(cp) > 99_000) return cp > 0 ? "Forced mate" : "Forced mate against";
  return `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;
}

// The Explorer settings the score was calculated with: win probability only
// means something next to the rating band and time controls behind it.
// Returns HTML: "Lirep" and "Lichess" link to the docs that say what their data is.
function settingsLabel(opening: ExplorerSettingsRow): string {
  const database = opening.source === "lirep"
    ? `<a class="source-lirep" href="/doc/stats.html#explorer-settings" title="${escapeHtml(LIREP_DATASET)}">Lirep</a>`
    : opening.database === "masters"
      ? "Masters games"
      : `<a class="source-lichess" href="/doc/stats.html#explorer-settings" title="Lichess's full Explorer, all Lichess players' games">Lichess</a>`;
  const rating = opening.database === "masters" ? "" : opening.minRating ? `${opening.minRating}+ · ` : "all ratings · ";
  const speeds = opening.database === "masters" || opening.speeds.length === 0 ? "" : opening.speeds.join(", ");
  return `${database}${rating || speeds ? " · " : ""}${rating}${escapeHtml(speeds)}`.replace(/ · $/, "");
}

function renderStats(summary: Summary): string {
  const card = (label: string, value: string, href?: string): string =>
    href
      ? `<a class="community-stat community-stat--link" href="${href}" title="See the list of players"><span>${label}</span><strong>${value}</strong></a>`
      : `<div class="community-stat"><span>${label}</span><strong>${value}</strong></div>`;
  return `
    <div class="community-stats">
      ${card("Players", String(summary.players), "/players.html")}
      ${card("Studies", String(summary.studies))}
      ${card("Shared with the community", String(summary.sharedStudies))}
      ${card("Active this week", String(summary.activeThisWeek))}
    </div>
  `;
}

function actionHtml(opening: Pick<Opening, "id" | "mine">, signedIn: boolean): string {
  return opening.mine
    ? `<span class="community-yours">Yours</span>`
    : signedIn
      ? `<button class="btn btn-secondary" type="button" data-import="${opening.id}">Import</button>`
      : `<a class="btn btn-secondary" href="/auth/login">Sign in to import</a>`;
}

function openingCellHtml(opening: Pick<Opening, "id" | "mine" | "name" | "side" | "moves" | "lines">): string {
  return `
      <td>
        <span class="side-pawn side-pawn--${opening.side}">${opening.side === "white" ? "♙" : "♟"}</span>
        <a class="opening-link" href="${opening.mine ? `/study.html?id=${opening.id}` : `/opening.html?id=${opening.id}`}"><strong>${escapeHtml(opening.name)}</strong></a>
        <div class="community-sub">${opening.moves} ${opening.moves === 1 ? "move" : "moves"} · ${opening.lines} ${opening.lines === 1 ? "line" : "lines"}</div>
      </td>`;
}

// The two leaderboards differ only in the metric they rank by; everything
// else (layout, columns, per-side tables) is shared so they read the same.
interface Leaderboard<T> {
  id: string;
  title: string;
  description: string;
  column: string;
  value: (opening: T) => string;
  settings: (opening: T) => string;
  empty: (side: string) => string;
}

type LeaderboardRow = Pick<Opening, "id" | "mine" | "name" | "side" | "moves" | "lines" | "owner"> & {
  rank: number | null;
};

const BY_EXPECTED_SCORE: Leaderboard<Opening> = {
  id: "leaderboard-score",
  title: "By expected score",
  description:
    "Ranked by the win percentage plus half of the draw percentage, if you always play the prepared moves and " +
    "opponents reply as in the Explorer.",
  column: "Expected score",
  value: (o) => (o.winProbability === null ? "—" : percent(o.winProbability)),
  settings: (o) => settingsLabel(o),
  empty: (side) => `No ranked openings for ${side} yet.`,
};

const BY_EXPECTED_EVALUATION: Leaderboard<EvalOpening> = {
  id: "leaderboard-eval",
  title: "By expected evaluation",
  description:
    "Ranked by Stockfish's average evaluation at the end of prep, in pawns from the prepared side's point of " +
    "view, with opponents replying as in the Explorer. Only evaluations at depth 12 (Balanced) or more are ranked.",
  column: "Expected evaluation",
  value: (o) => formatEval(o.evalCp),
  settings: (o) => `${settingsLabel(o)} · depth ${o.depth}`,
  empty: (side) => `No ranked openings for ${side} yet.`,
};

function renderRow<T extends LeaderboardRow>(board: Leaderboard<T>, opening: T, signedIn: boolean): string {
  return `
    <tr>
      <td class="community-rank">${opening.rank ?? "–"}</td>
      ${openingCellHtml(opening)}
      <td><a class="community-owner" href="/player.html?u=${encodeURIComponent(opening.owner)}">${escapeHtml(opening.owner)}</a></td>
      <td class="community-score">${board.value(opening)}</td>
      <td class="community-settings">${board.settings(opening)}</td>
      <td class="community-action">${actionHtml(opening, signedIn)}</td>
    </tr>
  `;
}

function renderTable<T extends LeaderboardRow>(
  board: Leaderboard<T>,
  openings: T[],
  signedIn: boolean,
  side: "white" | "black",
): string {
  const group = openings.filter((o) => o.side === side);
  const sideName = side === "white" ? "White" : "Black";
  const body = group.length
    ? `
      <div class="community-table-wrap">
        <table class="community-table">
          <thead>
            <tr><th>#</th><th>Opening</th><th>By</th><th>${board.column}</th><th>Calculated with</th><th></th></tr>
          </thead>
          <tbody>${group.map((o) => renderRow(board, o, signedIn)).join("")}</tbody>
        </table>
      </div>`
    : `<div class="empty-state"><p>${board.empty(sideName)}</p></div>`;
  return `
    <section class="opening-group">
      <h4>Openings for ${sideName}</h4>
      ${body}
    </section>
  `;
}

const renderTables = <T extends LeaderboardRow>(board: Leaderboard<T>, openings: T[], signedIn: boolean): string =>
  renderTable(board, openings, signedIn, "white") + renderTable(board, openings, signedIn, "black");

function renderLeaderboard<T extends LeaderboardRow>(board: Leaderboard<T>, openings: T[], signedIn: boolean): string {
  return `
    <section class="leaderboard" aria-labelledby="${board.id}-title">
      <h3 id="${board.id}-title">${board.title}</h3>
      <p class="profile-subtitle">${board.description}</p>
      <div id="${board.id}" class="opening-groups">
        ${renderTables(board, openings, signedIn)}
      </div>
    </section>
  `;
}

const LIREP_HELP =
  "Lirep is this site's own Explorer. It is built from Lichess's public game database, but holds only " +
  "a few months of games (" + LIREP_DATASET.replace("Lichess games, ", "") + ", about 10.7 million rated games), a much smaller and older sample " +
  "than the full Lichess Explorer. Scores calculated with it are less reliable and not comparable with the " +
  "Lichess Explorer's scores, so they are left out of the leaderboards unless you include them here.";

function render(
  main: HTMLElement,
  summary: Summary,
  openings: Opening[],
  evalOpenings: EvalOpening[],
  signedIn: boolean,
): void {
  main.innerHTML = `
    <p class="doc-intro">What people are preparing on lirep.org.</p>
    ${renderStats(summary)}

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Leaderboards</h2>
          <p class="profile-subtitle">
            Up to ten shared openings per side, best first, ranked two ways. Only openings calculated with Lichess's
            Explorer, on all Lichess players' games or on Masters games, are listed; results calculated from one
            particular player's games are left out. Names open their Lirep profiles.
          </p>
        </div>
      </div>
      <p class="community-note">
        Each row shows the rating band and time controls it was calculated with, so compare rows with the same
        settings. Studies are shared by default; authors can switch sharing off for any study on its page.
      </p>
      <div class="community-options">
        <label class="community-toggle">
          <input type="checkbox" id="include-lirep" />
          Include Lirep evaluations
        </label>
        <button id="lirep-help-btn" class="community-help" type="button" title="${LIREP_HELP}"
          aria-label="What are Lirep evaluations?" aria-expanded="false" aria-controls="lirep-help">?</button>
      </div>
      <p id="lirep-help" class="community-note community-help-text" hidden>${LIREP_HELP}</p>
      <div id="community-message" class="community-message" role="status" aria-live="polite" hidden></div>
      <div class="leaderboards">
        ${renderLeaderboard(BY_EXPECTED_SCORE, openings, signedIn)}
        ${renderLeaderboard(BY_EXPECTED_EVALUATION, evalOpenings, signedIn)}
      </div>
    </section>
  `;

  const message = main.querySelector<HTMLElement>("#community-message")!;
  const tables = main.querySelector<HTMLElement>(`#${BY_EXPECTED_SCORE.id}`)!;
  const evalTables = main.querySelector<HTMLElement>(`#${BY_EXPECTED_EVALUATION.id}`)!;

  function bindImports(): void {
    main.querySelectorAll<HTMLButtonElement>("[data-import]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const res = await fetch(`/api/community/import/${button.dataset.import}`, {
            method: "POST",
            credentials: "same-origin",
          });
          if (!res.ok) throw new Error(String(res.status));
          const study = await res.json();
          message.hidden = false;
          message.innerHTML = `Imported “${escapeHtml(study.name)}” into your studies. <a href="/study.html?id=${study.id}">Open it</a>`;
          button.textContent = "Imported";
        } catch {
          button.disabled = false;
          message.hidden = false;
          message.textContent = "Could not import this opening. Please try again.";
        }
      });
    });
  }
  bindImports();

  const helpButton = main.querySelector<HTMLButtonElement>("#lirep-help-btn")!;
  const helpText = main.querySelector<HTMLElement>("#lirep-help")!;
  helpButton.addEventListener("click", () => {
    helpText.hidden = !helpText.hidden;
    helpButton.setAttribute("aria-expanded", String(!helpText.hidden));
  });

  const includeLirep = main.querySelector<HTMLInputElement>("#include-lirep")!;
  includeLirep.addEventListener("change", async () => {
    includeLirep.disabled = true;
    try {
      const query = `includeLirep=${includeLirep.checked}`;
      const [res, evalRes] = await Promise.all([
        fetch(`/api/community/openings?${query}`, { credentials: "same-origin" }),
        fetch(`/api/community/openings-by-eval?${query}`, { credentials: "same-origin" }),
      ]);
      if (!res.ok || !evalRes.ok) throw new Error(String(res.ok ? evalRes.status : res.status));
      const fresh: Opening[] = await res.json();
      const freshEval: EvalOpening[] = await evalRes.json();
      tables.innerHTML = renderTables(BY_EXPECTED_SCORE, fresh, signedIn);
      evalTables.innerHTML = renderTables(BY_EXPECTED_EVALUATION, freshEval, signedIn);
      bindImports();
    } catch {
      includeLirep.checked = !includeLirep.checked;
      message.hidden = false;
      message.textContent = "Could not update the leaderboard. Please try again.";
    } finally {
      includeLirep.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("community-main");
  if (!main) return;

  try {
    const [summaryRes, openingsRes, evalRes] = await Promise.all([
      fetch("/api/community/summary", { credentials: "same-origin" }),
      fetch("/api/community/openings", { credentials: "same-origin" }),
      fetch("/api/community/openings-by-eval", { credentials: "same-origin" }),
    ]);
    if (!summaryRes.ok || !openingsRes.ok || !evalRes.ok) throw new Error("request failed");
    render(main, await summaryRes.json(), await openingsRes.json(), await evalRes.json(), me.authenticated);
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load the community page. Please try again in a moment.</p></div>`;
  }
}

init();
