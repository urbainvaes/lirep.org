import { escapeHtml, fetchMe } from "./layout";

/** What the Lirep (local) Explorer contains: Lichess's own public game
 * database (CC0), but only these months. Shown wherever Lirep is named so it
 * is clear the games come from Lichess. */
export const LIREP_DATASET = "Lichess games, Feb–Apr 2016";

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
  /** How the expected score values a line where the preparation ends, on
   * the Stats page and in the editor's figures. Missing on settings saved
   * before it existed: "explorer". */
  leafValue?: LeafValue;
  /** Stockfish's depth for the study's calculations (8, 12 or 16), on the
   * Stats page and in the editor. Missing on settings saved before it
   * existed: the browser's default then (see studyDepth). */
  depth?: number | null;
}

export const DEFAULT_EXPLORER_SETTINGS: ExplorerSettings = {
  enabled: true,
  source: "lichess",
  database: "lichess",
  player: null,
  minRating: null,
  speeds: ["blitz", "rapid", "classical"],
};

/** How the expected score values a line where the preparation ends: with
 * the Explorer's results, with Stockfish's evaluation turned into an
 * expected score, or with the Explorer's results unless they count fewer
 * than MIN_LEAF_GAMES games, then Stockfish's. See doc/expected-score.html. */
export type LeafValue = "explorer" | "stockfish" | "explorer-stockfish";

export const MIN_LEAF_GAMES = 100;
// What it was before: Hybrid scores saved without their threshold used it.
export const LEGACY_LEAF_GAMES = 50;

// The third value is "Hybrid" everywhere; doc/expected-score.html says how
// it works.
export const LEAF_VALUE_LABELS: Record<LeafValue, string> = {
  explorer: "Explorer results",
  stockfish: "Stockfish",
  "explorer-stockfish": "Hybrid",
};

/** What each does, in a few words: the editor's settings' titles. */
export const LEAF_VALUE_DESCRIPTIONS: Record<LeafValue, string> = {
  explorer: "The Explorer's results",
  stockfish: "Stockfish's evaluation, as an expected score",
  "explorer-stockfish": `The Explorer's results, or Stockfish's evaluation under ${MIN_LEAF_GAMES} games`,
};

/** One word each, for the editor's settings, with the description above as
 * their title. */
