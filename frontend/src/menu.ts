// On narrow screens the header's links collapse behind a hamburger button
// (the CSS hides the button and shows the links in a row on wide screens).

function installMenu(): void {
  const header = document.querySelector<HTMLElement>(".site-header__inner");
  const nav = header?.querySelector<HTMLElement>(".site-nav");
  if (!header || !nav || document.getElementById("menu-toggle")) return;

  nav.id = "site-nav";
  const button = document.createElement("button");
  button.id = "menu-toggle";
  button.type = "button";
  button.className = "menu-toggle";
  button.setAttribute("aria-controls", "site-nav");
  button.setAttribute("aria-label", "Menu");
  header.appendChild(button);

  function setOpen(open: boolean): void {
    nav!.classList.toggle("site-nav--open", open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "✕" : "☰";
  }
  setOpen(false);

  button.addEventListener("click", () => setOpen(!nav!.classList.contains("site-nav--open")));
  nav.addEventListener("click", (event) => {
    if ((event.target as Element).closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
  document.addEventListener("click", (event) => {
    if (!(event.target as Element).closest(".site-header")) setOpen(false);
  });
  window.matchMedia("(min-width: 981px)").addEventListener("change", (event) => {
    if (event.matches) setOpen(false);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installMenu);
} else {
  installMenu();
}
