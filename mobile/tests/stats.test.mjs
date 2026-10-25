import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function screens(study) {
  const modules = new Map();
  const api = {
    study: async () => study,
    studies: async () => [study],
    practiceSummary: async () => ({}),
  };
  function load(name) {
    if (name === "./api") return api;
    if (name === "@web/layout") return {
      escapeHtml: (value) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    };
    if (modules.has(name)) return modules.get(name);
    const file = name === "@web/scoreTiers"
      ? new URL("../../frontend/src/scoreTiers.ts", import.meta.url)
      : new URL(`../src/${name.slice(2)}.ts`, import.meta.url);
    const exports = {};
    const source = readFileSync(file, "utf8");
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports, require: load,
    });
    modules.set(name, exports);
    return exports;
  }
  return { lists: load("./lists"), stats: load("./stats"), api };
}

function fixture() {
  return {
    id: 42, name: "My <opening>", side: "black", movesFingerprint: "current",
    tree: { rootId: 0, nodes: {
      0: { id: 0, children: [1] },
      1: { id: 1, children: [] },
    } },
    stats: {
      winProbability: 0.54, evalCp: 40, evalDepth: 12,
      winProbabilityMovesFingerprint: "current", evalMovesFingerprint: "current",
      winProbabilityCalculatedAt: "2026-10-26T10:00:00+00:00",
      evalCalculatedAt: "2026-10-25T09:00:00+00:00",
      source: "lichess", database: "lichess", minRating: 1800, speeds: ["rapid"],
      evalSettings: { source: "lirep", database: "lichess", minRating: 2000, speeds: ["blitz"] },
    },
  };
}

test("Studies opens stats via row and chart; Practice keeps practice and Bullet", async () => {
  const { lists } = screens(fixture());
  const app = { innerHTML: "" };
  await lists.renderStudies(app);
  assert.equal((app.innerHTML.match(/href="#\/stats\/42"/g) ?? []).length, 2);
  assert.match(app.innerHTML, /aria-label="Stats for My &lt;opening&gt;"/);
  assert.doesNotMatch(app.innerHTML, /#\/bullet\/42|#\/practice\/42/);
  await lists.renderPracticeList(app);
  assert.match(app.innerHTML, /href="#\/practice\/42"/);
  assert.match(app.innerHTML, /href="#\/bullet\/42"/);
  assert.doesNotMatch(app.innerHTML, /#\/stats\/42/);
});

test("stats shows saved results, unambiguous Black evaluation and website actions", async () => {
  const { stats } = screens(fixture());
  const app = { innerHTML: "" };
  await stats.renderStats(app, 42);
  assert.match(app.innerHTML, /My &lt;opening&gt;/);
  assert.match(app.innerHTML, /54\.0%/);
  assert.match(app.innerHTML, /−0\.40/);
  assert.match(app.innerHTML, /Black is better/);
  assert.match(app.innerHTML, /aria-label="Gold Knight"/);
  assert.match(app.innerHTML, /piece-badge--gold/);
  for (const href of ["/stat.html?id=42", "/study.html?id=42", "#/practice/42"]) {
    assert.ok(app.innerHTML.includes(`href="${href}"`));
  }
  assert.match(app.innerHTML, /Back to Studies/);
  assert.doesNotMatch(app.innerHTML, /Out of date|Freshness unknown/);
});

test("calculated dates expand independent saved settings, with depth hidden initially", async () => {
  const { stats } = screens(fixture());
  const app = { innerHTML: "" };
  await stats.renderStats(app, 42);
  const cards = [...app.innerHTML.matchAll(/<section class="stats__card">([\s\S]*?)<\/section>/g)].map((match) => match[1]);
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.match(card, /<details class="stats__details">\s*<summary>Calculated <time/);
    assert.doesNotMatch(card, /<details[^>]*\bopen\b/);
  }
  assert.match(cards[0], /<dd>Lichess<\/dd>/);
  assert.match(cards[0], /<dd>1800<\/dd>/);
  assert.match(cards[0], /<dd>rapid<\/dd>/);
  assert.match(cards[1], /<dd>Lirep \(2016 sample\)<\/dd>/);
  assert.match(cards[1], /<dd>2000<\/dd>/);
  assert.match(cards[1], /<dt>Stockfish depth<\/dt><dd>12<\/dd>/);
  assert.doesNotMatch(cards[1].split("<details")[0], /Stockfish|depth/);
});

test("missing results are distinct from zero and stale results are labeled independently", async () => {
  const study = fixture();
  const { stats } = screens(study);
  const app = { innerHTML: "" };
  study.stats = null;
  await stats.renderStats(app, 42);
  assert.equal((app.innerHTML.match(/Not calculated yet/g) ?? []).length, 2);
  study.stats = { winProbability: 0, evalCp: 0, winProbabilityMovesFingerprint: "old" };
  await stats.renderStats(app, 42);
  assert.match(app.innerHTML, /0\.0%/);
  assert.match(app.innerHTML, /Equal position/);
  assert.match(app.innerHTML, /Out of date/);
  assert.match(app.innerHTML, /Freshness unknown/);
  assert.doesNotMatch(app.innerHTML, /Not calculated yet/);
});

test("late stats loads do not overwrite a newer route", async () => {
  const { stats, api } = screens(fixture());
  let resolve;
  api.study = () => new Promise((done) => { resolve = done; });
  const app = { innerHTML: "New screen" };
  const pending = stats.renderStats(app, 42, () => false);
  resolve(fixture());
  await pending;
  assert.equal(app.innerHTML, "New screen");
});
