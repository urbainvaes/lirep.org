import { escapeHtml, fetchMe, renderAuthArea } from "./layout";

// The forum: a list of topics (forum.html), or one topic and its posts
// (forum.html?topic=ID). Reading is open to everyone; posting needs a
// sign-in, and posts always show the author's Lichess username.

type Category = "bug" | "suggestion" | "other";

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "bug", label: "Bug report" },
  { key: "suggestion", label: "Suggestion" },
  { key: "other", label: "Other" },
];

const MAX_TITLE = 120;
const MAX_BODY = 5000;

interface TopicSummary {
  id: number;
  author: string;
  category: Category;
  title: string;
  createdAt: string;
  lastPostAt: string;
  replies: number;
  lastAuthor: string;
  authorProfile: boolean;
  lastAuthorProfile: boolean;
}

interface Post {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  canDelete: boolean;
  authorProfile: boolean;
}

interface Topic {
  id: number;
  author: string;
  category: Category;
  title: string;
  createdAt: string;
  posts: Post[];
}

/** An author's name, linking to their Lirep profile unless they chose to be
 * anonymous (their profile is hidden then). */
function authorHtml(name: string, hasProfile: boolean): string {
  return hasProfile
    ? `<a class="forum-author" href="/player.html?u=${encodeURIComponent(name)}">${escapeHtml(name)}</a>`
    : escapeHtml(name);
}

function categoryLabel(category: Category): string {
  return CATEGORIES.find((c) => c.key === category)?.label ?? category;
}

function categoryBadge(category: Category): string {
  return `<span class="forum-category forum-category--${category}">${categoryLabel(category)}</span>`;
}

