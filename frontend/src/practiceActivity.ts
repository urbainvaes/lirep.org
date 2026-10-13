// The top of the Practice page: an activity calendar over the last year,
// one square per day shaded by how many moves were practiced, laid out like
// GitHub's contribution graph (weeks from Sunday, one column each), and
// beside it the studies you know best and practice most.

import { escapeHtml } from "./layout";
import type { StudyCardData } from "./studyCard";

export interface DayActivity {
  answers: number;
  correct: number;
}

export interface PracticeActivity {
  days: Record<string, DayActivity>;
  // Per study id, all time.
  studies: Record<string, { answers: number }>;
}

const WEEKS = 53;
const RANKED = 3;

function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

export function activityTzOffset(): number {
  return -new Date().getTimezoneOffset();
}

function renderCalendar({ days }: PracticeActivity): string {
  const today = new Date();
  const oneYearAgo = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate() + 1);
  const firstSunday = addDays(oneYearAgo, -oneYearAgo.getDay());

  const max = Math.max(1, ...Object.values(days).map((d) => d.answers));
  let total = 0;
  const cells: string[] = [];
  const months: string[] = [];
  const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short" });

  for (let week = 0; week < WEEKS; week++) {
    const sunday = addDays(firstSunday, week * 7);
    // A month's label goes on its first full week, as on GitHub, if there's
    // room for it before the calendar ends.
    if (sunday.getDate() <= 7 && week < WEEKS - 1) {
      months.push(`<span class="activity__month" style="grid-column: ${week + 2}">${monthFormat.format(sunday)}</span>`);
    }
    for (let weekday = 0; weekday < 7; weekday++) {
      const date = addDays(sunday, weekday);
      if (date < oneYearAgo) continue;
      if (date > today) break;
      const day = days[dayKey(date)];
      const answers = day?.answers ?? 0;
      total += answers;
      const level = answers === 0 ? 0 : Math.ceil((4 * answers) / max);
      const label = answers
        ? `${plural(answers, "move")} (${day.correct.toLocaleString()} correct) on ${dateFormat.format(date)}`
        : `No moves on ${dateFormat.format(date)}`;
      cells.push(
        `<span class="activity__day activity__day--${level}" style="grid-area: ${weekday + 2} / ${week + 2}" title="${label}"></span>`,
      );
    }
  }

  return `
    <section class="activity" aria-label="Practice activity">
      <h2 class="activity__title">${plural(total, "move")} practiced in the last year</h2>
      <div class="activity__box">
        <div class="activity__scroll">
          <div class="activity__calendar">
            ${months.join("")}
            ${["Mon", "Wed", "Fri"].map((name, i) => `<span class="activity__weekday" style="grid-row: ${2 * i + 3}">${name}</span>`).join("")}
            ${cells.join("")}
          </div>
        </div>
        <div class="activity__legend" aria-hidden="true">
          Less
          ${[0, 1, 2, 3, 4].map((level) => `<span class="activity__day activity__day--${level}"></span>`).join("")}
          More
        </div>
      </div>
    </section>
  `;
}

function renderRanking(title: string, rows: { study: StudyCardData; value: string }[], empty: string, unit = ""): string {
  const items = rows
    .map(
      ({ study, value }, i) => `
        <li class="rank-list__row">
          <span class="rank-list__rank">${i + 1}</span>
          <span class="rank-list__side rank-list__side--${study.side}" aria-label="${study.side === "white" ? "White" : "Black"}"></span>
          <a class="rank-list__name" href="/practice-session.html?id=${study.id}" title="Practice ${escapeHtml(study.name)}">${escapeHtml(study.name)}</a>
          <span class="rank-list__value">${value}</span>
        </li>`,
    )
    .join("");
  return `
    <div class="practice-stats__group">
      <h3 class="practice-stats__heading">${title}${unit ? ` <span class="practice-stats__unit">${unit}</span>` : ""}</h3>
      ${items ? `<ol class="rank-list">${items}</ol>` : `<p class="practice-stats__empty">${empty}</p>`}
    </div>
  `;
}

function renderStats(activity: PracticeActivity, studies: StudyCardData[], knowledge: Record<string, number | null>): string {
  const known = (study: StudyCardData) => knowledge[String(study.id)] ?? 0;
  const best = studies
    .filter((study) => known(study) > 0)
    .sort((a, b) => known(b) - known(a))
    .slice(0, RANKED)
    .map((study) => ({ study, value: `${Math.round(known(study) * 100)}%` }));

  const answers = (study: StudyCardData) => activity.studies[String(study.id)]?.answers ?? 0;
  const most = studies
    .filter((study) => answers(study) > 0)
    .sort((a, b) => answers(b) - answers(a))
    .slice(0, RANKED)
    .map((study) => ({ study, value: answers(study).toLocaleString() }));

  return `
    <section class="practice-stats" aria-label="Your studies">
      <h2 class="practice-stats__title">Your studies</h2>
      <div class="practice-stats__box">
        ${renderRanking("Best known", best, "Practice a study to see how well you know it.", "knowledge")}
        ${renderRanking("Most practiced", most, "No moves practiced yet.", "moves")}
      </div>
    </section>
  `;
}

export function renderPracticeOverview(
  activity: PracticeActivity,
  studies: StudyCardData[],
  knowledge: Record<string, number | null>,
): string {
  return `<div class="practice-overview">${renderCalendar(activity)}${renderStats(activity, studies, knowledge)}</div>`;
}
