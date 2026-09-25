import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface Summary {
  players: number;
  studies: number;
  sharedStudies: number;
  rankedOpenings: number;
  averageWinProbability: number | null;
}

interface Opening {
  rank: number;
  id: number;
  name: string;
  side: "white" | "black";
  owner: string;
  mine: boolean;
  winProbability: number;
  database: "lichess" | "masters" | null;
  minRating: number | null;
  speeds: string[];
  calculatedAt: string | null;
  moves: number;
  lines: number;
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

// The Explorer settings the score was calculated with: win probability only
// means something next to the rating band and time controls behind it.
function settingsLabel(opening: Opening): string {
  const database = opening.database === "masters" ? "Masters games" : "Lichess games";
  const rating = opening.database === "masters" ? "" : opening.minRating ? `${opening.minRating}+ · ` : "all ratings · ";
  const speeds = opening.database === "masters" || opening.speeds.length === 0 ? "" : opening.speeds.join(", ");
  return `${database}${rating || speeds ? " · " : ""}${rating}${speeds}`.replace(/ · $/, "");
}

function renderStats(summary: Summary): string {
  const card = (label: string, value: string): string =>
    `<div class="community-stat"><span>${label}</span><strong>${value}</strong></div>`;
  return `
    <div class="community-stats">
      ${card("Players", String(summary.players))}
      ${card("Studies", String(summary.studies))}
      ${card("Shared with the community", String(summary.sharedStudies))}
      ${card("Ranked openings", String(summary.rankedOpenings))}
      ${card("Average expected score", summary.averageWinProbability === null ? "—" : percent(summary.averageWinProbability))}
    </div>
  `;
}

function renderRow(opening: Opening, signedIn: boolean): string {
  const action = opening.mine
    ? `<span class="community-yours">Yours</span>`
    : signedIn
      ? `<button class="btn btn-secondary" type="button" data-import="${opening.id}">Import</button>`
      : `<a class="btn btn-secondary" href="/auth/login">Sign in to import</a>`;
  return `
    <tr>
      <td class="community-rank">${opening.rank}</td>
      <td>
        <span class="side-pawn side-pawn--${opening.side}">${opening.side === "white" ? "♙" : "♟"}</span>
        <strong>${escapeHtml(opening.name)}</strong>
        <div class="community-sub">${opening.moves} ${opening.moves === 1 ? "move" : "moves"} · ${opening.lines} ${opening.lines === 1 ? "line" : "lines"}</div>
      </td>
      <td>${escapeHtml(opening.owner)}</td>
      <td class="community-score">${percent(opening.winProbability)}</td>
      <td class="community-settings">${escapeHtml(settingsLabel(opening))}</td>
      <td class="community-action">${action}</td>
    </tr>
  `;
}

function render(main: HTMLElement, summary: Summary, openings: Opening[], signedIn: boolean): void {
  const table = openings.length
    ? `
      <div class="community-table-wrap">
        <table class="community-table">
          <thead>
            <tr><th>#</th><th>Opening</th><th>By</th><th>Expected score</th><th>Calculated with</th><th></th></tr>
          </thead>
          <tbody>${openings.map((o) => renderRow(o, signedIn)).join("")}</tbody>
        </table>
      </div>`
    : `<div class="empty-state"><p>No shared openings with a calculated score yet. Share one of yours from the study page, after calculating its stats.</p></div>`;

  main.innerHTML = `
    <h1 class="page-title">Community</h1>
    <p class="doc-intro">What people are preparing on lirep.org.</p>
    ${renderStats(summary)}

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Opening leaderboard</h2>
          <p class="profile-subtitle">
            Openings their authors chose to share, ranked by expected score: the chance of winning, counting draws
            as half, if you always play the prepared moves and opponents reply as in the Lichess Explorer.
          </p>
        </div>
      </div>
      <p class="community-note">
        Scores come only from the hosted Lichess Explorer, with the rating band and time controls shown on each row,
        so compare rows with the same settings. Studies are private unless their author switches on sharing.
      </p>
      <div id="community-message" class="community-message" role="status" aria-live="polite" hidden></div>
      ${table}
    </section>
  `;

  const message = main.querySelector<HTMLElement>("#community-message")!;
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

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("community-main");
  if (!main) return;

  try {
    const [summaryRes, openingsRes] = await Promise.all([
      fetch("/api/community/summary", { credentials: "same-origin" }),
      fetch("/api/community/openings", { credentials: "same-origin" }),
    ]);
    if (!summaryRes.ok || !openingsRes.ok) throw new Error("request failed");
    render(main, await summaryRes.json(), await openingsRes.json(), me.authenticated);
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load the community page. Please try again in a moment.</p></div>`;
  }
}

init();
