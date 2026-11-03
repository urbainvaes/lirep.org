// Tips: a "?" in the header, after the theme toggle, shows or hides them on
// every page (the home page's "Getting started", the study editor's guide to
// its buttons). On until switched off; remembered in this browser. While on,
// <html> has the class "tips-on", which shows the elements with the class
// "tips" (style.css), and the button is filled in. A tip can also be hidden
// alone, for this page view only ("Hide this tip now"): it is back the next
// time the page opens.

const STORAGE_KEY = "tips";

// The tips on this page, by id, and those hidden for now.
const tips = new Map<string, HTMLElement>();
const hiddenNow = new Set<string>();

function syncTips(): void {
  for (const [id, el] of tips) el.hidden = hiddenNow.has(id);
}

/** A tip's foot: what tips are, then "Hide all tips" and, large, "Hide
 * this tip now" (bindTip makes them work). */
export function tipFooterHtml(): string {
  return `<div class="tip-footer">
      <p class="tip-footer__note">Tips like this one appear while the <span class="tip-footer__key">?</span> at the top of the page is on. <em>Hide this tip now</em> hides it until you come back to the page; <em>Hide all tips</em> switches the <span class="tip-footer__key">?</span> off.</p>
      <span class="tip-footer__actions">
        <button class="btn btn-secondary" type="button" data-tips-off title="Hide every tip (the ? at the top shows them again)">Hide all tips</button>
        <button class="btn btn-primary tip-footer__hide" type="button" data-tip-hide title="Hide this tip until you come back to this page; tips stay on">Hide this tip now</button>
      </span>
    </div>`;
}

/** Makes `el` the tip `id` (drawn again, it stays hidden if hidden now),
 * and binds its buttons. */
export function bindTip(el: HTMLElement, id: string): void {
  tips.set(id, el);
  el.hidden = hiddenNow.has(id);
  el.querySelector("[data-tip-hide]")?.addEventListener("click", () => {
    hiddenNow.add(id);
    el.hidden = true;
  });
  el.querySelector("[data-tips-off]")?.addEventListener("click", () => setTips(false));
}

function saved(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
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
  // Switched on: every tip again, those hidden for now too.
  if (next) hiddenNow.clear();
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // For this page view only.
  }
  document.documentElement.classList.toggle("tips-on", next);
  syncButton();
  syncTips();
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
  on = event.newValue !== "off";
  document.documentElement.classList.toggle("tips-on", on);
  syncButton();
  window.dispatchEvent(new CustomEvent("tips-change", { detail: on }));
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installToggle);
} else {
  installToggle();
}
