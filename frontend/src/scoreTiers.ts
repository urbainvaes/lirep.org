// The expected score's tiers, shown as a coloured chess king: on a study's
// Stats page (with their legend) and on its card on the home page.

// Gamification tiers for the expected score, by side: White scores about
// 52% on average in the Explorer's pools, Black about 48%, so Bronze is the
// colour's average and Black's thresholds are BLACK_TIER_OFFSET points
// lower. Shown as a colored chess piece (see .piece-badge), not a medal.
export type ScoreTier = "legendary" | "brilliant" | "gold" | "silver" | "bronze" | "none";

export const TIERS: { tier: Exclude<ScoreTier, "none">; label: string; white: number }[] = [
  { tier: "legendary", label: "Legendary", white: 60 },
  { tier: "brilliant", label: "Brilliant", white: 59 },
  { tier: "gold", label: "Gold", white: 57 },
  { tier: "silver", label: "Silver", white: 54 },
  { tier: "bronze", label: "Bronze", white: 52 },
];
export const BLACK_TIER_OFFSET = 4;

export const TIER_LABELS: Record<ScoreTier, string> = {
  ...(Object.fromEntries(TIERS.map((t) => [t.tier, t.label])) as Record<Exclude<ScoreTier, "none">, string>),
  none: "No tier",
};

// The lowest expected score, in percent, for a tier on `side`.
export const tierThreshold = (white: number, side: "white" | "black") => white - (side === "black" ? BLACK_TIER_OFFSET : 0);

export function scoreTier(expectedScore: number | undefined, side: "white" | "black"): ScoreTier {
  if (expectedScore === undefined) return "none";
  const pct = expectedScore * 100;
  return TIERS.find((t) => pct >= tierThreshold(t.white, side))?.tier ?? "none";
}

export function pieceBadgeHtml(tier: ScoreTier, size: "" | "sm" = ""): string {
  const sizeClass = size ? ` piece-badge--${size}` : "";
  return `<span class="piece-badge piece-badge--${tier}${sizeClass}">♚</span>`;
}
