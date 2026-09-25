import { fetchMe, renderAuthArea } from "./layout";
import { bindStudyDelete, renderStudyCardWithActions, renderStudyGroups, renderNewStudyCard, type StudyCardData } from "./studyCard";

// What a signed-out visitor sees: what Lirep is for, then a way in.
function renderLanding(): string {
  return `
    <section class="landing">
      <div class="landing__hero">
        <h1>Build, drill and assess your repertoire</h1>
        <p class="landing__pitch">Lirep evaluates your repertoire against the moves real Lichess players choose, then helps you remember it.</p>
        <div class="landing__actions">
          <a class="btn btn-primary landing__cta" href="/auth/login">Sign in with Lichess</a>
          <a class="btn btn-primary landing__cta" href="/community.html">Browse community openings</a>
        </div>
        <p class="landing__note">Free and open source. No new account: you sign in with Lichess.</p>
      </div>
      <div class="landing__features">
        <article class="landing__feature">
          <h2>Know how good it is</h2>
          <p>See the expected score of your whole repertoire (calculated as the win probability plus half the draw probability), 
          the share of games that stay in your preparation after a given number of moves,
          and the expected Stockfish evaluation when it ends.</p>
        </article>
        <article class="landing__feature">
          <h2>Remember it</h2>
          <p>Practice quizzes you on your own moves. Each position's knowledge fades over time, and comes back
            for review just before you would forget it.</p>
        </article>
        <article class="landing__feature">
          <h2>Share and reuse</h2>
          <p>Publish your openings on the community page, and import someone else's
            in one click.</p>
        </article>
      </div>
    </section>
  `;
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const grid = document.getElementById("home-studies-grid");
  if (!grid) return;

  if (!me.authenticated) {
    grid.innerHTML = renderLanding();
    return;
  }

  let studies: StudyCardData[] = [];
  try {
    const res = await fetch("/api/studies", { credentials: "same-origin" });
    if (res.ok) studies = await res.json();
  } catch {
    // Keep the new-study action available if loading fails.
  }

  const render = (): void => {
    grid.innerHTML = renderStudyGroups(studies, renderStudyCardWithActions, "studies-grid", renderNewStudyCard);
  };
  render();
  bindStudyDelete(grid, studies, render);
}

init();
