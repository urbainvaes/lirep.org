#!/usr/bin/env node
// The Browse page's openings' stats (frontend/public/openings/stats.json),
// calculated by the site's own Stats page, in a headless browser, so they
// are exactly what a study's Stats page would give:
//
//   expected score       Lichess's explorer, blitz games, ratings 1600+,
//                        lines' ends valued with the explorer's results
//   expected evaluation  Stockfish, depth 16
//
// It runs its own backend (on a database of its own, which keeps the
// explorer's answers between runs) and a build of the site, made at the
// start (edits made meanwhile change nothing), signs in with a
// Lichess token (LICHESS_TOKEN, or ~/.config/lirep/lichess-token: create one,
// with no scope, at https://lichess.org/account/oauth/token), imports each
// opening as the Browse page's Import does, sets the settings, presses the
// Stats page's Recalculate and waits for both results. A run takes a while:
// the explorer is asked for every position, Stockfish evaluates every line's
// end. stats.json is written after each opening, and so are the explorer's
// answers with these settings, to backend/app/data/explorer-seed.json, which
// the backend puts in its shared cache at startup (backend/app/cache.py).
//
//   node tools/browse_stats.mjs                 every opening
//   node tools/browse_stats.mjs italian french  only these (by slug)
//   node tools/browse_stats.mjs --export        only the explorer's answers
//
// Needs Chromium (CHROMIUM, default /usr/bin/chromium), the backend's
// virtualenv (backend/.venv) and the frontend's packages (npm install).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = join(ROOT, "frontend");
const BACKEND = join(ROOT, "backend");
const OPENINGS = join(FRONTEND, "public", "openings");
const STATS_FILE = join(OPENINGS, "stats.json");
const SEED_FILE = join(BACKEND, "app", "data", "explorer-seed.json");
const { chromium } = createRequire(join(FRONTEND, "package.json"))("playwright-core");

/** The settings every opening is calculated with. */
const SETTINGS = {
  enabled: true,
  source: "lichess",
  database: "lichess",
  player: null,
  minRating: 1600,
  speeds: ["blitz"],
  leafValue: "explorer",
  depth: 16,
};
const BACKEND_PORT = 8765;
const VITE_PORT = 5199;
const USERNAME = "lirep-browse-stats";
// An opening that takes longer than this has failed.
const TIMEOUT_MS = 6 * 3600_000;

const DATA = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "lirep", "browse-stats");
mkdirSync(DATA, { recursive: true });

function token() {
  if (process.env.LICHESS_TOKEN) return process.env.LICHESS_TOKEN.trim();
  const file = join(homedir(), ".config", "lirep", "lichess-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error("No Lichess token: set LICHESS_TOKEN, or put one in ~/.config/lirep/lichess-token.");
}

const log = (...args) => console.log(new Date().toTimeString().slice(0, 8), ...args);

/** Starts a server in a process group of its own (so that stopping it
 * stops what it started, as npx's Vite), its output in `logFile`; resolves
 * once its output matches `ready`. */
function start(command, args, options, ready, logFile) {
  writeFileSync(logFile, "");
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  return new Promise((resolve, reject) => {
    const onData = (data) => {
      appendFileSync(logFile, data);
      output += data;
      if (ready.test(output)) resolve(child);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`${command} exited (${code}):\n${output}`)));
  });
}

