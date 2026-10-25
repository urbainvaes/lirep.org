import { LEAF_VALUE_LABELS, LIREP_DATASET, type LeafValue } from "./explorer";
import { applyBoardTheme } from "./board";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { observeMiniBoards } from "./miniBoard";
import { bindTitleScroll, cardBoardSpec, studyBadgeHtml, studyCardBodyHtml, studySizeHtml } from "./studyCard";

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
  owner: string | null;
  anonymous: boolean;
  mine: boolean;
  winProbability: number | null;
  reason: string | null;
  source: "lichess" | "lirep" | null;
  database: "lichess" | "masters" | null;
  minRating: number | null;
  speeds: string[];
  leafValue: LeafValue;
  depth: number | null; // Stockfish depth, when Stockfish valued lines' ends
  calculatedAt: string | null;
  moves: number;
  lines: number;
  games: number;
  startLine: string[];
  mainLine: string[];
  badge: Badge;
}

// The badge's expected score and evaluation, as calculated, ranked or not.
interface Badge {
  winProbability: number | null;
  evalCp: number | null;
  evalDepth: number | null;
  scoreFreshnessReason: string | null;
  evalFreshnessReason: string | null;
}

// A row of the leaderboard by expected evaluation (/api/community/openings-by-eval).
interface EvalOpening {
  rank: number;
  id: number;
  name: string;
  side: "white" | "black";
  owner: string | null;
  anonymous: boolean;
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
  games: number;
  startLine: string[];
  mainLine: string[];
  badge: Badge;
}

type ExplorerSettingsRow = Pick<Opening, "source" | "database" | "minRating" | "speeds">;

// A setting a result was calculated with, on a line of its own: its name,
// then its value as text and as HTML (which may link to the docs).
interface Setting {
  name: string;
  text: string;
  html?: string;
}

// The Explorer settings the result was calculated with: a result only means
// something next to the games, rating band and time controls behind it.
// "2016 sample" and "Lichess" link to the docs that say what their data is.
function explorerSettings(opening: ExplorerSettingsRow): Setting[] {
  const explorer: Setting = opening.source === "lirep"
    ? {
        name: "Explorer",
        text: "2016 sample",
        html: `<a class="source-lirep" href="/doc/stats.html#explorer-settings" title="${escapeHtml(LIREP_DATASET)}">2016 sample</a>`,
      }
    : opening.database === "masters"
      ? { name: "Explorer", text: "Masters games" }
      : {
          name: "Explorer",
          text: "Lichess",
          html: `<a class="source-lichess" href="/doc/stats.html#explorer-settings" title="Lichess's full Explorer, all Lichess players' games">Lichess</a>`,
        };
  if (opening.database === "masters") return [explorer];
  return [
    explorer,
    { name: "Ratings", text: opening.minRating ? `${opening.minRating}+` : "all" },
    { name: "Time controls", text: opening.speeds.length ? opening.speeds.join(", ") : "all" },
  ];
}

