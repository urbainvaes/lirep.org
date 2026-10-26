// The two list screens, under a tab bar: the studies (as on the website's
// home page) and practice (as on its Practice page). Each row opens a
// study's moves in Studies (its stats from the icon at the end), or a
// practice session and Bullet in Practice.

import { escapeHtml } from "@web/layout";
import { evalPiece, formatExpectedEval, pieceBadgeHtml, scoreTier } from "@web/scoreTiers";

import { leaderboard, practiceSummary, studies, type PracticeSummary, type Ranked, type Study } from "./api";

type Tab = "studies" | "practice" | "community";

const STUDIES_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`;
const COMMUNITY_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const PRACTICE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`;

export function shell(tab: Tab, title: string, aside: string, body: string, back?: string): string {
  const link = (to: Tab, href: string, icon: string, label: string) =>
    `<a class="tabs__tab${tab === to ? " tabs__tab--on" : ""}" href="${href}" aria-label="${label}"${tab === to ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  return `
    <header class="bar">
      ${back ? `<a class="bar__back" href="${back}" aria-label="Back to Studies">‹</a>` : '<span class="bar__logo" aria-hidden="true"></span>'}
      <h1 class="bar__title">${title}</h1>
      <span class="bar__aside">${aside}</span>
    </header>
    <main class="list">${body}</main>
    <nav class="tabs" aria-label="Screens">
      ${link("studies", "#/", STUDIES_ICON, "Studies")}
      ${link("practice", "#/practice", PRACTICE_ICON, "Practice")}
      ${link("community", "#/community", COMMUNITY_ICON, "Community")}
    </nav>
  `;
}

const bulletLink = (study: Study) =>
  `<a class="row__action" href="#/bullet/${study.id}" aria-label="Bullet on ${escapeHtml(study.name)}" title="Bullet"><span data-icon="&#xe032;" aria-hidden="true"></span></a>`;

const statsLink = (study: Study) =>
  `<a class="row__action" href="#/stats/${study.id}" aria-label="Stats for ${escapeHtml(study.name)}" title="Stats"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3v17h17M9 15v-4M14 15V7M19 15V4"/></svg></a>`;

function row(study: Study, lead: string, sub: string, destination: "study" | "practice"): string {
  return `
    <li class="row">
      <a class="row__link" href="#/${destination}/${study.id}">
        <span class="row__lead">${lead}</span>
        <span class="row__text">
          <span class="row__name">${escapeHtml(study.name)}</span>
          <span class="row__sub">${sub}</span>
        </span>
      </a>
      ${destination === "study" ? statsLink(study) : bulletLink(study)}
    </li>
  `;
}

function grouped(list: Study[], rowOf: (study: Study) => string): string {
  return (["white", "black"] as const)
    .map((side) => {
      const rows = list.filter((study) => study.side === side);
      if (!rows.length) return "";
      return `<section class="group"><h2 class="group__title"><span class="side-dot side-dot--${side}" aria-hidden="true"></span>${side === "white" ? "White" : "Black"}</h2><ul class="rows">${rows.map(rowOf).join("")}</ul></section>`;
    })
    .join("");
}

const empty = (text: string) => `<p class="list__empty">${text}<br><a href="/">lirep.org</a></p>`;

/** The studies: badge, name, expected score and evaluation. */
export async function renderStudies(app: HTMLElement): Promise<void> {
  const list = await studies();
  const studyRow = (study: Study) => {
    const score = study.stats?.winProbability;
    const evalCp = study.stats?.evalCp;
    const badge = pieceBadgeHtml(scoreTier(score, study.side), "", evalPiece(evalCp));
    const result = study.broken
      ? "Damaged: its moves can't be read"
      : [
          score === undefined ? "—" : `${(score * 100).toFixed(1)}%`,
          evalCp === undefined ? "—" : formatExpectedEval(evalCp, study.side),
        ].join(" · ");
    return row(study, badge, result, "study");
  };
  app.innerHTML = shell("studies", "Studies", "", list.length ? grouped(list, studyRow) : empty("No studies yet: create one on"));
}

function knowledgeRing(knowledge: number | null): string {
  const pct = knowledge === null ? 0 : Math.round(knowledge * 100);
  return `<span class="ring" style="--pct:${pct}" aria-label="${pct}% known">${pct}</span>`;
}

/** Practice: what's due in all, then each study's knowledge and dues, in
 * the Studies tab's order. */
export async function renderPracticeList(app: HTMLElement): Promise<void> {
  const [list, summaries] = await Promise.all([studies(), practiceSummary()]);
  const summary = (study: Study): PracticeSummary | undefined => summaries[String(study.id)];
  const due = (study: Study) => summary(study)?.dueCount ?? 0;
  const totalDue = list.reduce((n, study) => n + due(study), 0);
  const practiceRow = (study: Study) => {
    const s = summary(study);
    const parts = [
      s?.dueCount ? `<b class="due">${s.dueCount} due</b>` : "",
      s?.newCount ? `${s.newCount} new` : "",
      s?.bullet?.runs ? `<span data-icon="&#xe032;" aria-hidden="true"></span> ${s.bullet.successes}/${s.bullet.runs}` : "",
    ].filter(Boolean);
    return row(study, knowledgeRing(s?.aggregateKnowledge ?? null), parts.join(" · ") || "Up to date", "practice");
  };
  app.innerHTML = shell(
    "practice",
    "Practice",
    totalDue ? `<b class="due">${totalDue} due</b>` : "",
    list.length ? grouped(list, practiceRow) : empty("No studies yet: create one on"),
  );
}

/** The leaderboards, by expected score or evaluation (two chips switch),
 * White's then Black's: rank, badge, name, value and author. A row opens
 * the study on the website's read-only page. */
export async function renderCommunity(app: HTMLElement, by: "score" | "eval"): Promise<void> {
  const rows = await leaderboard(by);
  const rowOf = (r: Ranked) => {
    const stats = r.badge ?? { winProbability: r.winProbability ?? undefined, evalCp: r.evalCp ?? undefined };
    const badge = pieceBadgeHtml(scoreTier(stats.winProbability ?? undefined, r.side), "sm", evalPiece(stats.evalCp ?? undefined));
    const value = by === "score"
      ? r.winProbability == null ? "—" : `${(r.winProbability * 100).toFixed(1)}%`
      : r.evalCp == null ? "—" : formatExpectedEval(r.evalCp, r.side);
    return `
      <li class="row">
        <a class="row__link" href="/opening.html?id=${r.id}">
          <span class="row__rank">${r.rank ?? "–"}</span>
          <span class="row__lead row__lead--small">${badge}</span>
          <span class="row__text">
            <span class="row__name">${escapeHtml(r.name)}</span>
            <span class="row__sub"><b class="row__value">${value}</b>${r.owner ? ` · ${escapeHtml(r.owner)}` : ""}</span>
          </span>
        </a>
      </li>
    `;
  };
  const sides = (["white", "black"] as const)
    .map((side) => {
      const list = rows.filter((r) => r.side === side);
      if (!list.length) return "";
      return `<section class="group"><h2 class="group__title"><span class="side-dot side-dot--${side}" aria-hidden="true"></span>${side === "white" ? "White" : "Black"}</h2><ul class="rows">${list.map(rowOf).join("")}</ul></section>`;
    })
    .join("");
  const chip = (to: "score" | "eval", label: string) =>
    `<a class="chip${by === to ? " chip--on" : ""}" href="${to === "score" ? "#/community" : "#/community/eval"}"${by === to ? ' aria-current="page"' : ""}>${label}</a>`;
  app.innerHTML = shell(
    "community",
    "Community",
    "",
    `<div class="list__chips">${chip("score", "Score")}${chip("eval", "Evaluation")}</div>${sides || `<p class="list__empty">No ranked studies yet.</p>`}`,
  );
}
