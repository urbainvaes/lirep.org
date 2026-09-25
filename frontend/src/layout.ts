export interface MeResponse {
  authenticated: boolean;
  username?: string;
  title?: string | null;
}

export function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
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

  if (data.authenticated && data.username) {
    authArea.innerHTML = `
      <a class="username" href="/profile.html">${escapeHtml(data.username)}</a>
      <a class="btn btn-secondary" href="/auth/logout">Log out</a>
    `;
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
