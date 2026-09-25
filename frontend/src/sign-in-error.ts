import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

fetchMe().then(renderAuthArea);

const params = new URLSearchParams(window.location.search);
const message = params.get("message");

if (message) {
  const el = document.getElementById("error-message");
  if (el) el.innerHTML = escapeHtml(message);
}
