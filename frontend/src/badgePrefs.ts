// How the badges (scoreTiers.ts) look, chosen on the account page and
// remembered in this browser, for the website and the mobile app alike:
//   shine  vivid (animated, sparkles on the top tiers), subtle (the same
//          metals, still) or flat (one plain colour per tier)
//   icons  the chess symbols, or the Lichess piece set of the board theme
// Applied as <html data-badge-shine data-badge-icons>; badgePrefs.css does
// the rest.

import "./badgePrefs.css";

export type BadgeShine = "vivid" | "subtle" | "flat";
export type BadgeIcons = "symbols" | "lichess";

export const SHINES: { value: BadgeShine; label: string; title: string }[] = [
  { value: "vivid", label: "Vivid", title: "Metals that shine, with sparkles on the top tiers" },
  { value: "subtle", label: "Subtle", title: "The same metals, still" },
  { value: "flat", label: "Flat", title: "One plain colour per tier" },
];
export const ICONS: { value: BadgeIcons; label: string; title: string }[] = [
  { value: "symbols", label: "Chess symbols", title: "♚ ♛ ♜ ♝ ♞ ♟" },
  { value: "lichess", label: "Your Lichess pieces", title: "The piece set of your Lichess board" },
];

const SHINE_KEY = "lirep-badge-shine";
const ICONS_KEY = "lirep-badge-icons";
// The board theme kept by board.ts (applyBoardTheme), for its piece set.
const BOARD_THEME_KEY = "lirep-board-theme";
const PIECE_LETTERS = { king: "K", queen: "Q", rook: "R", bishop: "B", knight: "N", pawn: "P" };

function read<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return values.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function badgeShine(): BadgeShine {
  return read(SHINE_KEY, SHINES.map((s) => s.value), "vivid");
}

export function badgeIcons(): BadgeIcons {
  return read(ICONS_KEY, ICONS.map((i) => i.value), "symbols");
}

function pieceSet(): string {
  try {
    const kept = JSON.parse(localStorage.getItem(BOARD_THEME_KEY) ?? "null");
    if (typeof kept?.pieceSet === "string" && /^[\w-]+$/.test(kept.pieceSet)) return kept.pieceSet;
  } catch {
    // Not kept yet: Lichess's default set.
  }
  return "cburnett";
}

export function applyBadgePrefs(): void {
  const root = document.documentElement;
  root.dataset.badgeShine = badgeShine();
  root.dataset.badgeIcons = badgeIcons();
  if (badgeIcons() !== "lichess") return;
  // Each piece, from the set's white pieces: its shape cuts the badge's
  // colours, and its own lines are drawn over them.
  let style = document.getElementById("badge-pieces") as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = "badge-pieces";
    document.head.append(style);
  }
  const set = pieceSet();
  style.textContent = Object.entries(PIECE_LETTERS)
    .map(([piece, letter]) => `.piece-badge--p-${piece} { --badge-mask: url("https://lichess1.org/assets/piece/${set}/w${letter}.svg"); }`)
    .join("\n");
}

export function setBadgePrefs(prefs: { shine?: BadgeShine; icons?: BadgeIcons }): void {
  try {
    if (prefs.shine) localStorage.setItem(SHINE_KEY, prefs.shine);
    if (prefs.icons) localStorage.setItem(ICONS_KEY, prefs.icons);
  } catch {
    // Blocked storage: the choice lasts for this page.
    if (prefs.shine) document.documentElement.dataset.badgeShine = prefs.shine;
    if (prefs.icons) document.documentElement.dataset.badgeIcons = prefs.icons;
    return;
  }
  applyBadgePrefs();
}

applyBadgePrefs();
