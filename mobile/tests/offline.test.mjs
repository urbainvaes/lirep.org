import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const origin = "https://lirep.test";

function outbox() {
  const storage = new Map();
  const listeners = {};
  const context = vm.createContext({
    exports: {},
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; } },
  });
  const source = readFileSync(new URL("../src/outbox.ts", import.meta.url), "utf8");
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return { context, listeners, storage, ...context.exports };
}

test("empty startup flush does not prevent later offline/reconnect sync", async () => {
  const box = outbox();
  await box.flush();
  box.context.fetch = async () => { throw new Error("offline"); };
  assert.equal((await box.send("/attempt", { correct: true })).status, "offline");
  let sent = 0;
  box.context.fetch = async () => {
    sent += 1;
    return Response.json({});
  };
  box.listeners.online();
  await box.flush();
  assert.equal(sent, 1);
  assert.equal(box.storage.get("lirep-m-outbox"), "[]");
  // Another empty completion must release the lock too.
  await box.flush();
  box.context.fetch = async () => { throw new Error("offline"); };
  await box.send("/attempt", {});
  box.context.fetch = async () => { sent += 1; return Response.json({}); };
  await Promise.all([box.flush(), box.flush()]);
  assert.equal(sent, 2);
});

function worker() {
  const stores = new Map();
  const listeners = {};
  const key = (request) => typeof request === "string" ? new URL(request, origin).href : request.url;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        match: async (request) => entries.get(key(request))?.clone(),
        put: async (request, response) => { entries.set(key(request), response.clone()); },
        delete: async (request) => entries.delete(key(request)),
      };
    },
  };
  const context = vm.createContext({
    URL, Response, caches,
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    self: {
      location: { origin },
      addEventListener: (name, fn) => { listeners[name] = fn; },
      clients: { claim: async () => {} },
    },
  });
  vm.runInContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  async function request(path) {
    let response;
    const background = [];
    listeners.fetch({
      request: new Request(origin + path),
      respondWith: (promise) => { response = promise; },
      waitUntil: (promise) => { background.push(promise); },
    });
    const result = await response;
    await Promise.all(background);
    return result;
  }
  return { context, caches, stores, listeners, request };
}

test("worker never intercepts credentials or unknown API endpoints", async () => {
  const sw = worker();
  sw.context.fetch = () => { throw new Error("should not be intercepted"); };
  assert.equal(await sw.request("/api/lichess-token"), undefined);
  assert.equal(await sw.request("/api/future-private-endpoint"), undefined);
  assert.equal(sw.stores.size, 0);
});

test("no-store answers are not cached and invalidate an older cached copy", async () => {
  const sw = worker();
  sw.context.fetch = async () => Response.json([{ id: 1 }]);
  await sw.request("/api/studies");
  const data = [...sw.stores.values()][0];
  assert.equal(data.size, 1);
  sw.context.fetch = async () => Response.json([{ id: 2 }], { headers: { "Cache-Control": "private, no-store" } });
  assert.deepEqual(await (await sw.request("/api/studies")).json(), [{ id: 2 }]);
  assert.equal(data.size, 0);
  sw.context.fetch = async () => { throw new Error("offline"); };
  assert.equal((await sw.request("/api/studies")).type, "error");
});

test("signed-out me and 401 clear data, while ordinary data still works offline", async () => {
  for (const signedOut of [Response.json({ authenticated: false }), new Response(null, { status: 401 })]) {
    const sw = worker();
    sw.context.fetch = async () => Response.json([{ id: 1 }]);
    await sw.request("/api/studies");
    sw.context.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await (await sw.request("/api/studies")).json(), [{ id: 1 }]);
    sw.context.fetch = async () => signedOut.clone();
    await sw.request("/api/me");
    sw.context.fetch = async () => { throw new Error("offline"); };
    assert.equal((await sw.request("/api/studies")).type, "error");
    assert.equal((await sw.request("/api/me")).type, "error");
    // Verified sign-in permits caching again.
    sw.context.fetch = async () => Response.json({ authenticated: true });
    await sw.request("/api/me");
    sw.context.fetch = async () => Response.json([{ id: 2 }]);
    await sw.request("/api/studies");
    sw.context.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await (await sw.request("/api/studies")).json(), [{ id: 2 }]);
  }
});

test("late private responses cannot repopulate data after sign-out", async () => {
  const sw = worker();
  let resolve;
  const started = new Promise((done) => {
    sw.context.fetch = () => { done(); return new Promise((ready) => { resolve = ready; }); };
  });
  const pending = sw.request("/api/studies");
  await started;
  sw.context.fetch = async () => Response.json({ authenticated: false });
  await sw.request("/api/me");
  resolve(Response.json([{ id: 1 }]));
  await pending;
  sw.context.fetch = async () => { throw new Error("offline"); };
  assert.equal((await sw.request("/api/studies")).type, "error");
});

test("activation removes old caches, including previously cached tokens", async () => {
  const sw = worker();
  const old = await sw.caches.open("lirep-m-data-1");
  await old.put("/api/lichess-token", Response.json({ token: "dummy" }));
  await new Promise((resolve, reject) => sw.listeners.activate({ waitUntil: (p) => p.then(resolve, reject) }));
  assert.equal(sw.stores.has("lirep-m-data-1"), false);
});
