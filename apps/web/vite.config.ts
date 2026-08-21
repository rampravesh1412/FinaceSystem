import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(here, "./src") },
  },
  server: {
    port: 5173,
    // The API is proxied under /api so the browser sees one origin in development. That
    // makes the SameSite=Strict refresh cookie behave exactly as it will in production
    // behind a single domain — a cross-origin dev setup would silently drop it and send
    // everyone chasing a bug that does not exist in the deployed app.
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
    // The shell legitimately exceeds the 500 kB default and the warning is noise once
    // that is a considered position rather than an oversight. Raised, not silenced: a
    // chunk above this is still something to look at.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Only React is pinned to its own chunk.
         *
         * Everything else splits by where it is actually imported, because forcing a
         * manual chunk had the opposite effect of the one intended: naming `recharts`
         * created a `charts` chunk, and a module shared between Recharts and the shell
         * landed inside it — so the ENTRY ended up statically importing the chart chunk
         * and `index.html` preloaded 384 kB of charting library before the login form
         * could be typed into.
         *
         * With the dashboard and the P&L both lazily loaded (see `router.tsx`), rollup
         * derives the same split on its own and gets the direction of the dependency
         * right. React stays pinned because it genuinely is in every graph and pinning it
         * keeps it cached across deploys.
         *
         * `zod`, `react-hook-form` and `@tanstack/react-query` were tried as chunks too
         * and rollup merged every one back into the entry: `@amiri/shared` re-exports the
         * Zod schemas and the auth provider needs the query client, so they are in the
         * shell's critical path rather than optional. Splitting them means splitting the
         * shared barrel so type-only consumers stop pulling the runtime schemas in —
         * worth doing, not worth pretending is done.
         */
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          /**
           * `clsx` and `tailwind-merge` are pinned deliberately, small as they are.
           *
           * Every `cn()` in the shell uses them, and Recharts uses clsx too. Left to
           * itself rollup put clsx inside the Recharts chunk — so the entry statically
           * imported one 500-byte helper from a 384 kB chunk, and `index.html` preloaded
           * the whole charting library before the login form could be typed into. Pinning
           * them into a chunk the shell owns breaks that edge.
           */
          styling: ["clsx", "tailwind-merge", "class-variance-authority"],
        },
      },
    },
  },
});
