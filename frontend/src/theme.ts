// Light / dark / system theme, like lichess.org's. The choice is remembered in
// localStorage; the resolved theme is exposed as <html data-theme="light|dark">
// (also set by an inline script in every page's <head>, so there is no flash).

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "theme";
const ORDER: ThemePreference[] = ["system", "light", "dark"];
const LABELS: Record<ThemePreference, { icon: string; title: string }> = {
  system: { icon: "◐", title: "Theme: follow the system (click for light)" },
  light: { icon: "☀", title: "Theme: light (click for dark)" },
  dark: { icon: "☾", title: "Theme: dark (click to follow the system)" },
};

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage may be unavailable; fall back to the system setting.
  }
  return "system";
}

function systemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolve(preference: ThemePreference): "light" | "dark" {
  return preference === "system" ? systemTheme() : preference;
}

let preference = readPreference();

function apply(): void {
  const theme = resolve(preference);
  document.documentElement.dataset.theme = theme;
  document.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
  const button = document.getElementById("theme-toggle");
  if (button) {
    button.textContent = LABELS[preference].icon;
    button.title = LABELS[preference].title;
    button.setAttribute("aria-label", LABELS[preference].title);
  }
}

function setPreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not remembered, but still applied for this page view.
  }
  apply();
}

function installToggle(): void {
  const header = document.querySelector(".site-header__inner");
  if (!header || document.getElementById("theme-toggle")) return;
  const button = document.createElement("button");
  button.id = "theme-toggle";
  button.type = "button";
  button.className = "theme-toggle";
  button.addEventListener("click", () => {
    setPreference(ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length]);
  });
  const auth = header.querySelector(".site-auth");
  header.insertBefore(button, auth);
  apply();
}

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (preference === "system") apply();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installToggle);
} else {
  installToggle();
}
