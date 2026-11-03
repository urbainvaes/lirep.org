import { badgeIcons, badgeShine, ICONS, setBadgePrefs, SHINES, type BadgeIcons, type BadgeShine } from "./badgePrefs";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import { ratedCount, ratingGridHtml, type Ratings } from "./ratings";
import { PIECES, pieceBadgeHtml, TIER_LABELS, TIERS, tierThreshold } from "./scoreTiers";

interface ProfileResponse {
  username: string;
  title?: string | null;
  userNumber: number;
  maxUsers: number;
  anonymous: boolean;
  serverCache: { allowed: boolean; enabled: boolean };
  ratings: Ratings;
}

function renderSignedOut(main: HTMLElement): void {
  main.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to see your profile.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

function renderProfile(main: HTMLElement, profile: ProfileResponse): void {
  const titlePrefix = profile.title ? `${escapeHtml(profile.title)} ` : "";

  main.innerHTML = `
    <div class="profile-header">
      <h1>${titlePrefix}${escapeHtml(profile.username)}</h1>
      <p class="profile-subtitle">Lirep user #${profile.userNumber}${profile.maxUsers ? `/${profile.maxUsers}` : ""}
        ${profile.maxUsers ? `<span class="beta-tag" title="This beta is limited to ${profile.maxUsers} users">beta limit</span>` : ""}</p>
    </div>

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Ratings</h2>
          <p class="profile-subtitle">Lichess rated games by time control</p>
        </div>
        <span class="profile-section__aside">${ratedCount(profile.ratings)} active formats</span>
      </div>
      ${ratingGridHtml(profile.ratings)}
    </section>

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Appearance</h2>
          <p class="profile-subtitle">How the studies' badges look, here and in the mobile app, on all your devices:
            their shine is the expected score's tier, their piece the expected evaluation's.</p>
        </div>
      </div>
      <div class="profile-prefs">
        <fieldset class="profile-pref">
          <legend>Shine</legend>
          ${SHINES.map((s) => `<label title="${escapeHtml(s.title)}"><input type="radio" name="badge-shine" value="${s.value}" ${s.value === badgeShine() ? "checked" : ""} /> ${s.label}</label>`).join("")}
        </fieldset>
        <fieldset class="profile-pref">
          <legend>Icons</legend>
          ${ICONS.map((i) => `<label title="${escapeHtml(i.title)}"><input type="radio" name="badge-icons" value="${i.value}" ${i.value === badgeIcons() ? "checked" : ""} /> ${i.label}</label>`).join("")}
        </fieldset>
      </div>
      ${badgeMatrix()}
      <span id="profile-prefs-status" class="profile-subtitle" role="status"></span>
    </section>

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Privacy</h2>
          <p class="profile-subtitle">Your shared studies stay on the Community page and can still be browsed and imported;
            only your name is hidden. Your public profile is hidden too.</p>
        </div>
      </div>
      <label class="study-share profile-anonymous">
        <input type="checkbox" id="profile-anonymous" ${profile.anonymous ? "checked" : ""} />
        Appear as anonymous in the community
      </label>
      <span id="profile-anonymous-status" class="profile-subtitle" role="status"></span>
    </section>

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Storage</h2>
          <p class="profile-subtitle">Opening Explorer answers and Stockfish evaluations are kept in this browser, so they
            aren't asked or calculated twice. With server storage, they are also kept on the server, shared with the other
            accounts that have it: they follow you across devices and survive clearing the browser.</p>
        </div>
      </div>
      <label class="study-share profile-anonymous${profile.serverCache.allowed ? "" : " profile-option--unavailable"}">
        <input type="checkbox" id="profile-server-cache" ${profile.serverCache.enabled ? "checked" : ""} ${profile.serverCache.allowed ? "" : "disabled"} />
        Keep Stockfish and Explorer data on the server
      </label>
      ${
        profile.serverCache.allowed
          ? ""
          : `<p class="profile-subtitle">Server storage is available on request: email <a href="mailto:contact@lirep.org">contact@lirep.org</a>.</p>`
      }
      <p id="profile-cache-size" class="profile-subtitle"></p>
      <span id="profile-server-cache-status" class="profile-subtitle" role="status"></span>
    </section>

    <section class="profile-section profile-delete">
      <div class="profile-section__heading">
        <h2>Account</h2>
      </div>
      <a class="btn btn-secondary" href="/auth/logout">Log out</a>
      <button id="delete-account-btn" class="btn btn-danger" type="button">Delete account</button>
      <span id="delete-account-status" class="profile-subtitle" role="status"></span>
    </section>
  `;
}

function bindDeleteAccount(username: string): void {
  const button = document.getElementById("delete-account-btn") as HTMLButtonElement | null;
  const status = document.getElementById("delete-account-status");
  if (!button || !status) return;
  button.addEventListener("click", async () => {
    const typed = window.prompt(
      `This permanently deletes your Lirep account: your studies, their games, your practice history and your forum posts. ` +
        `It cannot be undone; export any study you want to keep first.\n\nType your username (${username}) to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== username.toLowerCase()) {
      status.textContent = "The username didn't match; nothing was deleted.";
      return;
    }
    button.disabled = true;
    status.textContent = "Deleting…";
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (!res.ok) throw new Error(String(res.status));
      window.location.href = "/";
    } catch {
      button.disabled = false;
      status.textContent = "Could not delete the account. Please try again.";
    }
  });
}

function bindServerCacheToggle(): void {
  const input = document.getElementById("profile-server-cache") as HTMLInputElement | null;
  const status = document.getElementById("profile-server-cache-status");
  if (!input || !status || input.disabled) return;
  input.addEventListener("change", async () => {
    const wanted = input.checked;
    input.disabled = true;
    try {
      const res = await fetch("/api/profile/server-cache", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: wanted }),
      });
      if (!res.ok) throw new Error("request failed");
      status.textContent = wanted
        ? "Your Stockfish and Explorer data is now also kept on the server."
        : "Your Stockfish and Explorer data is now kept in this browser only.";
    } catch {
      input.checked = !wanted;
      status.textContent = "Could not change this setting. Please try again.";
    } finally {
      input.disabled = false;
    }
  });
}

// The server cache's total size, shared by the accounts with server storage.
async function showCacheSize(): Promise<void> {
  const el = document.getElementById("profile-cache-size");
  if (!el) return;
  try {
    const res = await fetch("/api/cache/size", { credentials: "same-origin" });
    if (!res.ok) return;
    const size = (await res.json()) as { bytes: number; explorerEntries: number; evaluations: number };
    const mb = size.bytes / 1e6;
    el.textContent =
      `Server cache: ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB in all ` +
      `(${size.explorerEntries.toLocaleString()} Explorer answers, ${size.evaluations.toLocaleString()} Stockfish evaluations).`;
  } catch {
    // The size is only informative.
  }
}

// Every badge, as the choices make them look: a row per tier of the expected
// score (White's and Black's thresholds), a column per piece of the expected
// evaluation (for the studied side). Built from scoreTiers.ts.
function badgeMatrix(): string {
  const pct = (white: number, side: "white" | "black") => `${tierThreshold(white, side)}%`;
  const lowest = TIERS[TIERS.length - 1].white;
  const tierRange = (i: number) =>
    i < TIERS.length ? `${pct(TIERS[i].white, "white")} / ${pct(TIERS[i].white, "black")} or more` : `under ${pct(lowest, "white")} / ${pct(lowest, "black")}`;
  const pieceRange = (i: number) =>
    i < PIECES.length - 1 ? `+${PIECES[i].from.toFixed(2)} or more` : `under +${PIECES[i - 1].from.toFixed(2)}`;
  const tiers = [...TIERS.map((t) => t.tier), "none" as const];
  const head = PIECES.map((p, i) => `<th scope="col">${p.label}<span class="badge-matrix__range">${pieceRange(i)}</span></th>`).join("");
  const rows = tiers
    .map(
      (tier, i) => `<tr>
        <th scope="row">${TIER_LABELS[tier]}<span class="badge-matrix__range">${tierRange(i)}</span></th>
        ${PIECES.map((p) => `<td title="${TIER_LABELS[tier]} ${p.label}">${pieceBadgeHtml(tier, "", p.piece)}</td>`).join("")}
      </tr>`,
    )
    .join("");
  return `<div class="badge-matrix" aria-label="Preview of every badge">
    <table>
      <thead><tr><th scope="col" class="badge-matrix__corner">Expected score <span class="badge-matrix__range">White / Black</span>
        <span class="badge-matrix__corner-sep">×</span> evaluation <span class="badge-matrix__range">for your side</span></th>${head}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// The badges' look: applied at once, the preview included.
function bindBadgePrefs(): void {
  const status = document.getElementById("profile-prefs-status");
  document.querySelector(".profile-prefs")?.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const saved =
      input.name === "badge-shine" ? setBadgePrefs({ shine: input.value as BadgeShine })
      : input.name === "badge-icons" ? setBadgePrefs({ icons: input.value as BadgeIcons })
      : null;
    if (saved && status) status.textContent = (await saved) ? "" : "Shown in this browser, but not saved with your account. Please try again.";
  });
}

function bindAnonymousToggle(): void {
  const input = document.getElementById("profile-anonymous") as HTMLInputElement | null;
  const status = document.getElementById("profile-anonymous-status");
  if (!input || !status) return;
  input.addEventListener("change", async () => {
    const wanted = input.checked;
    input.disabled = true;
    try {
      const res = await fetch("/api/profile/anonymous", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anonymous: wanted }),
      });
      if (!res.ok) throw new Error("request failed");
      status.textContent = wanted ? "You now appear as anonymous." : "Your name is shown again.";
    } catch {
      input.checked = !wanted;
      status.textContent = "Could not change this setting. Please try again.";
    } finally {
      input.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("profile-main");
  if (!main) return;

  if (!me.authenticated) {
    renderSignedOut(main);
    return;
  }

  try {
    const profileRes = await fetch("/api/profile", { credentials: "same-origin" });
    if (!profileRes.ok) {
      renderSignedOut(main);
      return;
    }
    const profile: ProfileResponse = await profileRes.json();
    renderProfile(main, profile);
    bindBadgePrefs();
    bindAnonymousToggle();
    bindServerCacheToggle();
    void showCacheSize();
    bindDeleteAccount(profile.username);
  } catch {
    renderSignedOut(main);
  }
}

init();
