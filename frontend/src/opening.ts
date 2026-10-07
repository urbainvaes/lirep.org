import { applyBoardTheme } from "./board";
import type { ExplorerSettings } from "./explorer";
import { escapeHtml, fetchMe, renderAuthArea } from "./layout";
import type { StudyTree } from "./tree";
import { renderTreeViewer } from "./treeViewer";

// A shared opening, read-only (opening.html?id=…): the tree viewer with the
// author's name, and Import (or Edit, for your own). See
// /api/community/studies/{id}.

interface SharedOpening {
  id: number;
  name: string;
  side: "white" | "black";
  owner: string | null;
  anonymous: boolean;
  mine: boolean;
  tree: StudyTree;
  startNodeId: number | null;
  explorerSettings: ExplorerSettings;
}

function render(main: HTMLElement, opening: SharedOpening, signedIn: boolean): void {
  const footer = renderTreeViewer(
    main,
    {
      tree: opening.tree,
      side: opening.side,
      startNodeId: opening.startNodeId,
      explorerSettings: opening.explorerSettings,
      title: opening.name,
      bylineHtml:
        opening.owner === null
          ? `by an anonymous player`
          : `by <a class="community-owner" href="/player.html?u=${encodeURIComponent(opening.owner)}">${escapeHtml(opening.owner)}</a>`,
      intro: "Click a move to jump there. This opening is read-only: import it to change it.",
    },
    signedIn,
  );

  // Import (a private copy in your own studies), where the editor has its links.
  if (opening.mine) {
    footer.innerHTML = `<a class="study-head__link" href="/study.html?id=${opening.id}">Edit this opening</a>`;
  } else if (!signedIn) {
    footer.innerHTML = `<a class="study-head__link" href="/auth/login">Sign in to import</a>`;
  } else {
    footer.innerHTML = `
      <span id="import-message" class="opening-import-message" role="status" aria-live="polite"></span>
      <button id="import-btn" class="study-head__link" type="button">Import to my studies</button>`;
    const importBtn = document.getElementById("import-btn") as HTMLButtonElement;
    const message = document.getElementById("import-message") as HTMLElement;
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      try {
        const res = await fetch(`/api/community/import/${opening.id}`, { method: "POST", credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const study = await res.json();
        importBtn.textContent = "Imported";
        message.innerHTML = `Added to your studies. <a href="/study.html?id=${study.id}">Open it</a>`;
      } catch {
        importBtn.disabled = false;
        message.textContent = "Could not import this opening. Please try again.";
      }
    });
  }
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("opening-main");
  if (!main) return;

  const id = Number(new URLSearchParams(window.location.search).get("id"));
  if (!id) {
    main.innerHTML = `<div class="empty-state"><p>No opening selected.</p><a class="btn btn-secondary" href="/community.html">Community</a></div>`;
    return;
  }

  try {
    const [res] = await Promise.all([fetch(`/api/community/studies/${id}`, { credentials: "same-origin" }), applyBoardTheme()]);
    if (res.status === 404) {
      main.innerHTML = `<div class="empty-state"><p>This opening is not shared (or no longer is).</p><a class="btn btn-secondary" href="/community.html">Community</a></div>`;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    render(main, await res.json(), me.authenticated);
  } catch {
    main.innerHTML = `<div class="empty-state"><p>Could not load this opening. Please try again in a moment.</p></div>`;
  }
}

init();
