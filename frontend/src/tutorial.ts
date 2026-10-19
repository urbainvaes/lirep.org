import { fetchMe, renderAuthArea } from "./layout";

// The Tutorial page: its screenshots, with their numbered markers, enlarge
// on a click (the markers come along, unlike the home page's zoom).
async function init(): Promise<void> {
  renderAuthArea(await fetchMe());
}

const dialog = document.createElement("dialog");
dialog.className = "landing__lightbox tut-lightbox";
dialog.addEventListener("click", () => dialog.close());
document.body.append(dialog);
document.querySelectorAll<HTMLButtonElement>(".tut-shot").forEach((shot) => {
  shot.addEventListener("click", () => {
    dialog.innerHTML = `<button class="landing__lightbox-close" type="button" aria-label="Close">×</button><div class="tut-shot tut-shot--zoomed">${shot.innerHTML}</div>`;
    dialog.showModal();
  });
});

init();
