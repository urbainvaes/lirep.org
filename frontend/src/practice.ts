import { escapeHtml, fetchMe, renderAuthArea, renderSignedOut } from "./layout";
import { openingMovesHtml, renderStudyGroups, type StudyCardData } from "./studyCard";

interface PracticeSummary {
  totalItems: number;
  dueCount: number;
  newCount: number;
  aggregateKnowledge: number | null;
}

function knowledgeLabel(summary: PracticeSummary): string {
  if (summary.totalItems === 0) return "—";
  return `${Math.round((summary.aggregateKnowledge ?? 0) * 100)}%`;
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
      <div class="practice-card__counts">
        <span class="practice-badge practice-badge--due">${summary.dueCount} due</span>
        <span class="practice-badge practice-badge--new">${summary.newCount} new</span>
      </div>
      <div class="study-card__line">${openingMovesHtml(study)}</div>
  `;

  if (unavailableReason) {
    return `<article class="study-card study-card--summary practice-card practice-card--unavailable" aria-disabled="true" title="${unavailableReason}">${content}<p class="practice-card__status">${unavailableReason}</p></article>`;
  }

  return `<a class="study-card study-card--summary practice-card" href="/practice-session.html?id=${study.id}" aria-label="Start practicing ${escapeHtml(study.name)}">${content}</a>`;
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
  try {
    const [studiesRes, summaryRes] = await Promise.all([
      fetch("/api/studies", { credentials: "same-origin" }),
      fetch("/api/practice/summary", { credentials: "same-origin" }),
    ]);
    if (studiesRes.ok) studies = await studiesRes.json();
    if (summaryRes.ok) summaries = await summaryRes.json();
  } catch {
    // Network error / backend not running: show the empty state below.
  }

  if (studies.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p>No studies yet. Create one in the Studies tab first.</p>
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

  grid.innerHTML = renderStudyGroups(sorted, (study) => renderCard(study, summaries), "practice-grid");
}

init();
