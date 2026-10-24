// Lirep's mobile app (see mobile/README.md): the studies and practice, for a
// phone, at /m/. Screens by the address's #fragment:
//   #/            the studies
//   #/practice    practice: what's due, study by study
//   #/practice/ID a practice session on one study

import "@web/theme";
import "./style.css";

import { SignedOut, me, signInUrl } from "./api";
import { renderPracticeList, renderStudies } from "./lists";
import { renderSession } from "./session";

const app = document.getElementById("app") as HTMLElement;
// What the current screen leaves behind (a board, timers), undone before
// the next one.
let leave: (() => void) | null = null;

function signedOut(): void {
  app.innerHTML = `
    <main class="welcome">
      <span class="welcome__logo" aria-hidden="true"></span>
      <h1>Lirep</h1>
      <p>Your opening repertoire, on the go.</p>
      <a class="button button--primary" href="${signInUrl()}">Sign in with Lichess</a>
    </main>
  `;
}

async function route(): Promise<void> {
  leave?.();
  leave = null;
  const hash = location.hash || "#/";
  const session = hash.match(/^#\/practice\/(\d+)$/);
  try {
    if (session) leave = await renderSession(app, Number(session[1]));
    else if (hash.startsWith("#/practice")) await renderPracticeList(app);
    else await renderStudies(app);
  } catch (err) {
    if (err instanceof SignedOut) return signedOut();
    app.innerHTML = `
      <main class="welcome">
        <p>Lirep can't be reached right now.</p>
        <button class="button" type="button" id="retry">Try again</button>
      </main>
    `;
    document.getElementById("retry")?.addEventListener("click", () => void route());
  }
}

async function start(): Promise<void> {
  try {
    if (!(await me()).authenticated) return signedOut();
  } catch {
    // Offline: the route shows the error and a retry.
  }
  window.addEventListener("hashchange", () => void route());
  await route();
}

void start();
