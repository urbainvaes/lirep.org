import { escapeHtml } from "./layout";

export type ExplorerSpeed = "bullet" | "blitz" | "rapid" | "classical";

export interface ExplorerSettings {
  enabled: boolean;
  database: "lichess" | "masters";
  /** null = always use the signed-in player's current rating; a number pins a specific bucket. */
  minRating: number | null;
  speeds: ExplorerSpeed[];
}

export const DEFAULT_EXPLORER_SETTINGS: ExplorerSettings = {
  enabled: true,
  database: "lichess",
  minRating: null,
  speeds: ["blitz", "rapid", "classical"],
};

export interface ExplorerDefaults {
  ratingBuckets: number[];
  defaultMinRating: number;
  speeds: ExplorerSpeed[];
  defaultSpeeds: ExplorerSpeed[];
}

export interface ExplorerMove {
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating: number | null;
}

export interface ExplorerData {
  database: "lichess" | "masters";
  minRating: number | null;
  opening: string | null;
  totals: { white: number; draws: number; black: number };
  moves: ExplorerMove[];
}

export async function fetchExplorerDefaults(): Promise<ExplorerDefaults | null> {
  try {
    const res = await fetch("/api/explorer-defaults", { credentials: "same-origin" });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export function explorerUrl(fen: string, settings: ExplorerSettings): string {
  const params = new URLSearchParams({ fen, database: settings.database });
  if (settings.database === "lichess") {
    if (settings.minRating !== null) params.set("minRating", String(settings.minRating));
    params.set("speeds", settings.speeds.join(","));
  }
  return `/api/explorer?${params.toString()}`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

  const source = data.database === "masters" ? "Masters" : `Players rated ${data.minRating ?? "?"}+`;

  panel.innerHTML = `
    <div class="explorer-header">
      <span>${source}</span>
      ${data.opening ? `<span class="explorer-opening">${escapeHtml(data.opening)}</span>` : ""}
    </div>
    <div class="explorer-rows">${rows}</div>
  `;

  panel.querySelectorAll<HTMLButtonElement>("[data-san]").forEach((btn) => {
    btn.addEventListener("click", () => onPlay(btn.dataset.san as string));
  });
}