// SQLite's datetime('now') is UTC without a zone marker.
function formatDate(value: string, withTime = false): string {
  const date = new Date(value.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/** Plain text with its line breaks (kept by CSS) and clickable links.
 * escapeHtml leaves quotes alone, so a URL stops at one and quotes are
 * escaped again inside the href: a post can't break out of the attribute. */
function bodyHtml(body: string): string {
  return escapeHtml(body).replace(
    /https?:\/\/[^\s<"']+[^\s<"'.,;:!?)\]]/g,
    (url) => `<a href="${url.replace(/"/g, "&quot;")}" target="_blank" rel="nofollow ugc noopener noreferrer">${url}</a>`,
  );
}

async function errorText(res: Response): Promise<string> {
  if (res.status === 401) return "Your session has expired. Please sign in again.";
  try {
    const detail = (await res.json()).detail;
    if (typeof detail === "string") return detail;
  } catch {
    // Not JSON.
  }
  return "Something went wrong. Please try again.";
}

function postingNote(): string {
  return `<p class="forum-note">Posts show your Lichess username, even if you appear anonymous elsewhere on Lirep.</p>`;
}

function signInToPost(): string {
  return `<p class="forum-note"><a href="/auth/login">Sign in with Lichess</a> to post.</p>`;
}

function renderList(main: HTMLElement, topics: TopicSummary[], category: Category | null, signedIn: boolean): void {
  const filters = [{ key: null, label: "All" }, ...CATEGORIES]
    .map(
      (c) =>
        `<a class="forum-filter${c.key === category ? " forum-filter--active" : ""}" href="/forum.html${c.key ? `?category=${c.key}` : ""}"${
          c.key === category ? ` aria-current="page"` : ""
        }>${c.label}</a>`,
    )
    .join("");
  const rows = topics
    .map(
      (t) => `
      <tr>
        <td><a class="forum-topic-link" href="/forum.html?topic=${t.id}"><strong>${escapeHtml(t.title)}</strong></a>
          <div class="community-sub">${authorHtml(t.author, t.authorProfile)} · ${escapeHtml(formatDate(t.createdAt))}</div></td>
        <td>${categoryBadge(t.category)}</td>
        <td class="forum-count">${t.replies}</td>
        <td class="community-settings">${escapeHtml(formatDate(t.lastPostAt))}<div class="community-sub">${authorHtml(t.lastAuthor, t.lastAuthorProfile)}</div></td>
      </tr>`,
    )
    .join("");

  main.innerHTML = `
    <div class="profile-section__heading">
      <div>
        <h1 class="forum-title">Forum</h1>
        <p class="profile-subtitle">Report bugs, suggest improvements, or ask anything about Lirep.</p>
      </div>
      ${signedIn ? `<button id="new-topic-btn" class="btn btn-primary" type="button" aria-expanded="false" aria-controls="new-topic">New topic</button>` : ""}
    </div>
    ${
      signedIn
        ? `<form id="new-topic" class="forum-form" hidden>
            <div class="forum-form__row">
              <select id="topic-category" aria-label="Category">
                ${CATEGORIES.map((c) => `<option value="${c.key}" ${c.key === (category ?? "bug") ? "selected" : ""}>${c.label}</option>`).join("")}
              </select>
              <input id="topic-title" type="text" maxlength="${MAX_TITLE}" placeholder="Title" aria-label="Title" required />
            </div>
            <textarea id="topic-body" rows="6" maxlength="${MAX_BODY}" placeholder="For a bug: what you did, what you expected, and what happened instead." aria-label="Message" required></textarea>
            ${postingNote()}
            <div class="forum-form__actions">
              <button class="btn btn-primary" type="submit">Post</button>
              <span class="forum-form__status" role="status" aria-live="polite"></span>
            </div>
          </form>`
        : signInToPost()
    }
    <nav class="forum-filters" aria-label="Categories">${filters}</nav>
    ${
      topics.length
        ? `<div class="community-table-wrap"><table class="community-table forum-table">
            <thead><tr><th>Topic</th><th>Category</th><th>Replies</th><th>Last post</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`
        : `<div class="empty-state profile-empty"><p>No topics${category ? ` in ${categoryLabel(category).toLowerCase()}s` : ""} yet.</p></div>`
    }
  `;

  if (!signedIn) return;
  const toggle = document.getElementById("new-topic-btn") as HTMLButtonElement;
  const form = document.getElementById("new-topic") as HTMLFormElement;
  const titleEl = document.getElementById("topic-title") as HTMLInputElement;
  toggle.addEventListener("click", () => {
    form.hidden = !form.hidden;
    toggle.setAttribute("aria-expanded", String(!form.hidden));
    if (!form.hidden) titleEl.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector(".forum-form__status") as HTMLElement;
    const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
    submit.disabled = true;
    status.textContent = "";
    try {
      const res = await fetch("/api/forum/topics", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: (document.getElementById("topic-category") as HTMLSelectElement).value,
          title: titleEl.value,
          body: (document.getElementById("topic-body") as HTMLTextAreaElement).value,
        }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const { id } = await res.json();
      window.location.href = `/forum.html?topic=${id}`;
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Could not post. Please try again.";
      submit.disabled = false;
    }
  });
}

function renderTopic(main: HTMLElement, topic: Topic, signedIn: boolean, reload: () => void): void {
  const posts = topic.posts
    .map(
      (p, i) => `
      <article class="forum-post" id="post-${p.id}">
        <header class="forum-post__head">
          <strong>${authorHtml(p.author, p.authorProfile)}</strong>
          <span class="forum-post__date">${escapeHtml(formatDate(p.createdAt, true))}</span>
          ${
            p.canDelete
              ? `<button class="forum-post__delete" type="button" data-post="${p.id}" data-first="${i === 0}">${i === 0 ? "Delete topic" : "Delete"}</button>`
              : ""
          }
        </header>
        <div class="forum-post__body">${bodyHtml(p.body)}</div>
      </article>`,
    )
    .join("");

  main.innerHTML = `
    <p class="doc-intro"><a class="community-owner" href="/forum.html">← Forum</a></p>
    <div class="forum-topic-head">
      <h1 class="forum-title">${escapeHtml(topic.title)}</h1>
      ${categoryBadge(topic.category)}
    </div>
    <div class="forum-posts">${posts}</div>
    ${
      signedIn
        ? `<form id="reply-form" class="forum-form">
            <textarea id="reply-body" rows="4" maxlength="${MAX_BODY}" placeholder="Reply" aria-label="Reply" required></textarea>
            ${postingNote()}
            <div class="forum-form__actions">
              <button class="btn btn-primary" type="submit">Reply</button>
              <span class="forum-form__status" role="status" aria-live="polite"></span>
            </div>
          </form>`
        : signInToPost()
    }
  `;

  main.querySelectorAll<HTMLButtonElement>(".forum-post__delete").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const first = btn.dataset.first === "true";
      if (!window.confirm(first ? "Delete this topic and all its replies?" : "Delete this post?")) return;
      btn.disabled = true;
      const res = await fetch(`/api/forum/posts/${btn.dataset.post}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) {
        btn.disabled = false;
        window.alert(await errorText(res));
        return;
      }
      if (first) window.location.href = "/forum.html";
      else reload();
    });
  });

  const form = document.getElementById("reply-form") as HTMLFormElement | null;
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = form.querySelector(".forum-form__status") as HTMLElement;
    const submit = form.querySelector("button[type=submit]") as HTMLButtonElement;
    submit.disabled = true;
    status.textContent = "";
    try {
      const res = await fetch(`/api/forum/topics/${topic.id}/posts`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: (document.getElementById("reply-body") as HTMLTextAreaElement).value }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      reload();
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Could not post. Please try again.";
      submit.disabled = false;
    }
  });
}

async function init(): Promise<void> {
  const me = await fetchMe();
  renderAuthArea(me);

  const main = document.getElementById("forum-main");
  if (!main) return;

  const params = new URLSearchParams(window.location.search);
  const topicId = Number(params.get("topic"));
  const requested = params.get("category");
  const category = CATEGORIES.some((c) => c.key === requested) ? (requested as Category) : null;

  async function load(): Promise<void> {
    try {
      if (topicId) {
        const res = await fetch(`/api/forum/topics/${topicId}`, { credentials: "same-origin" });
        if (res.status === 404) {
          main!.innerHTML = `<div class="empty-state"><p>This topic doesn't exist (or was deleted).</p><a class="btn btn-secondary" href="/forum.html">Forum</a></div>`;
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const topic: Topic = await res.json();
        document.title = `${topic.title} · Forum · lirep.org`;
        renderTopic(main!, topic, me.authenticated, () => void load());
      } else {
        const res = await fetch(`/api/forum/topics${category ? `?category=${category}` : ""}`, { credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        renderList(main!, await res.json(), category, me.authenticated);
      }
    } catch {
      main!.innerHTML = `<div class="empty-state"><p>Could not load the forum. Please try again in a moment.</p></div>`;
    }
  }
  await load();
}

init();
