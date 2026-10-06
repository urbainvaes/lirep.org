import { LIREP_DATASET } from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface Summary {
  players: number;
  studies: number;
  sharedStudies: number;
  maxUsers: number;
  activeThisWeek: number;
  // Shared studies with a result ranked on the 2016 sample; the switch to
  // that view is only offered when there is one.
  lirepOpenings: number;
}

type Source = "lichess" | "lirep";

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
    ? `<a class="source-lirep" href="/doc/stats.html#explorer-settings" title="${escapeHtml(LIREP_DATASET)}">2016 sample</a>`
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
    <section class="leaderboard" id="${board.id}-section" aria-label="${board.title}" ${board.id === BY_EXPECTED_SCORE.id ? "" : "hidden"}>
      <p class="profile-subtitle">${board.description}</p>
      <div id="${board.id}" class="opening-groups">
        ${renderTables(board, openings, signedIn)}
      </div>
    </section>
  `;
}

// The leaderboards rank one Explorer's scores at a time, since the two
// aren't comparable: Lichess's (the default) or the local 2016 sample's.
const SAMPLE_TITLE =
  `This site's own Explorer: ${LIREP_DATASET} (about 10.7 million rated games), a much smaller and older ` +
  "sample than Lichess's Explorer, so its scores are ranked separately.";

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
      <div class="profile-section__heading leaderboards-heading">
        <h2>Leaderboards</h2>
        <div class="leaderboards-options">
          <div class="source-switch" role="group" aria-label="Metric">
            <span class="source-switch__label">Metric</span>
            <button type="button" data-metric="score" aria-pressed="true">Expected score</button>
            <button type="button" data-metric="eval" aria-pressed="false">Expected evaluation</button>
          </div>
          <div class="source-switch" role="group" aria-label="Explorer data" ${summary.lirepOpenings ? "" : "hidden"}>
            <span class="source-switch__label">Explorer data</span>
            <button type="button" data-source="lichess" aria-pressed="true">Lichess</button>
            <button type="button" data-source="lirep" aria-pressed="false" title="${escapeHtml(SAMPLE_TITLE)}">2016 sample</button>
          </div>
        </div>
      </div>
      <p class="community-note">
        Each row shows the rating band and time controls it was calculated with, so compare rows with the same
        settings; results from one player's games are not ranked. Studies are shared by default; authors can
        switch sharing off for any study on its page.
      </p>
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

  const switchButtons = [...main.querySelectorAll<HTMLButtonElement>(".source-switch [data-source]")];
  let source: Source = "lichess";

  async function showSource(wanted: Source): Promise<void> {
    if (wanted === source) return;
    switchButtons.forEach((b) => (b.disabled = true));
    try {
      const query = `source=${wanted}`;
      const [res, evalRes] = await Promise.all([
        fetch(`/api/community/openings?${query}`, { credentials: "same-origin" }),
        fetch(`/api/community/openings-by-eval?${query}`, { credentials: "same-origin" }),
      ]);
      if (!res.ok || !evalRes.ok) throw new Error(String(res.ok ? evalRes.status : res.status));
      const fresh: Opening[] = await res.json();
      const freshEval: EvalOpening[] = await evalRes.json();
      source = wanted;
      tables.innerHTML = renderTables(BY_EXPECTED_SCORE, fresh, signedIn);
      evalTables.innerHTML = renderTables(BY_EXPECTED_EVALUATION, freshEval, signedIn);
      bindImports();
      switchButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.source === source)));
    } catch {
      message.hidden = false;
      message.textContent = "Could not update the leaderboards. Please try again.";
    } finally {
      switchButtons.forEach((b) => (b.disabled = false));
    }
  }

  switchButtons.forEach((b) => b.addEventListener("click", () => void showSource(b.dataset.source as Source)));

  // One leaderboard at a time; both are already loaded, so switching is instant.
  const metricButtons = [...main.querySelectorAll<HTMLButtonElement>(".source-switch [data-metric]")];
  const sections = {
    score: main.querySelector<HTMLElement>(`#${BY_EXPECTED_SCORE.id}-section`)!,
    eval: main.querySelector<HTMLElement>(`#${BY_EXPECTED_EVALUATION.id}-section`)!,
  };
  metricButtons.forEach((button) =>
    button.addEventListener("click", () => {
      const metric = button.dataset.metric as keyof typeof sections;
      metricButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      sections.score.hidden = metric !== "score";
      sections.eval.hidden = metric !== "eval";
    }),
  );
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
