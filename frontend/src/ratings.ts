// A player's Lichess ratings, as cards: on your profile and on a player's
// public one.

export interface RatingInfo {
  rating: number;
  /** null on a public profile under a pen name. */
  games: number | null;
  provisional: boolean;
  /** Under a pen name: rounded down to the hundred, so it can't identify. */
  roundedDown?: boolean;
}

export type Speed = "bullet" | "blitz" | "rapid" | "classical";
export type Ratings = Partial<Record<Speed, RatingInfo>>;

// Glyph codes from lichess.org's own icon font (see style.css), read off a
// live Lichess profile page's data-icon attributes for these perf types.
const SPEEDS: { key: Speed; label: string; icon: string }[] = [
  { key: "bullet", label: "Bullet", icon: "" },
  { key: "blitz", label: "Blitz", icon: "" },
  { key: "rapid", label: "Rapid", icon: "" },
  { key: "classical", label: "Classical", icon: "" },
];

/** How many speeds have rated games. */
export function ratedCount(ratings: Ratings): number {
  return SPEEDS.filter(({ key }) => ratings[key]).length;
}

export function ratingGridHtml(ratings: Ratings): string {
  const cards = SPEEDS.map(({ key, label, icon }) => {
    const info = ratings[key];
    const value = info ? `${info.rating}${info.roundedDown ? "+" : ""}` : "Unrated";
    const detail = !info
      ? "No rated games yet"
      : [
          info.games === null ? "" : `${info.games} games`,
          info.roundedDown ? "rounded down" : "",
          info.provisional ? "provisional" : "",
        ].filter(Boolean).join(" · ");
    return `
      <div class="rating-card">
        <div class="rating-card__icon" data-icon="${icon}"></div>
        <div class="rating-card__label">${label}</div>
        <div class="rating-card__value">${value}</div>
        <div class="rating-card__detail">${detail}</div>
      </div>
    `;
  }).join("");
  return `<div class="rating-grid">${cards}</div>`;
}
