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
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    return await res.json();
  } catch {
    return { authenticated: false };
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
