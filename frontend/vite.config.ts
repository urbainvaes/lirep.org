import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/auth": "http://127.0.0.1:8000",
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
        practice: resolve(__dirname, "practice.html"),
        community: resolve(__dirname, "community.html"),
        players: resolve(__dirname, "players.html"),
        opening: resolve(__dirname, "opening.html"),
        forum: resolve(__dirname, "forum.html"),
        player: resolve(__dirname, "player.html"),
        "practice-session": resolve(__dirname, "practice-session.html"),
        "sign-in-error": resolve(__dirname, "sign-in-error.html"),
        "doc/index": resolve(__dirname, "doc/index.html"),
        "doc/studies": resolve(__dirname, "doc/studies.html"),
        "doc/stats": resolve(__dirname, "doc/stats.html"),
        "doc/practice": resolve(__dirname, "doc/practice.html"),
        "doc/practice-design": resolve(__dirname, "doc/practice-design.html"),
      },
    },
  },
});
