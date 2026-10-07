import "./theme";
import "./menu";

export interface MeResponse {
  authenticated: boolean;
  username?: string;
  title?: string | null;
}

/** Safe in element content and in quoted attribute values: serializing
 * text escapes &, < and >, but not quotes, so those are escaped here. */
export function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function fetchMe(): Promise<MeResponse> {
  let cached: MeResponse | null = null;
  try {
    const raw = sessionStorage.getItem("auth-state");
    if (raw) {
      cached = JSON.parse(raw) as MeResponse;
      renderAuthArea(cached);
    }
  } catch {
    // Storage may be unavailable; the API response remains authoritative.
  }

  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    const data: MeResponse = await res.json();
    try {
      sessionStorage.setItem("auth-state", JSON.stringify(data));
    } catch {
      // Storage may be unavailable; continue with the API response.
    }
    return data;
  } catch {
    // A network error reaching our own backend (e.g. it's mid-restart, or a
    // brief connectivity blip) isn't evidence the session is invalid —
    // trust the last known state instead of flashing "Sign in" for
    // something transient. Only a real 200/401-style response from the
    // backend should ever say you're logged out.
    return cached ?? { authenticated: false };
  }
}

export function renderAuthArea(data: MeResponse): void {
  const authArea = document.getElementById("auth-area");
  if (!authArea) return;

  // On narrow screens "Log out" lives in the hamburger menu instead of the
  // header (see the media query in style.css), so the menu gets its own link.
  const nav = document.querySelector(".site-nav");
  nav?.querySelector(".site-nav__logout")?.remove();

  if (data.authenticated && data.username) {
    authArea.innerHTML = `
      <a class="username" href="/profile.html" title="${escapeHtml(data.username)}" aria-label="Profile: ${escapeHtml(data.username)}">
        <span class="username__name">${escapeHtml(data.username)}</span>
        <svg class="username__icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>
      </a>
      <a class="btn btn-secondary site-auth__logout" href="/auth/logout">Log out</a>
    `;
    nav?.insertAdjacentHTML("beforeend", `<a class="site-nav__logout" href="/auth/logout">Log out</a>`);
  } else {
    authArea.innerHTML = `<a class="btn btn-primary" href="/auth/login">Sign in</a>`;
  }
}

export function renderSignedOut(container: HTMLElement): void {
  container.innerHTML = `
    <div class="empty-state">
      <p>Sign in with your Lichess account to use Studies, Stats, and Practice.</p>
      <a class="btn btn-primary" href="/auth/login">Sign in</a>
    </div>
  `;
}
