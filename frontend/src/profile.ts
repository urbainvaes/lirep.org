import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import type { StudyTree } from "./tree";

interface RatingInfo {
  rating: number;
  games: number;
  provisional: boolean;
}

interface ProfileResponse {
  username: string;
  title?: string | null;
  userNumber: number;
  maxUsers: number;
  anonymous: boolean;
  ratings: Partial<Record<"bullet" | "blitz" | "rapid" | "classical", RatingInfo>>;
}

interface ProfileStudy {
  id: number;
  name: string;
  tree: StudyTree;
  side: "white" | "black";
  stats: { winProbability?: number } | null;
}

interface PracticeSummary {
  totalItems: number;
  dueCount: number;
  newCount: number;
  aggregateKnowledge: number | null;
}

// Glyph codes from lichess.org's own icon font (see style.css), read off a
// live Lichess profile page's data-icon attributes for these perf types.
const SPEEDS: { key: keyof ProfileResponse["ratings"]; label: string; icon: string }[] = [
  { key: "bullet", label: "Bullet", icon: "" },
  { key: "blitz", label: "Blitz", icon: "" },
  { key: "rapid", label: "Rapid", icon: "" },
  { key: "classical", label: "Classical", icon: "" },
];

function renderSignedOut(main: HTMLElement): void {
  main.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to see your profile.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}

function renderProfile(
  main: HTMLElement,
  profile: ProfileResponse,
  studies: ProfileStudy[],
  practice: Record<string, PracticeSummary>,
): void {
  const ratedSpeeds = SPEEDS.flatMap(({ key, label }) => {
    const info = profile.ratings[key];
    return info ? [{ label, ...info }] : [];
  });
  const ratingCards = SPEEDS.map(({ key, label, icon }) => {
    const info = profile.ratings[key];
    const value = info ? info.rating : "Unrated";
    const detail = info ? `${info.games} games${info.provisional ? " · provisional" : ""}` : "No rated games yet";
    return `
      <div class="rating-card">
        <div class="rating-card__icon" data-icon="${icon}"></div>
        <div class="rating-card__label">${label}</div>
        <div class="rating-card__value">${value}</div>
        <div class="rating-card__detail">${detail}</div>
      </div>
    `;
  }).join("");

  const titlePrefix = profile.title ? `${escapeHtml(profile.title)} ` : "";

  function countLines(nodeId: number, tree: StudyTree): number {
    const children = tree.nodes[nodeId].children;
    if (children.length === 0) return nodeId === tree.rootId ? 0 : 1;
    return children.reduce((sum, childId) => sum + countLines(childId, tree), 0);
  }

  const studyRows = studies
    .map((study) => {
      const summary = practice[String(study.id)];
      const moveCount = Math.max(0, Object.keys(study.tree.nodes).length - 1);
      const lineCount = countLines(study.tree.rootId, study.tree);
      const score = study.stats?.winProbability;
      const hasPracticeMoves = (summary?.totalItems ?? 0) > 0;
      return `
        <article class="profile-study-row">
          <div class="profile-study-row__main">
            <span class="side-pawn side-pawn--${study.side}">${study.side === "white" ? "♙" : "♟"}</span>
            <div class="profile-study-row__text">
              <strong>${escapeHtml(study.name)}</strong>
              <span title="Expected score = win % + half of the draw %">${moveCount} ${moveCount === 1 ? "move" : "moves"} · ${lineCount} ${lineCount === 1 ? "line" : "lines"}${score === undefined ? "" : ` · ${(score * 100).toFixed(1)}% expected score`}</span>
            </div>
          </div>
          <div class="profile-study-row__practice">
            <span>${hasPracticeMoves ? `${summary.dueCount} due · ${summary.newCount} new` : "No moves to practice"}</span>
            ${hasPracticeMoves ? `<a class="btn btn-secondary" href="/practice-session.html?id=${study.id}">Practice</a>` : `<a class="btn btn-secondary" href="/study.html?id=${study.id}">Edit</a>`}
          </div>
        </article>
      `;
    })
    .join("");

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
        <span class="profile-section__aside">${ratedSpeeds.length} active formats</span>
      </div>
      <div class="rating-grid">${ratingCards}</div>
    </section>

    <section class="profile-section">
      <div class="profile-section__heading">
        <div>
          <h2>Your repertoires</h2>
          <p class="profile-subtitle">Prepared lines, ready for review.</p>
        </div>
        <a class="profile-section__link" href="/">All studies <span aria-hidden="true">→</span></a>
      </div>
      ${studyRows
        ? `<div class="profile-study-list">${studyRows}</div>`
        : `<div class="empty-state profile-empty"><p>No repertoires yet. Start with a line you want to remember.</p><a class="btn btn-primary" href="/study.html">Create your first study</a></div>`}
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

    <section class="profile-section profile-delete">
      <div class="profile-section__heading">
        <div>
          <h2>Delete account</h2>
          <p class="profile-subtitle">Deletes your studies, their games and your practice history, and signs you out.
            Your forum posts are deleted too; a topic you started that others replied to stays for their replies,
            without your name. This cannot be undone. Export any study you want to keep first.</p>
        </div>
      </div>
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
      `This permanently deletes your Lirep account and all your studies.\n\nType your username (${username}) to confirm:`,
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
    const [profileRes, studiesRes, practiceRes] = await Promise.all([
      fetch("/api/profile", { credentials: "same-origin" }),
      fetch("/api/studies", { credentials: "same-origin" }).catch(() => null),
      fetch("/api/practice/summary", { credentials: "same-origin" }).catch(() => null),
    ]);
    if (!profileRes.ok) {
      renderSignedOut(main);
      return;
    }
    const profile: ProfileResponse = await profileRes.json();
    const studies: ProfileStudy[] = studiesRes?.ok ? await studiesRes.json() : [];
    const practice: Record<string, PracticeSummary> = practiceRes?.ok ? await practiceRes.json() : {};
    renderProfile(main, profile, studies, practice);
    bindAnonymousToggle();
    bindDeleteAccount(profile.username);
  } catch {
    renderSignedOut(main);
  }
}

init();
