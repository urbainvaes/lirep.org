// Tips: a "?" in the header, after the theme toggle, shows or hides them on
// every page (the home page's "Getting started", the study editor's guide to
// its buttons). Off until switched on; remembered in this browser. While on,
// <html> has the class "tips-on", which shows the elements with the class
// "tips" (style.css), and the button is filled in.

const STORAGE_KEY = "tips";

function saved(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

let on = saved();
// At once, before the page is drawn: no tips flashing in or out.
document.documentElement.classList.toggle("tips-on", on);

/** Whether tips show. */
export function tipsOn(): boolean {
  return on;
}

/** Shows or hides tips (remembered), as the header's button does. */
export function setTips(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // For this page view only.
  }
  document.documentElement.classList.toggle("tips-on", next);
  syncButton();
  window.dispatchEvent(new CustomEvent("tips-change", { detail: next }));
}

function syncButton(): void {
  const button = document.getElementById("tips-toggle");
  if (!button) return;
  const label = on ? "Hide tips" : "Show tips";
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", label);
  button.title = label;
}

function installToggle(): void {
  const header = document.querySelector(".site-header__inner");
  if (!header || document.getElementById("tips-toggle")) return;
  const button = document.createElement("button");
  button.id = "tips-toggle";
  button.type = "button";
  button.className = "tips-toggle";
  button.textContent = "?";
  button.addEventListener("click", () => setTips(!on));
  // After the theme toggle, before the account.
  header.insertBefore(button, header.querySelector(".site-auth"));
  syncButton();
}

// Another tab switching tips follows here too.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  on = event.newValue === "on";
  document.documentElement.classList.toggle("tips-on", on);
  syncButton();
  window.dispatchEvent(new CustomEvent("tips-change", { detail: on }));
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installToggle);
} else {
  installToggle();
}
