// A branch icon next to the theme toggle, opening the Changelog page: the
// source code on GitHub, a button to open an issue, and what changed lately.

function installSourceLink(): void {
  const header = document.querySelector(".site-header__inner");
  if (!header || document.getElementById("source-link")) return;
  const link = document.createElement("a");
  link.id = "source-link";
  link.className = "source-link";
  link.href = "/changelog.html";
  link.title = "Source code and changelog";
  link.setAttribute("aria-label", "Source code and changelog");
  if (location.pathname === "/changelog.html") link.setAttribute("aria-current", "page");
  link.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
  header.insertBefore(link, document.getElementById("theme-toggle") ?? header.querySelector(".site-auth"));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installSourceLink);
} else {
  installSourceLink();
}
