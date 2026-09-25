import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

interface RatingInfo {
  rating: number;
  games: number;
  provisional: boolean;
}

interface ProfileResponse {
  username: string;
  title?: string | null;
  ratings: Partial<Record<"bullet" | "blitz" | "rapid" | "classical", RatingInfo>>;
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

function renderProfile(main: HTMLElement, profile: ProfileResponse): void {
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

  main.innerHTML = `
    <div class="profile-header">
      <h1>${titlePrefix}${escapeHtml(profile.username)}</h1>
      <p class="profile-subtitle">Ratings from Lichess</p>
    </div>

    <div class="rating-grid">${ratingCards}</div>

    <section class="profile-section">
      <h2>Chesster</h2>
      <div class="empty-state">
        <p>Your Chesster training progress will show up here.</p>
      </div>
    </section>
  `;
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
    const res = await fetch("/api/profile", { credentials: "same-origin" });
    if (!res.ok) {
      renderSignedOut(main);
      return;
    }
    const profile: ProfileResponse = await res.json();
    renderProfile(main, profile);
  } catch {
    renderSignedOut(main);
  }
}

init();
