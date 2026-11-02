import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The backend the dev server passes /api and /auth to (another one for
// tools/browse_stats.mjs, which runs its own).
const backend = process.env.LIREP_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backend,
      "/auth": backend,
    },
  },
  // `vite preview` (a build, served as is: what tools/browse_stats.mjs uses,
  // so that edits made meanwhile don't reload its pages).
  preview: {
    host: "127.0.0.1",
    proxy: {
      "/api": backend,
      "/auth": backend,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        profile: resolve(__dirname, "profile.html"),
        studies: resolve(__dirname, "studies.html"),
        study: resolve(__dirname, "study.html"),
        stats: resolve(__dirname, "stats.html"),
        stat: resolve(__dirname, "stat.html"),
        about: resolve(__dirname, "about.html"),
        changelog: resolve(__dirname, "changelog.html"),
        tutorial: resolve(__dirname, "tutorial.html"),
        practice: resolve(__dirname, "practice.html"),
        community: resolve(__dirname, "community.html"),
        players: resolve(__dirname, "players.html"),
        opening: resolve(__dirname, "opening.html"),
        browse: resolve(__dirname, "browse.html"),
        forum: resolve(__dirname, "forum.html"),
        games: resolve(__dirname, "games.html"),
        player: resolve(__dirname, "player.html"),
        "practice-session": resolve(__dirname, "practice-session.html"),
        "sign-in-error": resolve(__dirname, "sign-in-error.html"),
        "doc/index": resolve(__dirname, "doc/index.html"),
        "doc/studies": resolve(__dirname, "doc/studies.html"),
        "doc/stats": resolve(__dirname, "doc/stats.html"),
        "doc/expected-score": resolve(__dirname, "doc/expected-score.html"),
        "doc/suggested-moves": resolve(__dirname, "doc/suggested-moves.html"),
        "doc/practice": resolve(__dirname, "doc/practice.html"),
        "doc/bullet": resolve(__dirname, "doc/bullet.html"),
        "doc/practice-design": resolve(__dirname, "doc/practice-design.html"),
      },
    },
  },
});
