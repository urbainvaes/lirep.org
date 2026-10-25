// Saved results only: calculations and editing remain on the website.
import { escapeHtml } from "@web/layout";
import { evalPiece, formatExpectedEval, PIECE_LABELS, pieceBadgeHtml, scoreTier, TIER_LABELS } from "@web/scoreTiers";

import { study as loadStudy, type CalculationSettings, type Study } from "./api";
import { shell } from "./lists";

function freshness(study: Study, fingerprint: string | undefined): string {
  if (!fingerprint || !study.movesFingerprint) return "Freshness unknown — recalculate on the website.";
  return fingerprint === study.movesFingerprint ? "" : "Out of date — moves or starting point changed.";
}

type Detail = [string, string | number | null | undefined];

function settingsDetails(settings: CalculationSettings | null | undefined): Detail[] {
  if (!settings) return [];
  return [
    ["Explorer", settings.source === "lirep" ? "Lirep (2016 sample)" : settings.source === "lichess" ? "Lichess" : undefined],
    ["Database", settings.database === "masters" ? "Masters" : settings.database === "player" ? "Player" : settings.database === "lichess" ? "Lichess" : undefined],
    ["Player", settings.database === "player" ? settings.player : undefined],
    ["Minimum rating", settings.minRating === null ? "Any rating" : settings.minRating],
    ["Time controls", settings.speeds?.join(", ")],
  ];
}

function calculationDetails(at: string | undefined, details: Detail[]): string {
  const date = at ? new Date(at) : null;
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null;
  const rows = details.filter(([, value]) => value !== undefined && value !== null && value !== "");
  return `<details class="stats__details">
    <summary>${validDate ? `Calculated <time datetime="${escapeHtml(at!)}">${escapeHtml(validDate.toLocaleDateString())}</time>` : "Calculation details"}</summary>
    ${validDate ? `<p class="stats__note">${escapeHtml(validDate.toLocaleString())}</p>` : ""}
    ${rows.length ? `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>` : '<p class="stats__note">Calculation settings not recorded.</p>'}
  </details>`;
}

function metric(title: string, value: string, explanation: string, warning: string, details: string): string {
  return `<section class="stats__card">
    <h3>${title}</h3>
    <p class="stats__value">${value}</p>
    <p class="stats__note">${explanation}</p>
    ${warning ? `<p class="stats__warning">${escapeHtml(warning)}</p>` : ""}
    ${details}
  </section>`;
}

export async function renderStats(app: HTMLElement, id: number, isCurrent = () => true): Promise<void> {
  const study = await loadStudy(id);
  if (!isCurrent()) return;
  const stats = study.stats;
  const score = stats?.winProbability;
  const cp = stats?.evalCp;
  const whiteCp = cp == null ? null : study.side === "white" ? cp : -cp;
  const advantage = whiteCp === null ? "" : whiteCp > 0 ? "White is better." : whiteCp < 0 ? "Black is better." : "Equal position.";
  const moves = Object.values(study.tree.nodes).filter((node) => node.id !== study.tree.rootId).length;
  const lines = Object.values(study.tree.nodes).filter((node) => node.id !== study.tree.rootId && !node.children.length).length;
  const tier = scoreTier(score ?? undefined, study.side);
  const piece = evalPiece(cp ?? undefined);
  const scoreDetails: Detail[] = [
    ...settingsDetails(stats),
    ["End of prep", stats?.leafValue === "stockfish" ? "Stockfish" : stats?.leafValue === "explorer-stockfish" ? "Hybrid" : score == null ? undefined : "Explorer"],
    ["Stockfish depth", stats?.scoreDepth],
    ["Positions checked", stats?.nodesEvaluated],
    ["Explorer calls", stats?.explorerCalls],
  ];
  const evalDetails: Detail[] = [
    ...settingsDetails(stats?.evalSettings),
    ["Stockfish depth", stats?.evalDepth],
    ["Method version", stats?.evalMethod],
    ["Missing evaluations", stats?.evalMisses],
  ];
  const scoreCard = metric(
    "Expected score", score == null ? "—" : `${(score * 100).toFixed(1)}%`,
    score == null ? "Not calculated yet." : "Wins plus half the draws, when you play your prepared moves.",
    score == null ? "" : freshness(study, stats?.winProbabilityMovesFingerprint),
    score == null ? "" : calculationDetails(stats?.winProbabilityCalculatedAt, scoreDetails),
  );
  const evalCard = metric(
    "Expected evaluation", cp == null ? "—" : formatExpectedEval(cp, study.side),
    cp == null ? "Not calculated yet." : `End of prep, from White’s perspective. ${advantage}`,
    cp == null ? "" : freshness(study, stats?.evalMovesFingerprint),
    cp == null ? "" : calculationDetails(stats?.evalCalculatedAt, evalDetails),
  );
  app.innerHTML = shell("studies", "Stats", "", `
    <div class="stats">
      <div class="stats__heading">
        <h2 class="stats__name">${escapeHtml(study.name)}</h2>
        <span class="stats__trophy" role="img" aria-label="${TIER_LABELS[tier]} ${PIECE_LABELS[piece]}" title="${TIER_LABELS[tier]} ${PIECE_LABELS[piece]}"><span aria-hidden="true">${pieceBadgeHtml(tier, "", piece)}</span></span>
      </div>
      <p class="stats__note">${study.side === "white" ? "White" : "Black"} repertoire · ${moves} ${moves === 1 ? "move" : "moves"} · ${lines} ${lines === 1 ? "line" : "lines"}</p>
      ${scoreCard}${evalCard}
      <a class="button button--primary" href="#/practice/${study.id}">Practice</a>
      <a class="button" href="#/study/${study.id}">Browse the moves</a>
      <a class="button" href="/stat.html?id=${study.id}">Full stats on website</a>
      <a class="button" href="/study.html?id=${study.id}">Edit on website</a>
      <p class="stats__note">Saved results are shown here. Calculate or refresh them on the website.</p>
    </div>
  `, "#/");
}
