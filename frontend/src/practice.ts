import { statsLine, type BulletStats } from "./bulletStats";
import { escapeHtml, fetchMe, renderAuthArea, renderSignedOut } from "./layout";
import { activityTzOffset, renderPracticeOverview, type PracticeActivity } from "./practiceActivity";
import { openingMovesHtml, renderStudyGroups, type StudyCardData } from "./studyCard";

interface PracticeSummary {
  totalItems: number;
  dueCount: number;
  newCount: number;
  aggregateKnowledge: number | null;
  bullet?: BulletStats;
}

function knowledgeLabel(summary: PracticeSummary): string {
  if (summary.totalItems === 0) return "—";
  return `${Math.round((summary.aggregateKnowledge ?? 0) * 100)}%`;
}

// Under Knowledge, the same way: Bullet runs that reached the end of the
// preparation out of all runs (the last ones in the title).
function bulletRowHtml(bullet: BulletStats | undefined): string {
  const title = bullet?.runs
    ? `Bullet runs that reached the end of the preparation: ${statsLine(bullet)}`
    : "No Bullet runs yet: the Bullet button starts one";
  return `
      <div class="study-card__score" title="${title}">
        <span>Bullet score</span>
        <strong>${bullet?.runs ? `${bullet.successes} / ${bullet.runs}` : "—"}</strong>
      </div>`;
}

function renderCard(study: StudyCardData, summaries: Record<string, PracticeSummary>): string {
  const empty: PracticeSummary = { totalItems: 0, dueCount: 0, newCount: 0, aggregateKnowledge: null };
  const summary = summaries[String(study.id)] ?? empty;
  // Nothing due/new just means the schedule is satisfied for now — practice
  // is never gated by that, only by there being no moves to drill at all.
  const unavailableReason = summary.totalItems === 0 ? "This study has no moves of its own to practice yet." : "";

  const content = `
      <div class="study-card__header">
        <h3>${escapeHtml(study.name)}</h3>
      </div>
      <div class="study-card__score">
        <span>Knowledge</span>
        <strong>${knowledgeLabel(summary)}</strong>
      </div>
      ${bulletRowHtml(summary.bullet)}
      <div class="practice-card__counts">
        <span class="practice-badge practice-badge--due">${summary.dueCount} due</span>
        <span class="practice-badge practice-badge--new">${summary.newCount} new</span>
      </div>
      <div class="study-card__line">${openingMovesHtml(study)}</div>
  `;


  if (unavailableReason) {
    return `<article class="study-card study-card--summary practice-card practice-card--unavailable" aria-disabled="true" title="${unavailableReason}">${content}<p class="practice-card__status">${unavailableReason}</p></article>`;
  }

  // The whole card starts a practice session (the Practice link stretches
  // over it); Bullet sits above that link.
  return `
    <article class="study-card study-card--summary practice-card">
      ${content}
      <div class="practice-card__actions">
        <a class="practice-card__action practice-card__practice" href="/practice-session.html?id=${study.id}" title="Practice: raises your knowledge score" aria-label="Practice ${escapeHtml(study.name)}, to raise your knowledge score"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg></a>
        <a class="practice-card__action practice-card__bullet" href="/practice-session.html?id=${study.id}&amp;mode=bullet" title="Bullet: raises your Bullet score" aria-label="Bullet practice on ${escapeHtml(study.name)}, to raise your Bullet score"><span data-icon="&#xe032;" aria-hidden="true"></span></a>
      </div>
    </article>`;
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("practice-grid");
  if (!grid) return;

  if (!me.authenticated) {
    renderSignedOut(grid);
    return;
  }

  let studies: StudyCardData[] = [];
  let summaries: Record<string, PracticeSummary> = {};
  let activity: PracticeActivity | null = null;
  try {
    const [studiesRes, summaryRes, activityRes] = await Promise.all([
      fetch("/api/studies", { credentials: "same-origin" }),
      fetch("/api/practice/summary", { credentials: "same-origin" }),
      fetch(`/api/practice/activity?tzOffset=${activityTzOffset()}`, { credentials: "same-origin" }),
    ]);
    // Archived studies are off the Practice page (see main.ts).
    if (studiesRes.ok) studies = ((await studiesRes.json()) as StudyCardData[]).filter((study) => !study.archived);
    if (summaryRes.ok) summaries = await summaryRes.json();
    if (activityRes.ok) activity = await activityRes.json();
  } catch {
    // Network error / backend not running: show the empty state below.
  }

  if (studies.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p>No studies yet. Create one first.</p>
        <a class="btn btn-primary" href="/study.html">New study</a>
      </div>
    `;
    return;
  }

  // Weakest first: least knowledge (never-practiced counts as 0), then most
  // due; studies with nothing to practice go last.
  const sortKey = (study: StudyCardData): [number, number, number] => {
    const summary = summaries[String(study.id)];
    if (!summary || summary.totalItems === 0) return [1, 0, 0];
    return [0, summary.aggregateKnowledge ?? 0, -summary.dueCount];
  };
  const sorted = [...studies].sort((a, b) => {
    const [ka, kb] = [sortKey(a), sortKey(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a.name.localeCompare(b.name);
  });

  const knowledge = Object.fromEntries(
    Object.entries(summaries).map(([id, summary]) => [id, summary.totalItems ? summary.aggregateKnowledge : null]),
  );
  grid.innerHTML =
    (activity ? renderPracticeOverview(activity, studies, knowledge) : "") +
    renderStudyGroups(sorted, (study) => renderCard(study, summaries), "practice-grid");
  // On a narrow screen the calendar scrolls; start on the recent weeks.
  const scroll = grid.querySelector(".activity__scroll");
  if (scroll) scroll.scrollLeft = scroll.scrollWidth;
}

init();
