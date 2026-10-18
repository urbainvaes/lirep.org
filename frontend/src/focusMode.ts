// Focus mode, the same on every page with a board (the editor, the read-only
// viewer, practice and bullet): the site's header and the page's own heading
// hide, and the board and what goes with it fill the window. Space or Z
// switches it, Esc leaves it. Remembered in this browser, for all pages.

const STORAGE_KEY = "focus-mode";
// The editor's own key, from before every page had focus mode.
const LEGACY_STORAGE_KEY = "study-focus-mode";

export interface FocusMode {
  readonly on: boolean;
  set(on: boolean): void;
  /** Space, Z or Esc; true when the key was for focus mode. The caller
   * has already left out modified keys and keys typed in a field. */
  handleKey(e: KeyboardEvent): boolean;
}

export const FOCUS_BUTTON_HTML = `<button id="focus-btn" class="board-nav__btn board-focus-btn" type="button" aria-pressed="false" title="Focus mode (Space or Z)" aria-label="Focus mode"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="focus-enter" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><path class="focus-leave" d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg></button>`;

export const FOCUS_SHORTCUT_HTML = `<li><kbd>Space</kbd> or <kbd>Z</kbd> Focus mode (<kbd>Esc</kbd> to leave)</li>`;

/** `button`: the page's focus button (#focus-btn). `grid`: on board pages
 * sized to the window (.site-main--board), the element whose distance from
 * the top of the page is measured as --editor-top on `main`, with `above`
 * the elements whose height changes it. */
export function setupFocusMode(options: {
  main: HTMLElement;
  button: HTMLButtonElement | null;
  grid?: HTMLElement;
  above?: (Element | null)[];
}): FocusMode {
  const { main, button, grid } = options;

  function measureEditorTop(): void {
    if (grid) main.style.setProperty("--editor-top", `${Math.round(grid.getBoundingClientRect().top + window.scrollY)}px`);
  }

  let focusMode = false;
  // Whether focus mode came on by itself, with full screen (see below).
  let autoFocused = false;
  // `remember`: false when full screen switches it, which shouldn't change
  // the choice kept for next time.
  function setFocusMode(on: boolean, remember = true): void {
    focusMode = on;
    if (remember) autoFocused = false;
    document.documentElement.classList.toggle("focus-mode", on);
    if (button) {
      button.setAttribute("aria-pressed", String(on));
      const label = on ? "Leave focus mode" : "Focus mode";
      button.setAttribute("aria-label", label);
      button.title = `${label} (${on ? "Space, Z or Esc" : "Space or Z"})`;
    }
    if (remember) {
      try {
        localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
      } catch {
        // Keep the choice for this page even when browser storage is blocked.
      }
    }
    if (on) window.scrollTo(0, 0);
    measureEditorTop();
  }

  // Full screen brings focus mode, and takes it away again if it brought
  // it (and it wasn't switched since). Browsers don't tell a page about
  // their own full screen (F11): it shows as the page's full screen, the
  // display-mode media query, or the window covering the whole screen.
  const fullScreenQuery = window.matchMedia("(display-mode: fullscreen)");
  const isFullScreen = () =>
    document.fullscreenElement !== null ||
    fullScreenQuery.matches ||
    (window.outerWidth >= screen.width - 1 && window.outerHeight >= screen.height - 1);
  let fullScreen = isFullScreen();
  function followFullScreen(): void {
    const now = isFullScreen();
    if (now === fullScreen) return;
    fullScreen = now;
    if (now && !focusMode) {
      setFocusMode(true, false);
      autoFocused = true;
    } else if (!now && autoFocused) {
      setFocusMode(false, false);
      autoFocused = false;
    }
  }
  window.addEventListener("resize", followFullScreen);
  document.addEventListener("fullscreenchange", followFullScreen);
  fullScreenQuery.addEventListener("change", followFullScreen);
  button?.addEventListener("click", () => setFocusMode(!focusMode));
  setFocusMode((() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)) === "on";
    } catch {
      return false;
    }
  })(), false);
  // Opened in full screen: as if it had just been entered.
  if (fullScreen && !focusMode) {
    setFocusMode(true, false);
    autoFocused = true;
  }

  if (grid) {
    // The header and the page's heading can change height (wrapping, renaming).
    const editorTopObserver = new ResizeObserver(measureEditorTop);
    for (const el of [document.querySelector(".site-header"), ...(options.above ?? [])]) {
      if (el) editorTopObserver.observe(el);
    }
    window.addEventListener("resize", measureEditorTop);
  }

  return {
    get on() {
      return focusMode;
    },
    set: setFocusMode,
    handleKey(e: KeyboardEvent): boolean {
      switch (e.key) {
        case " ": {
          // Space keeps pressing a button, link or fold reached with the
          // keyboard (Tab); one just clicked doesn't keep it.
          const target = e.target as HTMLElement;
          if (target.closest("button, a, summary") && target.matches(":focus-visible")) return false;
          e.preventDefault(); // nor does it scroll the page
          setFocusMode(!focusMode);
          return true;
        }
        case "z":
        case "Z":
          e.preventDefault();
          setFocusMode(!focusMode);
          return true;
        case "Escape":
          if (!focusMode) return false;
          e.preventDefault();
          setFocusMode(false);
          return true;
      }
      return false;
    },
  };
}
