// What the app sends while offline waits here (practice answers, Bullet
// runs), in this browser, and goes out in order once the connection is
// back. Each carries the time it happened (answeredAt, finishedAt), so the
// server counts it then (backend/app/practice.py's _when).

const KEY = "lirep-m-outbox";

interface Item {
  url: string;
  body: object;
}

function read(): Item[] {
  try {
    const items = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function write(items: Item[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage blocked: what's waiting is lost with the page.
  }
  listeners.forEach((listener) => listener(items.length));
}

const listeners = new Set<(waiting: number) => void>();

/** Told how many items wait, whenever that changes. */
export function onWaiting(listener: (waiting: number) => void): () => void {
  listeners.add(listener);
  listener(read().length);
  return () => listeners.delete(listener);
}

/** "sent", with the server's answer; "refused" (it won't take it, e.g. a
 * study since deleted); or "offline", and it waits here. */
type Result = { status: "sent"; data: unknown } | { status: "refused" } | { status: "offline" };

async function post(item: Item): Promise<Result> {
  let res: Response;
  try {
    res = await fetch(item.url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item.body),
    });
  } catch {
    return { status: "offline" };
  }
  // Signed out, or the server down: try again later. Anything else it
  // refuses would be refused again.
  if (res.status === 401 || res.status >= 500) return { status: "offline" };
  if (!res.ok) return { status: "refused" };
  return { status: "sent", data: await res.json().catch(() => null) };
}

let flushing: Promise<void> | null = null;

/** Sends what's waiting, oldest first, until done or still offline. */
export function flush(): Promise<void> {
  // Schedule the drain after assigning its promise, even when it is empty.
  flushing ??= Promise.resolve().then(async () => {
    try {
      for (let items = read(); items.length; items = read()) {
        if ((await post(items[0])).status === "offline") return;
        write(read().slice(1));
      }
    } finally {
      flushing = null;
    }
  });
  return flushing;
}

/** Sends `body` to `url` now, or keeps it for later behind what already
 * waits (so things arrive in order). */
export async function send(url: string, body: object): Promise<Result> {
  if (read().length) {
    await flush();
    if (read().length) {
      write([...read(), { url, body }]);
      return { status: "offline" };
    }
  }
  const result = await post({ url, body });
  if (result.status === "offline") write([...read(), { url, body }]);
  return result;
}

window.addEventListener("online", () => void flush());
