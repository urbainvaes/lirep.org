import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The mobile app, served at /m/ next to the website. It shares the
// website's logic (frontend/src, as "@web/…"): the board, the practice
// walk's tree helpers, the badges. Its libraries come from here only, so
// the shared modules don't bring a second copy of chess.js or chessground.
export default defineConfig({
  base: "/m/",
  resolve: {
    alias: { "@web": fileURLToPath(new URL("../frontend/src", import.meta.url)) },
    dedupe: ["chess.js", "@lichess-org/chessground"],
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/auth": "http://127.0.0.1:8000",
      // The site's own files the app uses: its fonts and icons.
      "^/(fonts|icon-|apple-touch-icon|favicon)": "http://127.0.0.1:5173",
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
