import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@saber/ai": fileURLToPath(new URL("../ai/src/index.ts", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"] },
});
