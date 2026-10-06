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

// One line describing Explorer settings, e.g. "Lichess · 1600+ · blitz, rapid".
// The Lirep source names its dataset, since its games are few and old.
export function explorerSummary(settings: {
  source?: ExplorerSettings["source"];
  database: ExplorerSettings["database"];
  minRating: number | null;
  speeds?: ExplorerSpeed[];
  player?: string | null;
}): string {
  const parts: string[] = [];
  if (settings.database === "player") {
    parts.push("Lichess", `games of ${settings.player ?? "?"}`);
  } else {
    parts.push(settings.source === "lirep" ? `Lirep (${LIREP_DATASET})` : "Lichess");
    parts.push(settings.database === "masters" ? "Masters" : `${settings.minRating ?? "?"}+`);
  }
  if (settings.database !== "masters" && settings.speeds?.length) parts.push(settings.speeds.join(", "));
  return parts.join(" · ");
}

export async function fetchExplorerDefaults(): Promise<ExplorerDefaults | null> {
  try {
    const res = await fetch("/api/explorer-defaults", { credentials: "same-origin" });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

/** The backend's Explorer endpoint, which serves only the local Lirep
 * Explorer (the 2016 sample, Players database); Lichess's Explorer is queried
 * from the browser by explorerClient.ts. */
export function lirepExplorerUrl(fen: string, settings: ExplorerSettings): string {
  const params = new URLSearchParams({ fen, speeds: settings.speeds.join(",") });
  if (settings.minRating !== null) params.set("minRating", String(settings.minRating));
  return `/api/explorer?${params.toString()}`;
}

// A move's share of the games in this position.
function formatShare(share: number): string {
  return share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
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

export function renderExplorerError(panel: HTMLElement, message = "Explorer data unavailable right now."): void {
  panel.innerHTML = `<p class="explorer-empty">${escapeHtml(message)}</p>`;
}

// Opponent replies played in at least this share of games are flagged when
// the study has no answer to them.
export const UNPREPARED_THRESHOLD = 0.05;

/** What the study already has at this position, for the editor's Explorer:
 * the moves in the tree from here, and whether it's the studied side's turn. */
export interface RepertoireView {
  inTree: Set<string>;
  yourTurn: boolean;
}

// The move list shows this many rows; the rest scroll inside it.
const VISIBLE_EXPLORER_ROWS = 6;

export function renderExplorer(
  panel: HTMLElement,
  data: ExplorerData,
  onPlay: (san: string) => void,
  repertoire?: RepertoireView,
): void {
  if (data.moves.length === 0) {
    panel.innerHTML = `<p class="explorer-empty">No games found here yet.</p>`;
    return;
  }

  const total = data.moves.reduce((sum, m) => sum + m.white + m.draws + m.black, 0);
  const rows = data.moves
    .map((move) => {
      const games = move.white + move.draws + move.black;
      const prepared = repertoire?.inTree.has(move.san) ?? false;
      const gap = repertoire !== undefined && !repertoire.yourTurn && !prepared && games / total >= UNPREPARED_THRESHOLD;
      const rowClass = prepared ? " explorer-row--prepared" : gap ? " explorer-row--gap" : "";
      const label = prepared ? "In your study" : gap ? "Not prepared" : "";
      const whitePct = (move.white / games) * 100;
      const drawsPct = (move.draws / games) * 100;
      const blackPct = (move.black / games) * 100;
      return `
        <button class="explorer-row${rowClass}" type="button" data-san="${escapeHtml(move.san)}"${label ? ` title="${label}"` : ""}>
          <span class="explorer-row__san">${prepared ? `<span class="explorer-row__mark" aria-label="In your study">✓</span>` : ""}${escapeHtml(move.san)}</span>
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
          <span class="explorer-row__games">${formatCount(games)}<span class="explorer-row__share">${formatShare(games / total)}</span></span>
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
      <span class="explorer-source">${source}</span>
      ${data.opening ? `<span class="explorer-opening">${escapeHtml(data.opening)}</span>` : ""}
      <span class="explorer-fetched-at" title="Fetched ${fetchedAtDate.toLocaleString()}">Fetched ${formatFetchedAt(data.fetchedAt)}</span>
    </div>
    <div class="explorer-rows">${rows}</div>
  `;

  panel.querySelectorAll<HTMLButtonElement>("[data-san]").forEach((btn) => {
    btn.addEventListener("click", () => onPlay(btn.dataset.san as string));
  });

  // Measured rather than fixed in CSS, so it holds whatever the fonts.
  const list = panel.querySelector<HTMLElement>(".explorer-rows");
  const items = list?.children;
  if (list && items && items.length > VISIBLE_EXPLORER_ROWS) {
    const top = items[0].getBoundingClientRect().top;
    const bottom = items[VISIBLE_EXPLORER_ROWS - 1].getBoundingClientRect().bottom;
    if (bottom > top) {
      list.style.maxHeight = `${Math.ceil(bottom - top)}px`;
      list.classList.add("explorer-rows--scroll");
    }
  }
}
