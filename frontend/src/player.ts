import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface SharedStudy {
  id: number;
  mine: boolean;
  name: string;
  side: "white" | "black";
  winProbability: number | null;
  reason: string | null;
  moves: number;
  lines: number;
}

interface PlayerResponse {
  maxUsers: number;
  number: number;
  username: string;
  joined: string;
  studies: SharedStudy[];
}

// SQLite's datetime('now') is UTC without a zone marker.
function formatJoined(value: string): string {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function render(main: HTMLElement, data: PlayerResponse): void {
  const limit = data.maxUsers ? `/${data.maxUsers}` : "";
  const rows = data.studies
    .map(
      (s) => `
      <tr>
        <td><span class="side-pawn side-pawn--${s.side}">${s.side === "white" ? "♙" : "♟"}</span>
          <a class="opening-link" href="${s.mine ? `/study.html?id=${s.id}` : `/opening.html?id=${s.id}`}"><strong>${escapeHtml(s.name)}</strong></a>
          <div class="community-sub">${s.moves} ${s.moves === 1 ? "move" : "moves"} · ${s.lines} ${s.lines === 1 ? "line" : "lines"}</div></td>
        <td class="community-score">${s.winProbability === null ? "—" : `${(s.winProbability * 100).toFixed(1)}%`}</td>
      </tr>`,
    )
    .join("");

  main.innerHTML = `
    <p class="doc-intro"><a class="community-owner" href="/players.html">← Players</a></p>
    <div class="profile-header">
      <h1>${escapeHtml(data.username)}
        <a class="lichess-link" href="https://lichess.org/@/${encodeURIComponent(data.username)}" target="_blank" rel="noopener noreferrer" title="Lichess profile" aria-label="Lichess profile of ${escapeHtml(data.username)}"><span class="lichess-link__icon" aria-hidden="true"></span></a>
      </h1>
      <p class="profile-subtitle">Lirep user #${data.number}${limit} · joined ${escapeHtml(formatJoined(data.joined))}</p>
    </div>
    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Shared openings</h2>
          <p class="profile-subtitle">Repertoires ${escapeHtml(data.username)} chose to share.</p>
        </div>
      </div>
      ${data.studies.length
        ? `<div class="community-table-wrap"><table class="community-table">
            <thead><tr><th>Opening</th><th title="Win % + half of the draw %">Expected score</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : `<div class="empty-state profile-empty"><p>No shared openings yet.</p></div>`}
    </section>
  `;
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("player-main");
  if (!main) return;

  const username = new URLSearchParams(location.search).get("u");
  if (!username) {
    main.innerHTML = `<div class="empty-state"><p>No player selected.</p><a class="btn btn-secondary" href="/players.html">All players</a></div>`;
    return;
  }
  try {
    const res = await fetch(`/api/community/players/${encodeURIComponent(username)}`, { credentials: "same-origin" });
    if (res.status === 404) {
      main.innerHTML = `<div class="empty-state"><p>${escapeHtml(username)} is not on Lirep.</p><a class="btn btn-secondary" href="https://lichess.org/@/${encodeURIComponent(username)}" target="_blank" rel="noopener noreferrer">View on Lichess</a></div>`;
      return;
    }
    if (!res.ok) throw new Error("request failed");
    const data: PlayerResponse = await res.json();
    document.title = `${data.username} · lirep.org`;
    render(main, data);
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load this player. Please try again in a moment.</p></div>`;
  }
}

init();
