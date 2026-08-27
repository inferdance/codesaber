import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Root-level config so `pnpm test` resolves workspace packages to source
// (no dist required). Package-level configs mirror these aliases.
export default defineConfig({
  resolve: {
    alias: {
      "@saber/ai": fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
      "@saber/core/hook": fileURLToPath(new URL("./packages/core/src/hook.ts", import.meta.url)),
      "@saber/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
});
