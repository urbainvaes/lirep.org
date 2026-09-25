import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface Summary {
  players: number;
  studies: number;
  sharedStudies: number;
  rankedOpenings: number;
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

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

// The Explorer settings the score was calculated with: win probability only
// means something next to the rating band and time controls behind it.
function settingsLabel(opening: Opening): string {
  const database = opening.source === "lirep"
    ? "Lirep (local, Mar 2016 games)"
    : opening.database === "masters" ? "Masters games" : "Lichess games";
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
      ${card("Active this week", String(summary.activeThisWeek))}
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
      <td class="community-rank">${opening.rank ?? "–"}</td>
      <td>
        <span class="side-pawn side-pawn--${opening.side}">${opening.side === "white" ? "♙" : "♟"}</span>
        <strong>${escapeHtml(opening.name)}</strong>
        <div class="community-sub">${opening.moves} ${opening.moves === 1 ? "move" : "moves"} · ${opening.lines} ${opening.lines === 1 ? "line" : "lines"}</div>
      </td>
      <td><a class="community-owner" href="https://lichess.org/@/${encodeURIComponent(opening.owner)}" target="_blank" rel="noopener noreferrer">${escapeHtml(opening.owner)}</a></td>
      <td class="community-score">${opening.winProbability === null ? "—" : percent(opening.winProbability)}</td>
      <td class="community-settings">${escapeHtml(opening.winProbability === null ? (opening.reason ?? "Not ranked yet") : settingsLabel(opening))}</td>
      <td class="community-action">${action}</td>
    </tr>
  `;
}

function renderTable(openings: Opening[], signedIn: boolean, side: "white" | "black"): string {
  const group = openings.filter((o) => o.side === side);
  const title = side === "white" ? "Openings for White" : "Openings for Black";
  const body = group.length
    ? `
      <div class="community-table-wrap">
        <table class="community-table">
          <thead>
            <tr><th>#</th><th>Opening</th><th>By</th><th title="Win % + half of the draw %">Expected score</th><th>Calculated with</th><th></th></tr>
          </thead>
          <tbody>${group.map((o) => renderRow(o, signedIn)).join("")}</tbody>
        </table>
      </div>`
    : `<div class="empty-state"><p>No evaluated openings for ${side === "white" ? "White" : "Black"} yet.</p></div>`;
  return `
    <section class="opening-group">
      <h2>${title}</h2>
      ${body}
    </section>
  `;
}

const LIREP_HELP =
  "Lirep is this site's own Explorer: only games from March 2016 (about 5.8 million rated games), a much smaller " +
  "and older sample than Lichess's full database. Scores calculated with it are less reliable and not comparable " +
  "with Lichess scores, so they are left out of the leaderboard unless you include them here.";

function render(main: HTMLElement, summary: Summary, openings: Opening[], signedIn: boolean): void {
  main.innerHTML = `
    <p class="doc-intro">What people are preparing on lirep.org.</p>
    ${renderStats(summary)}

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Opening leaderboard</h2>
          <p class="profile-subtitle">
            Up to ten shared openings per side, best score first. The expected score is the win percentage plus half
            of the draw percentage, if you always play the prepared moves and opponents reply as in the Explorer.
            Only openings evaluated with Lichess's Explorer are listed. Names link to Lichess profiles.
          </p>
        </div>
      </div>
      <p class="community-note">
        Scores come from the hosted Lichess Explorer, with the rating band and time controls shown on each row, so
        compare rows with the same settings. Studies are shared by default; authors can switch sharing off for any
        study on its page.
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
      <div id="community-tables" class="opening-groups">
        ${renderTable(openings, signedIn, "white")}
        ${renderTable(openings, signedIn, "black")}
      </div>
    </section>
  `;

  const message = main.querySelector<HTMLElement>("#community-message")!;
  const tables = main.querySelector<HTMLElement>("#community-tables")!;

  function bindImports(): void {
    tables.querySelectorAll<HTMLButtonElement>("[data-import]").forEach((button) => {
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
      const res = await fetch(`/api/community/openings?includeLirep=${includeLirep.checked}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(String(res.status));
      const fresh: Opening[] = await res.json();
      tables.innerHTML = renderTable(fresh, signedIn, "white") + renderTable(fresh, signedIn, "black");
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
