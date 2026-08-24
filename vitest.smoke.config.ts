import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Real-model smoke lane — opt-in, not part of `pnpm test`.
// Requires an API key in the environment (skips otherwise):
//   SABER_ANTHROPIC_KEY=... [SABER_SMOKE_MODEL=...] pnpm test:smoke
export default defineConfig({
  resolve: {
    alias: {
      "@saber/ai": fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
      "@saber/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/cli/src/__tests__/**/*.e2e.ts"], timeout: 180_000 },
});
