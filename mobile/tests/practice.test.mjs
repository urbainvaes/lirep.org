import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const DAY = 86_400_000;

function transpile(name) {
  const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
}

function rules() {
  const exports = {};
  vm.runInNewContext(transpile("practiceQueue"), { exports });
  return exports;
}

const iso = (ms) => new Date(ms).toISOString();

test("answers update the streak and stability as the server does", () => {
  const { applyAnswer } = rules();
  assert.deepEqual({ ...applyAnswer(undefined, true) }, { streak: 1, tauDays: 1 });
  assert.deepEqual({ ...applyAnswer(undefined, false) }, { streak: 0, tauDays: 1 });
  const prev = { streak: 2, tauDays: 2, lastSeenAt: iso(0) };
  assert.deepEqual({ ...applyAnswer(prev, true) }, { streak: 3, tauDays: 4 });
  assert.deepEqual({ ...applyAnswer({ ...prev, streak: 3 }, true) }, { streak: 3, tauDays: 4 });
  assert.deepEqual({ ...applyAnswer(prev, false) }, { streak: 0, tauDays: 1 });
});

test("the queue: due first, longest unseen first, then new ones in tree order", () => {
  const { buildQueue } = rules();
  const now = 100 * DAY;
  const states = {
    1: { streak: 1, tauDays: 1, lastSeenAt: iso(now - 2 * DAY) }, // due
    2: { streak: 1, tauDays: 1, lastSeenAt: iso(now - 3 * DAY) }, // due, older
    3: { streak: 3, tauDays: 8, lastSeenAt: iso(now - DAY) }, // not due
  };
  const queue = buildQueue([1, 2, 3, 5, 4], states, now);
  assert.deepEqual([...queue.nodeIds], [2, 1, 5, 4]);
  assert.equal(queue.optional, false);
});

test("with nothing due or new, optional review of what isn't at 100%", () => {
  const { buildQueue } = rules();
  const now = 100 * DAY;
  // Microseconds, as the server writes them.
  const states = {
    1: { streak: 3, tauDays: 64, lastSeenAt: iso(now - 1000).replace("Z", "123+00:00") }, // 100%
    2: { streak: 1, tauDays: 1, lastSeenAt: iso(now - 2000) },
    3: { streak: 2, tauDays: 2, lastSeenAt: iso(now - 5000) },
  };
  const queue = buildQueue([1, 2, 3], states, now);
  assert.deepEqual([...queue.nodeIds], [3, 2]);
  assert.equal(queue.optional, true);
  assert.deepEqual([...buildQueue([1], states, now).nodeIds], [1]);
});

function api() {
  const storage = new Map();
  const context = {
    exports: {},
    Date,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    online: true,
    sent: [],
  };
  context.require = (name) => {
    if (name === "./practiceQueue") return rules();
    if (name === "./outbox") {
      return {
        send: async (url, body) => {
          if (!context.online) return { status: "offline" };
          context.sent.push(body);
          return { status: "sent", data: { streak: 1, tauDays: 1, knowledge: 1 / 3 } };
        },
      };
    }
    return {};
  };
  vm.runInNewContext(transpile("api"), context);
  return context;
}

test("offline, a round after the kept queue: the positions left, the streaks known", async () => {
  const now = Date.now();
  const ctx = api();
  // The copy the service worker kept: 1 known well, 2 and 3 new.
  const copy = {
    nodeIds: [2, 3],
    optional: false,
    items: [1, 2, 3, 4],
    states: { 1: { streak: 2, tauDays: 8, lastSeenAt: iso(now - DAY) } },
  };
  ctx.fetch = async () => Response.json(copy);
  ctx.online = false;
  const first = await ctx.exports.practiceQueue(7);
  assert.deepEqual([...first.nodeIds], [2, 3]);

  const answer = await ctx.exports.recordAttempt(7, 2, true);
  assert.equal(answer.later, true);
  assert.equal(answer.streak, 1);
  await ctx.exports.recordAttempt(7, 3, false);

  // The same copy again: 2 and 3 were answered since, 4 is still new.
  const next = await ctx.exports.practiceQueue(7);
  assert.deepEqual([...next.nodeIds], [4]);
  assert.equal(next.optional, false);

  // Answering 1 builds on its kept state.
  assert.equal((await ctx.exports.recordAttempt(7, 1, true)).streak, 3);

  // Online again, a copy that has the answers: the server's queue, and
  // the answers made here forgotten.
  ctx.online = true;
  const fresh = {
    nodeIds: [9],
    optional: true,
    items: [1, 2, 3, 4],
    states: Object.fromEntries(
      Object.entries(JSON.parse(ctx.localStorage.getItem("lirep-m-practice"))["7"]).map(([node, state]) => [
        node,
        { ...state, lastSeenAt: state.lastSeenAt.replace("Z", "000+00:00") },
      ]),
    ),
  };
  ctx.fetch = async () => Response.json(fresh);
  const served = await ctx.exports.practiceQueue(7);
  assert.deepEqual([...served.nodeIds], [9]);
  assert.equal(ctx.localStorage.getItem("lirep-m-practice"), "{}");
});
