// The two list screens, under a tab bar: the studies (as on the website's
// home page) and practice (as on its Practice page). Each row opens a
// practice session; the bullet at its end opens Bullet.

import { escapeHtml } from "@web/layout";
import { evalPiece, pieceBadgeHtml, scoreTier } from "@web/scoreTiers";

import { practiceSummary, studies, type PracticeSummary, type Study } from "./api";

type Tab = "studies" | "practice";

const STUDIES_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>`;
const PRACTICE_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`;

function shell(tab: Tab, title: string, aside: string, body: string): string {
  const link = (to: Tab, href: string, icon: string, label: string) =>
    `<a class="tabs__tab${tab === to ? " tabs__tab--on" : ""}" href="${href}" aria-label="${label}"${tab === to ? ' aria-current="page"' : ""}>${icon}<span>${label}</span></a>`;
  return `
    <header class="bar">
      <span class="bar__logo" aria-hidden="true"></span>
      <h1 class="bar__title">${title}</h1>
      <span class="bar__aside">${aside}</span>
    </header>
    <main class="list">${body}</main>
    <nav class="tabs" aria-label="Screens">
      ${link("studies", "#/", STUDIES_ICON, "Studies")}
      ${link("practice", "#/practice", PRACTICE_ICON, "Practice")}
    </nav>
  `;
}

const bulletLink = (study: Study) =>
  `<a class="row__bullet" href="#/bullet/${study.id}" aria-label="Bullet on ${escapeHtml(study.name)}" title="Bullet"><span data-icon="&#xe032;" aria-hidden="true"></span></a>`;

function row(study: Study, lead: string, sub: string): string {
  return `
    <li class="row">
      <a class="row__link" href="#/practice/${study.id}">
        <span class="row__lead">${lead}</span>
        <span class="row__text">
          <span class="row__name">${escapeHtml(study.name)}</span>
          <span class="row__sub">${sub}</span>
        </span>
      </a>
      ${bulletLink(study)}
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
    const result = [
      score === undefined ? "—" : `${(score * 100).toFixed(1)}%`,
      evalCp === undefined ? "—" : `${evalCp >= 0 ? "+" : "−"}${Math.abs(evalCp / 100).toFixed(2)}`,
    ].join(" · ");
    return row(study, badge, result);
  };
  app.innerHTML = shell("studies", "Studies", "", list.length ? grouped(list, studyRow) : empty("No studies yet: create one on"));
}

function knowledgeRing(knowledge: number | null): string {
  const pct = knowledge === null ? 0 : Math.round(knowledge * 100);
  return `<span class="ring" style="--pct:${pct}" aria-label="${pct}% known">${pct}</span>`;
}

/** Practice: what's due in all, then each study's knowledge and dues, the
 * studies with something due first. */
export async function renderPracticeList(app: HTMLElement): Promise<void> {
  const [list, summaries] = await Promise.all([studies(), practiceSummary()]);
  const summary = (study: Study): PracticeSummary | undefined => summaries[String(study.id)];
  const due = (study: Study) => summary(study)?.dueCount ?? 0;
  const ordered = [...list.filter((s) => due(s) > 0), ...list.filter((s) => due(s) === 0)];
  const totalDue = list.reduce((n, study) => n + due(study), 0);
  const practiceRow = (study: Study) => {
    const s = summary(study);
    const parts = [
      s?.dueCount ? `<b class="due">${s.dueCount} due</b>` : "",
      s?.newCount ? `${s.newCount} new` : "",
      s?.bullet?.runs ? `<span data-icon="&#xe032;" aria-hidden="true"></span> ${s.bullet.successes}/${s.bullet.runs}` : "",
    ].filter(Boolean);
    return row(study, knowledgeRing(s?.aggregateKnowledge ?? null), parts.join(" · ") || "Up to date");
  };
  app.innerHTML = shell(
    "practice",
    "Practice",
    totalDue ? `<b class="due">${totalDue} due</b>` : "",
    list.length ? grouped(ordered, practiceRow) : empty("No studies yet: create one on"),
  );
}
