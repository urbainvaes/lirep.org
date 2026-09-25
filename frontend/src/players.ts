import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface Player {
  number: number;
  username: string;
  joined: string;
  sharedStudies: number;
}

interface PlayersResponse {
  maxUsers: number;
  players: Player[];
}

// SQLite's datetime('now') is UTC without a zone marker.
function formatJoined(value: string): string {
  const date = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function render(main: HTMLElement, data: PlayersResponse): void {
  const limit = data.maxUsers ? ` / ${data.maxUsers}` : "";
  const rows = data.players
    .map(
      (player) => `
      <tr>
        <td class="community-rank">${player.number}</td>
        <td><a class="community-owner" href="/player.html?u=${encodeURIComponent(player.username)}">${escapeHtml(player.username)}</a></td>
        <td>${player.sharedStudies}</td>
        <td class="community-settings">${escapeHtml(formatJoined(player.joined))}</td>
      </tr>`,
    )
    .join("");

  main.innerHTML = `
    <p class="doc-intro"><a class="community-owner" href="/community.html">← Community</a></p>
    <div class="profile-section__heading">
      <div>
        <h2>Players ${data.players.length}${limit}
          ${data.maxUsers ? `<span class="beta-tag" title="This beta is limited to ${data.maxUsers} users">beta limit</span>` : ""}
        </h2>
        <p class="profile-subtitle">Everyone who has signed in during the beta, in order of arrival. Names open their Lirep profiles.</p>
      </div>
    </div>
    <div class="community-table-wrap">
      <table class="community-table">
        <thead><tr><th>#</th><th>Player</th><th>Shared openings</th><th>Joined</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("players-main");
  if (!main) return;

  try {
    const res = await fetch("/api/community/players", { credentials: "same-origin" });
    if (!res.ok) throw new Error("request failed");
    render(main, await res.json());
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load the players. Please try again in a moment.</p></div>`;
  }
}

init();