// One line each, the name in bold; a value too long for the card ends in an
// ellipsis, and shows in full on hover.
function settingsHtml(settings: Setting[]): string {
  return settings
    .map(
      (s) =>
        `<span class="study-card__setting" title="${escapeHtml(`${s.name}: ${s.text}`)}"><strong>${s.name}:</strong> ${
          s.html ?? escapeHtml(s.text)
        }</span>`,
    )
    .join("");
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

// A card's button: Import, or "Yours" on your own.
function actionsHtml(opening: Pick<Opening, "id" | "mine">, signedIn: boolean): string {
  return opening.mine
    ? `<span class="community-yours">Yours</span>`
    : signedIn
      ? `<button class="btn btn-secondary" type="button" data-import="${opening.id}">Import</button>`
      : `<a class="btn btn-secondary" href="/auth/login">Sign in to import</a>`;
}

// The two leaderboards differ only in the metric they rank by; everything
// else (layout, columns, per-side tables) is shared so they read the same.
interface Leaderboard<T> {
  id: string;
  title: string;
  description: string;
  /** The value of the expected result it ranks by, in bold on its cards. */
  ranked: "score" | "eval";
  settings: (opening: T) => Setting[];
  empty: (side: string) => string;
}

type LeaderboardRow = Pick<
  Opening,
  "id" | "mine" | "name" | "side" | "moves" | "lines" | "games" | "startLine" | "mainLine" | "badge" | "owner" | "anonymous"
> & {
  rank: number | null;
};

const BY_EXPECTED_SCORE: Leaderboard<Opening> = {
  id: "leaderboard-score",
  title: "By expected score",
  description:
    "Ranked by the win percentage plus half of the draw percentage, if you always play the prepared moves and " +
    "opponents reply as in the Explorer.",
  ranked: "score",
  // Scores whose lines' ends weren't valued with the Explorer's results say
  // how they were, with Stockfish's depth.
  // Stockfish's depth: the score's, when Stockfish valued lines' ends, else
  // the expected evaluation's, if calculated.
  settings: (o) => {
    const depth = o.leafValue === "explorer" ? o.badge.evalDepth : o.depth;
    return [
      ...explorerSettings(o),
      { name: "End of prep", text: LEAF_VALUE_LABELS[o.leafValue] },
      ...(depth ? [{ name: "Stockfish", text: `depth ${depth}` }] : []),
    ];
  },
  empty: (side) => `No ranked openings for ${side} yet.`,
};

const BY_EXPECTED_EVALUATION: Leaderboard<EvalOpening> = {
  id: "leaderboard-eval",
  title: "By expected evaluation",
  description:
    "Ranked by Stockfish's average evaluation at the end of prep, best for the prepared side first, in pawns " +
    "from White's point of view (negative when Black is better), with opponents replying as in the Explorer. Only evaluations at depth 12 (Balanced) or more are ranked.",
  ranked: "eval",
  settings: (o) => [...explorerSettings(o), { name: "Stockfish", text: `depth ${o.depth}` }],
  empty: (side) => `No ranked openings for ${side} yet.`,
};

// An anonymous player's name is only sent to themselves.
function ownerHtml(opening: LeaderboardRow): string {
  if (opening.owner === null) return `<span class="community-anonymous">Anonymous</span>`;
  const link = `<a class="community-owner" href="/player.html?u=${encodeURIComponent(opening.owner)}">${escapeHtml(opening.owner)}</a>`;
  return opening.anonymous ? `${link} <span class="community-anonymous">(anonymous)</span>` : link;
}

// A card as on the home page, with the rank before the name (which opens
// the study, read-only), the settings the result was calculated with under
// it (folded, one per line), the tree's size and games under the opening
// line, and at the bottom the author, then Import.
function renderCard<T extends LeaderboardRow>(board: Leaderboard<T>, opening: T, signedIn: boolean): string {
  return `
    <article class="study-card study-card--summary">
      ${studyCardBodyHtml({
        titleHtml: `<span class="study-card__rank">${opening.rank ?? "–"}</span> <a class="study-card__title-link" href="/opening.html?id=${opening.id}">${escapeHtml(opening.name)}</a>`,
        titleText: opening.name,
        headerEnd: studyBadgeHtml(opening.badge, opening.side, opening.mine ? opening.id : undefined),
        stats: opening.badge,
        ranked: board.ranked,
        afterResult: `${opening.badge.scoreFreshnessReason ? `<p class="study-card__meta">Expected score: ${escapeHtml(opening.badge.scoreFreshnessReason)}</p>` : ""}
          ${opening.badge.evalFreshnessReason ? `<p class="study-card__meta">Expected evaluation: ${escapeHtml(opening.badge.evalFreshnessReason)}</p>` : ""}
          <details class="study-card__meta study-card__settings">
          <summary>Calculation settings</summary>
          <div class="study-card__settings-list">${settingsHtml(board.settings(opening))}</div>
        </details>`,
        startLine: opening.startLine,
        board: { mainLine: opening.mainLine },
        side: opening.side,
      })}
      <p class="study-card__meta">${studySizeHtml({ moves: opening.moves, lines: opening.lines, games: { count: opening.games } })}</p>
      <div class="study-card__footer">
        <span class="study-card__author">by ${ownerHtml(opening)}</span>
        ${actionsHtml(opening, signedIn)}
      </div>
    </article>
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
      <div class="studies-grid">${group.map((o) => renderCard(board, o, signedIn)).join("")}</div>`
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
  `This site's own Explorer: ${LIREP_DATASET} (about 16.7 million rated games), a much smaller and older ` +
  "sample than Lichess's Explorer, so its scores are ranked separately.";

interface TopPlayer {
  username: string | null; // null: an anonymous player
  title: string | null;
  rating: number;
  roundedDown: boolean; // anonymous players' ratings: "2100+"
}

type TopPlayers = Record<"bullet" | "blitz" | "rapid", TopPlayer[]>;

// Glyphs from lichess.org's icon font, as on the profile page.
const TOP_SPEEDS = [
  { key: "bullet", label: "Bullet", icon: "\ue032" },
  { key: "blitz", label: "Blitz", icon: "\ue008" },
  { key: "rapid", label: "Rapid", icon: "\ue002" },
] as const;

function renderTopPlayers(top: TopPlayers): string {
  return TOP_SPEEDS.map(({ key, label, icon }) => {
    const rows = top[key]
      .map(
        (p, i) => `
        <li class="top-players__row">
          <span class="top-players__rank">${i + 1}</span>
          ${
            p.username === null
              ? `<span class="top-players__name">${
                  p.title ? `<span class="top-players__title">${escapeHtml(p.title)}</span> ` : ""
                }<span class="community-anonymous">Anonymous</span></span>`
              : `<a class="community-owner top-players__name" href="/player.html?u=${encodeURIComponent(p.username)}">${
                  p.title ? `<span class="top-players__title">${escapeHtml(p.title)}</span> ` : ""
                }${escapeHtml(p.username)}</a>`
          }
          <span class="top-players__rating"${p.roundedDown ? ` title="Rounded down to the hundred"` : ""}>${p.rating}${p.roundedDown ? "+" : ""}</span>
        </li>`,
      )
      .join("");
    return `
      <div class="top-players__column">
        <h3 class="top-players__speed"><span data-icon="${icon}" aria-hidden="true"></span>${label}</h3>
        ${rows ? `<ol class="top-players__list">${rows}</ol>` : `<p class="community-note">No rated players yet.</p>`}
      </div>`;
  }).join("");
}

// Loaded after the rest of the page: the ratings come from Lichess.
async function loadTopPlayers(container: HTMLElement): Promise<void> {
  try {
    const res = await fetch("/api/community/top-players", { credentials: "same-origin" });
    if (!res.ok) throw new Error(String(res.status));
    container.innerHTML = renderTopPlayers(await res.json());
  } catch {
    container.innerHTML = `<p class="community-note">Could not load the ratings from Lichess. Please try again later.</p>`;
  }
}

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
        Each card shows the rating band and time controls it was calculated with, so compare cards with the same
        settings; results from one player's games are not ranked. Studies are shared by default; authors can
        switch sharing off for any study on its page.
      </p>
      <div id="community-message" class="community-message" role="status" aria-live="polite" hidden></div>
      <div class="leaderboards">
        ${renderLeaderboard(BY_EXPECTED_SCORE, openings, signedIn)}
        ${renderLeaderboard(BY_EXPECTED_EVALUATION, evalOpenings, signedIn)}
      </div>
    </section>

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Strongest players</h2>
          <p class="profile-subtitle">Players on lirep.org with the highest Lichess ratings, updated hourly. Anonymous players' ratings are rounded down to the hundred.</p>
        </div>
      </div>
      <div class="top-players" id="top-players"><p class="community-note">Loading…</p></div>
    </section>
  `;
  void loadTopPlayers(main.querySelector<HTMLElement>("#top-players")!);

  const message = main.querySelector<HTMLElement>("#community-message")!;
  const tables = main.querySelector<HTMLElement>(`#${BY_EXPECTED_SCORE.id}`)!;
  const evalTables = main.querySelector<HTMLElement>(`#${BY_EXPECTED_EVALUATION.id}`)!;
  // The cards' boards, mounted as they scroll into view (the hidden
  // leaderboard's once it's shown), and again after the Explorer switch.
  let unmountBoards = observeMiniBoards(main, cardBoardSpec);

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

  async function show(wantedSource: Source): Promise<void> {
    if (wantedSource === source) return;
    switchButtons.forEach((b) => (b.disabled = true));
    try {
      const [res, evalRes] = await Promise.all([
        fetch(`/api/community/openings?source=${wantedSource}`, { credentials: "same-origin" }),
        fetch(`/api/community/openings-by-eval?source=${wantedSource}`, { credentials: "same-origin" }),
      ]);
      if (!res.ok || !evalRes.ok) throw new Error(String(res.ok ? evalRes.status : res.status));
      const fresh: Opening[] = await res.json();
      const freshEval: EvalOpening[] = await evalRes.json();
      source = wantedSource;
      tables.innerHTML = renderTables(BY_EXPECTED_SCORE, fresh, signedIn);
      evalTables.innerHTML = renderTables(BY_EXPECTED_EVALUATION, freshEval, signedIn);
      unmountBoards();
      unmountBoards = observeMiniBoards(main, cardBoardSpec);
      bindImports();
      switchButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.source === source)));
    } catch {
      message.hidden = false;
      message.textContent = "Could not update the leaderboards. Please try again.";
    } finally {
      switchButtons.forEach((b) => (b.disabled = false));
    }
  }

  switchButtons.forEach((b) => b.addEventListener("click", () => void show(b.dataset.source as Source)));

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
  bindTitleScroll(main);
  void applyBoardTheme();

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
