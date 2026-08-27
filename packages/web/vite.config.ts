import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // browser-safe slice only — never the barrel (it pulls Node-only
      // engine/tools into the bundle via execa)
      "@saber/ui-shared/hook": fileURLToPath(new URL("../ui-shared/src/hook.ts", import.meta.url)),
      "@saber/ui-shared": fileURLToPath(new URL("../ui-shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3080",
      "/ws": { target: "ws://127.0.0.1:3080", ws: true },
    },
  },
  build: { outDir: "dist" },
});
