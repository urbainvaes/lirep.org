// The site's header (and the study editor's bar, in its place) stays at the
// top of the window, as on Lichess: scrolling down slides it away, scrolling
// up brings it back. Not while the menu is open, nor near the top of the
// page, where it's in its place anyway.

// A scroll smaller than this doesn't count (a trackpad's jitter).
const THRESHOLD_PX = 6;

function install(): void {
  let lastY = window.scrollY;
  let scheduled = false;

  function bars(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".site-header, .study-bar")];
  }

  function update(): void {
    scheduled = false;
    const y = Math.max(0, window.scrollY);
    const delta = y - lastY;
    if (Math.abs(delta) < THRESHOLD_PX) return;
    lastY = y;
    const menuOpen = document.querySelector(".site-nav--open") !== null;
    for (const bar of bars()) {
      const hide = delta > 0 && y > bar.offsetHeight && !menuOpen && !bar.contains(document.activeElement);
      bar.classList.toggle("bar--hidden", hide);
    }
  }

  window.addEventListener(
    "scroll",
    () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  // Tabbing into a hidden bar (its links, the study's name) shows it.
  document.addEventListener("focusin", (event) => {
    for (const bar of bars()) if (bar.contains(event.target as Node)) bar.classList.remove("bar--hidden");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", install);
} else {
  install();
}
