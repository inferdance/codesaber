import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@saber/ai": "../ai/src/index.ts" } },
  test: { include: ["src/**/*.test.ts"] },
});