/** Starlette's session cookie, signed as its SessionMiddleware does. */
function sessionCookie(secret, session) {
  const python = join(BACKEND, ".venv", "bin", "python");
  const result = spawnSync(python, ["-c", `
import base64, json, sys
from itsdangerous import TimestampSigner
data = base64.b64encode(json.dumps(json.loads(sys.argv[2])).encode())
print(TimestampSigner(sys.argv[1]).sign(data).decode())
`, secret, JSON.stringify(session)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function readStats() {
  if (!existsSync(STATS_FILE)) return { version: 1, settings: SETTINGS, openings: {} };
  return JSON.parse(readFileSync(STATS_FILE, "utf8"));
}

/** The explorer's answers with SETTINGS kept by this script's backend, to
 * SEED_FILE: sorted, one a line. */
function exportExplorerAnswers() {
  const python = join(BACKEND, ".venv", "bin", "python");
  const result = spawnSync(python, ["-c", `
import json, sqlite3, sys
db, prefix, out = sys.argv[1:]
rows = sqlite3.connect(db).execute(
    "SELECT key, data, fetched_at FROM server_explorer_cache WHERE key LIKE ? ORDER BY key", (prefix + "%",)
).fetchall()
lines = [json.dumps({"key": k, "data": json.loads(d), "fetchedAt": f}, separators=(",", ":")) for k, d, f in rows]
with open(out, "w") as f:
    f.write('{"entries": [' + chr(10) + ("," + chr(10)).join(lines) + chr(10) + "]}" + chr(10))
print(len(rows))
`, join(DATA, "lirep.db"), explorerKeyPrefix(), SEED_FILE], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  log(`Explorer answers: ${result.stdout.trim()} in ${SEED_FILE.slice(ROOT.length + 1)}`);
}

/** The browser cache's key for SETTINGS, without the FEN
 * (explorerClient.ts's cacheKey): the rating buckets from minRating up. */
function explorerKeyPrefix() {
  const buckets = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].filter((b) => b >= SETTINGS.minRating);
  return `${SETTINGS.database}|${buckets.join(",")}|${SETTINGS.speeds.join(",")}|`;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Whether nothing listens on `port` yet (a server left from an earlier run
 * would answer in place of this run's). */
function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function main() {
  if (process.argv[2] === "--export") return exportExplorerAnswers();
  const only = process.argv.slice(2);
  const index = JSON.parse(readFileSync(join(OPENINGS, "index.json"), "utf8")).openings;
  const unknown = only.filter((slug) => !index.some((o) => o.slug === slug));
  if (unknown.length) throw new Error(`Unknown openings: ${unknown.join(", ")}`);
  const openings = only.length ? index.filter((o) => only.includes(o.slug)) : index;

  for (const port of [BACKEND_PORT, VITE_PORT]) {
    if (!(await portFree(port))) throw new Error(`Port ${port} is in use (a server left from an earlier run?): stop it first.`);
  }
  const secret = randomBytes(32).toString("hex");
  const env = { ...process.env, LIREP_DB_PATH: join(DATA, "lirep.db"), SESSION_SECRET: secret };
  log("Building the site…");
  const dist = join(DATA, "dist");
  const build = spawnSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: FRONTEND, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`The build failed:\n${build.stdout}${build.stderr}`);
  log("Starting the backend and the site…");
  const backend = await start(join(BACKEND, ".venv", "bin", "python"),
    ["-m", "uvicorn", "app.main:app", "--port", String(BACKEND_PORT)], { cwd: BACKEND, env }, /Uvicorn running/,
    join(DATA, "backend.log"));
  const vite = await start("npx", ["vite", "preview", "--outDir", dist, "--port", String(VITE_PORT), "--strictPort"],
    { cwd: FRONTEND, env: { ...process.env, LIREP_BACKEND: `http://127.0.0.1:${BACKEND_PORT}` } }, /Local:/,
    join(DATA, "vite.log"));
  const stop = (child) => {
    try {
      process.kill(-child.pid);
    } catch {
      // Gone already.
    }
  };
  // Whatever happens, the servers stop with the script, interrupted too.
  process.on("exit", () => [backend, vite].forEach(stop));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(130));
  const origin = `http://127.0.0.1:${VITE_PORT}`;

  const context = await chromium.launchPersistentContext(join(DATA, "browser"), {
    executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  try {
    await context.addCookies([{
      name: "session",
      value: sessionCookie(secret, { username: USERNAME, access_token: token() }),
      domain: "127.0.0.1",
      path: "/",
    }]);
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (error) => log("page error:", error.message));
    const api = (path, init) => page.evaluate(async ([path, init]) => {
      const res = await fetch(path, { credentials: "same-origin", ...init });
      if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return res.status === 204 ? null : res.json();
    }, [path, init]);

    await page.goto(`${origin}/browse.html`, { waitUntil: "networkidle" });
    let me;
    for (let attempt = 1; ; attempt++) {
      try {
        me = await api("/api/me");
        break;
      } catch (error) {
        if (attempt === 5) throw new Error(`${error.message} (see ${DATA}/backend.log and vite.log)`);
        await page.waitForTimeout(2000);
      }
    }
    if (!me.authenticated) throw new Error("Not signed in.");

    const stats = readStats();
    stats.settings = SETTINGS;
    for (const opening of openings) {
      log(`${opening.name}: importing`);
      // A study left from an earlier run goes: imported afresh, it has the
      // file's current moves.
      for (const study of await api("/api/studies")) {
        if (study.name === opening.name) await api(`/api/studies/${study.id}`, { method: "DELETE" });
      }
      await page.goto(`${origin}/browse.html`, { waitUntil: "networkidle" });
      await page.click(`[data-import="${opening.slug}"]`);
      const link = page.locator('a[href^="/study.html?id="]').first();
      await link.waitFor({ timeout: 30_000 });
      const id = Number(new URL(await link.getAttribute("href"), origin).searchParams.get("id"));
      await api(`/api/studies/${id}/explorer-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(SETTINGS),
      });

      await page.goto(`${origin}/stat.html?id=${id}`, { waitUntil: "networkidle" });
      await page.locator("#recalc-all:not([disabled])").waitFor({ timeout: 60_000 });
      await page.click("#recalc-all");
      log(`${opening.name}: calculating`);
      const started = Date.now();
      let result;
      let lastProgress = "";
      let lastLogged = 0;
      for (;;) {
        await page.waitForTimeout(15_000);
        const study = await api(`/api/studies/${id}`);
        const s = study.stats ?? {};
        const scored = s.winProbability != null && s.winProbabilityMovesFingerprint === study.movesFingerprint;
        const evaluated = s.evalCp != null && s.evalDepth === SETTINGS.depth && s.evalMovesFingerprint === study.movesFingerprint;
        // The page's progress, logged when it changes (at most once a minute);
        // an error there ends the run.
        const progress = await page.evaluate(() => ["score", "eval"].map((id) => {
          const label = document.getElementById(`${id}-progress-label`);
          const shown = label && !document.getElementById(`${id}-progress`)?.hidden;
          return shown ? { id, text: label.textContent.trim(), error: label.classList.contains("progress-bar__label--error") } : null;
        }).filter(Boolean));
        const failed = progress.find((p) => p.error);
        if (failed) throw new Error(`${opening.name}: ${failed.id}: ${failed.text}`);
        const text = progress.map((p) => `${p.id}: ${p.text}`).join("; ");
        if (text && text !== lastProgress && Date.now() - lastLogged > 60_000) {
          log(`${opening.name}: ${text}`);
          lastProgress = text;
          lastLogged = Date.now();
        }
        if (scored && evaluated) {
          result = s;
          break;
        }
        if (Date.now() - started > TIMEOUT_MS) throw new Error(`${opening.name}: not done after ${TIMEOUT_MS / 3600_000} h`);
      }
      stats.openings[opening.slug] = {
        file: sha256(join(OPENINGS, opening.file)),
        winProbability: result.winProbability,
        evalCp: result.evalCp,
        evalDepth: result.evalDepth,
        scoreCalculatedAt: result.winProbabilityCalculatedAt,
        evalCalculatedAt: result.evalCalculatedAt,
      };
      writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2) + "\n");
      exportExplorerAnswers();
      log(`${opening.name}: expected score ${(result.winProbability * 100).toFixed(1)}%, `
        + `expected evaluation ${(result.evalCp / 100).toFixed(2)} (for ${opening.side})`);
    }
  } finally {
    await context.close();
    stop(backend);
    stop(vite);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