export const LEAF_VALUE_SHORT_LABELS: Record<LeafValue, string> = {
  explorer: "Explorer",
  stockfish: "Stockfish",
  "explorer-stockfish": "Hybrid",
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

/** What the Explorer settings' controls offer: whether the Lirep Explorer
 * exists here, the rating buckets, and the time controls. */
export interface ExplorerFormChoices {
  lirepAvailable: boolean;
  ratingBuckets: number[];
  defaultMinRating: number;
  speeds: ExplorerSpeed[];
}

/** The Explorer settings' controls, the same on the Stats page and in the
 * editor: source, database, minimum rating or player, time controls. Wire
 * them with bindExplorerSettingsForm. */
export function explorerSettingsFormHtml(settings: ExplorerSettings, choices: ExplorerFormChoices): string {
  const selected = (on: boolean) => (on ? " selected" : "");
  return `
    <div class="explorer-settings-panel">
      <div class="analysis-header__settings">
        <select data-setting="source" aria-label="Explorer data source">
          <option value="lirep"${selected(settings.source === "lirep")}${choices.lirepAvailable ? "" : " disabled"}>Lirep</option>
          <option value="lichess"${selected(settings.source === "lichess")}>Lichess</option>
        </select>
        <select data-setting="database" aria-label="Lichess database">
          <option value="lichess"${selected(settings.database === "lichess")}>Players</option>
          <option value="masters"${selected(settings.database === "masters")}>Masters</option>
          <option value="player"${selected(settings.database === "player")}>Player</option>
        </select>
        <select data-setting="min-rating" aria-label="Minimum rating">
          ${ratingOptionsHtml(choices.ratingBuckets, settings.minRating, choices.defaultMinRating)}
        </select>
        <input data-setting="player" class="explorer-player" type="text" placeholder="Lichess username"
          aria-label="Player whose games to use" value="${escapeHtml(settings.player ?? "")}" />
      </div>
      <div class="speed-checkboxes" data-setting="speeds">
        ${speedCheckboxesHtml(choices.speeds, settings.speeds, settings.database === "masters")}
      </div>
    </div>
  `;
}

/** Wires the controls of explorerSettingsFormHtml inside `root`: keeps
 * `settings` up to date as they change, enables only the controls that
 * apply (one player's games exist only on Lichess, Masters has no ratings
 * or time controls…), keeps a time control selected, and fills in the
 * signed-in player's name for the Player database. `onChange` follows each
 * change (a player's name: once it's entered). */
export function bindExplorerSettingsForm(
  root: HTMLElement,
  settings: ExplorerSettings,
  lirepAvailable: boolean,
  onChange: () => void,
): void {
  const control = <T extends HTMLElement>(name: string) => root.querySelector<T>(`[data-setting="${name}"]`)!;
  const sourceEl = control<HTMLSelectElement>("source");
  const databaseEl = control<HTMLSelectElement>("database");
  const minRatingEl = control<HTMLSelectElement>("min-rating");
  const playerEl = control<HTMLInputElement>("player");
  const speedsEl = control<HTMLElement>("speeds");

  function update(): void {
    const playerSelected = settings.database === "player";
    sourceEl.querySelector<HTMLOptionElement>('option[value="lirep"]')!.disabled = playerSelected || !lirepAvailable;
    databaseEl.disabled = settings.source === "lirep" && !playerSelected;
    databaseEl.querySelector<HTMLOptionElement>('option[value="masters"]')!.disabled = settings.source === "lirep";
    minRatingEl.disabled = settings.database !== "lichess";
    playerEl.hidden = !playerSelected;
    speedsEl.querySelectorAll<HTMLInputElement>("input").forEach((cb) => {
      cb.disabled = settings.database === "masters";
    });
  }
  update();

  sourceEl.addEventListener("change", () => {
    settings.source = sourceEl.value as ExplorerSettings["source"];
    if (settings.source === "lirep" && settings.database === "masters") {
      settings.database = "lichess";
      databaseEl.value = "lichess";
    }
    update();
    onChange();
  });

  databaseEl.addEventListener("change", () => {
    settings.database = databaseEl.value as ExplorerSettings["database"];
    if (settings.database === "player") {
      // One player's games exist only on Lichess; default to the signed-in user.
      settings.source = "lichess";
      sourceEl.value = "lichess";
      if (!settings.player) {
        void fetchMe().then((me) => {
          if (me.username && !settings.player && settings.database === "player") {
            settings.player = me.username;
            playerEl.value = me.username;
            onChange();
          }
        });
      }
    }
    update();
    onChange();
  });

  playerEl.addEventListener("input", () => {
    settings.player = playerEl.value.trim() || null;
  });
  playerEl.addEventListener("change", onChange);

  minRatingEl.addEventListener("change", () => {
    settings.minRating = Number(minRatingEl.value);
    onChange();
  });

  speedsEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.type !== "checkbox") return;
    const speed = target.value as ExplorerSpeed;
    if (!target.checked && settings.speeds.length === 1 && settings.speeds[0] === speed) {
      target.checked = true; // always keep at least one speed selected
      return;
    }
    settings.speeds = target.checked ? [...settings.speeds, speed] : settings.speeds.filter((s) => s !== speed);
    onChange();
  });
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
// doc/explorer-cache.md) rather than fetched fresh every time, so it's worth
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
 * the moves in the tree from here, and whether it's the studied side's turn.
 * In a viewer, the ✓ on the tree's moves says what they are (`markLabel`,
 * "In your study" by default). */
export interface RepertoireView {
  inTree: Set<string>;
  yourTurn: boolean;
  markLabel?: string;
}

// The move list shows this many rows; the rest scroll inside it.
const VISIBLE_EXPLORER_ROWS = 6;

export function renderExplorer(
  panel: HTMLElement,
  data: ExplorerData,
  onPlay: (san: string) => void,
  repertoire?: RepertoireView,
  // The settings' own summary, in place of what the data says it is.
  summary?: string,
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
      const markLabel = repertoire?.markLabel ?? "In your study";
      const label = prepared ? markLabel : gap ? "Not prepared" : "";
      const whitePct = (move.white / games) * 100;
      const drawsPct = (move.draws / games) * 100;
      const blackPct = (move.black / games) * 100;
      return `
        <button class="explorer-row${rowClass}" type="button" data-san="${escapeHtml(move.san)}"${label ? ` title="${label}"` : ""}>
          <span class="explorer-row__san">${prepared ? `<span class="explorer-row__mark" aria-label="${escapeHtml(markLabel)}">✓</span>` : ""}${escapeHtml(move.san)}</span>
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
      <span class="explorer-source">${summary ? escapeHtml(summary) : source}</span>
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
