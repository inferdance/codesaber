import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@saber/ai": resolve(__dirname, "../ai/src/index.ts"),
      "@saber/tools": resolve(__dirname, "../tools/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
