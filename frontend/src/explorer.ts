import { escapeHtml } from "./layout";

/** What the Lirep (local) Explorer contains: Lichess's own public game
 * database (CC0), but only these months. Shown wherever Lirep is named so it
 * is clear the games come from Lichess. */
export const LIREP_DATASET = "Lichess games, Feb–Mar 2016";

export type ExplorerSpeed = "bullet" | "blitz" | "rapid" | "classical";

export interface ExplorerSettings {
  enabled: boolean;
  source: "lirep" | "lichess";
  database: "lichess" | "masters" | "player";
  /** Only for database "player": whose games to show (as the study's side). */
  player?: string | null;
  /** A fixed rating bucket, chosen once (defaulting to the signed-in
   * player's own bracket, from ExplorerDefaults.defaultMinRating) rather
   * than re-resolved on every request. Only ever null for a study saved
   * before this existed — see ratingOptionsHtml, which treats that the
   * same as the default bucket. */
  minRating: number | null;
  speeds: ExplorerSpeed[];
}

export const DEFAULT_EXPLORER_SETTINGS: ExplorerSettings = {
  enabled: true,
  source: "lichess",
  database: "lichess",
  player: null,
  minRating: null,
  speeds: ["blitz", "rapid", "classical"],
};

export interface ExplorerDefaults {
  ratingBuckets: number[];
  defaultMinRating: number;
  speeds: ExplorerSpeed[];
  defaultSpeeds: ExplorerSpeed[];
  defaultSource: ExplorerSettings["source"];
  lirepAvailable: boolean;
}

export interface ExplorerMove {
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating: number | null;
}

export interface ExplorerData {
  source: ExplorerSettings["source"];
  database: "lichess" | "masters" | "player";
  player?: string | null;
  color?: "white" | "black" | null;
  minRating: number | null;
  opening: string | null;
  totals: { white: number; draws: number; black: number };
  moves: ExplorerMove[];
  fetchedAt: string;
}

/** `selected` is only ever null for a study saved back when "my current
 * rating" was a standing auto-resolved mode rather than a one-time default —
 * treated here as "whatever the current default bucket is" so the picker
 * still shows a sensible selection instead of nothing. */
export function ratingOptionsHtml(buckets: number[], selected: number | null, defaultBucket: number): string {
  const effectiveSelected = selected ?? defaultBucket;
  return buckets
    .map((bucket) => {
      const label = bucket === 0 ? "Any rating" : `${bucket}+`;
      return `<option value="${bucket}"${effectiveSelected === bucket ? " selected" : ""}>${label}</option>`;
    })
    .join("");
}

export const SPEED_LABELS: Record<ExplorerSpeed, string> = {
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  classical: "Classical",
};

export function speedCheckboxesHtml(allSpeeds: ExplorerSpeed[], selected: ExplorerSpeed[], disabled: boolean): string {
  return allSpeeds
    .map(
      (speed) => `
        <label class="speed-checkbox">
          <input type="checkbox" value="${speed}" ${selected.includes(speed) ? "checked" : ""} ${disabled ? "disabled" : ""} />
          ${SPEED_LABELS[speed]}
        </label>
      `,
    )
    .join("");
}

export async function fetchExplorerDefaults(): Promise<ExplorerDefaults | null> {
  try {
    const res = await fetch("/api/explorer-defaults", { credentials: "same-origin" });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export function explorerUrl(fen: string, settings: ExplorerSettings, side: "white" | "black"): string {
  const params = new URLSearchParams({ fen, source: settings.source, database: settings.database });
  if (settings.database === "lichess") {
    if (settings.minRating !== null) params.set("minRating", String(settings.minRating));
    params.set("speeds", settings.speeds.join(","));
  } else if (settings.database === "player") {
    // One player's games as the side this study is played from.
    params.set("speeds", settings.speeds.join(","));
    params.set("player", settings.player ?? "");
    params.set("color", side);
  }
  return `/api/explorer?${params.toString()}`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// This data is served from a persistent, cross-study cache (see
// explorer-cache.md) rather than fetched fresh every time, so it's worth
// showing how stale it might be rather than implying it's always live.
function formatFetchedAt(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function renderExplorerLoading(panel: HTMLElement): void {
  panel.innerHTML = `<p class="explorer-empty">Loading opening explorer data…</p>`;
}

export function renderExplorerError(panel: HTMLElement): void {
  panel.innerHTML = `<p class="explorer-empty">Explorer data unavailable right now.</p>`;
}

export function renderExplorer(panel: HTMLElement, data: ExplorerData, onPlay: (san: string) => void): void {
  if (data.moves.length === 0) {
    panel.innerHTML = `<p class="explorer-empty">No games found here yet.</p>`;
    return;
  }

  const rows = data.moves
    .map((move) => {
      const games = move.white + move.draws + move.black;
      const whitePct = (move.white / games) * 100;
      const drawsPct = (move.draws / games) * 100;
      const blackPct = (move.black / games) * 100;
      return `
        <button class="explorer-row" type="button" data-san="${escapeHtml(move.san)}">
          <span class="explorer-row__san">${escapeHtml(move.san)}</span>
          <span class="explorer-row__bar-wrap">
            <span class="explorer-row__bar">
              <span class="explorer-row__white" style="width:${whitePct}%"></span>
              <span class="explorer-row__draws" style="width:${drawsPct}%"></span>
              <span class="explorer-row__black" style="width:${blackPct}%"></span>
            </span>
            <span class="explorer-row__pct">
              <span class="explorer-row__pct-white">${whitePct.toFixed(0)}%</span>
              <span class="explorer-row__pct-draws">${drawsPct.toFixed(0)}%</span>
              <span class="explorer-row__pct-black">${blackPct.toFixed(0)}%</span>
            </span>
          </span>
          <span class="explorer-row__games">${formatCount(games)}</span>
        </button>
      `;
    })
    .join("");

  const source = data.source === "lirep"
    ? `Lirep · ${LIREP_DATASET}`
    : data.database === "masters"
      ? "Lichess Masters"
      : data.database === "player"
        ? `${escapeHtml(data.player ?? "?")}'s games as ${data.color ?? "?"}`
        : `Lichess Players rated ${data.minRating ?? "?"}+`;
  const fetchedAtDate = new Date(data.fetchedAt);

  panel.innerHTML = `
    <div class="explorer-header">
      <span>${source}</span>
      ${data.opening ? `<span class="explorer-opening">${escapeHtml(data.opening)}</span>` : ""}
      <span class="explorer-fetched-at" title="Fetched ${fetchedAtDate.toLocaleString()}">Fetched ${formatFetchedAt(data.fetchedAt)}</span>
    </div>
    <div class="explorer-rows">${rows}</div>
  `;

  panel.querySelectorAll<HTMLButtonElement>("[data-san]").forEach((btn) => {
    btn.addEventListener("click", () => onPlay(btn.dataset.san as string));
  });
}
