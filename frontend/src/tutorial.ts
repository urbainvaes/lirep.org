import { bindZoom, renderLanding } from "./landing";
import { fetchMe, renderAuthArea } from "./layout";

// The Tutorial page: for now, what the home page shows signed-out visitors.
async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);
  const main = document.getElementById("tutorial-main");
  if (!main) return;
  main.innerHTML = renderLanding(me.authenticated);
  bindZoom(main);
}

init();
