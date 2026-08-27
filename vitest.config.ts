import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Root-level config so `pnpm test` resolves workspace packages to source
// (no dist required). Package-level configs mirror these aliases.
export default defineConfig({
  resolve: {
    alias: {
      "@saber/ai": fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
      "@saber/ui-shared/hook": fileURLToPath(new URL("./packages/ui-shared/src/hook.ts", import.meta.url)),
      "@saber/ui-shared": fileURLToPath(new URL("./packages/ui-shared/src/index.ts", import.meta.url)),
      "@saber/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@saber/sandbox": fileURLToPath(new URL("./packages/sandbox/src/index.ts", import.meta.url)),
    },
  },
});
