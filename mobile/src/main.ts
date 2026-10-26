// Lirep's mobile app (see mobile/README.md): the studies and practice, for a
// phone, at /m/. Screens by the address's #fragment:
//   #/            the studies
//   #/study/ID    a study, read-only: its moves, along the prep
//   #/stats/ID    a study's saved stats
//   #/practice    practice: what's due, study by study
//   #/practice/ID a practice session on one study
//   #/bullet/ID   Bullet on one study
//   #/community   the leaderboards (#/community/eval: by evaluation)

import "@web/theme";
import { syncBadgePrefs } from "@web/badgePrefs";
import "./style.css";

import { applyBoardTheme } from "@web/board";

import { SignedOut, me, prefetch, signInUrl } from "./api";
import { flush, onWaiting } from "./outbox";
import { renderBullet } from "./bullet";
import { renderCommunity, renderPracticeList, renderStudies } from "./lists";
import { renderSession } from "./session";
import { renderStats } from "./stats";
import { renderStudyView } from "./studyView";

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
  const bullet = hash.match(/^#\/bullet\/(\d+)$/);
  const stats = hash.match(/^#\/stats\/(\d+)$/);
  const view = hash.match(/^#\/study\/(\d+)$/);
  try {
    if (session) leave = await renderSession(app, Number(session[1]));
    else if (bullet) leave = await renderBullet(app, Number(bullet[1]));
    else if (view) leave = await renderStudyView(app, Number(view[1]));
    else if (stats) await renderStats(app, Number(stats[1]), () => location.hash === hash);
    else if (hash.startsWith("#/practice")) await renderPracticeList(app);
    else if (hash.startsWith("#/community")) await renderCommunity(app, hash === "#/community/eval" ? "eval" : "score");
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

// Offline, or answers waiting to be sent: a small note above the bottom bar.
function showNetwork(): void {
  const note = document.createElement("div");
  note.className = "net";
  note.setAttribute("role", "status");
  document.body.append(note);
  let waiting = 0;
  const show = () => {
    const parts = [navigator.onLine ? "" : "Offline", waiting ? `${waiting} to send` : ""].filter(Boolean);
    note.textContent = parts.join(" · ");
    note.hidden = !parts.length;
  };
  onWaiting((count) => {
    waiting = count;
    show();
  });
  window.addEventListener("online", show);
  window.addEventListener("offline", show);
}

async function start(): Promise<void> {
  // The service worker keeps the app for offline use (public/sw.js); not
  // while developing, where it would serve stale files.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" }).catch(() => {});
  }
  showNetwork();
  void flush();
  // Every screen's board: the theme kept from last time at once, then the
  // current one.
  void applyBoardTheme();
  try {
    const account = await me();
    if (!account.authenticated) return signedOut();
    syncBadgePrefs(account.preferences);
  } catch {
    // Offline: the route shows the error and a retry.
  }
  window.addEventListener("hashchange", () => void route());
  await route();
  prefetch();
}

void start();
