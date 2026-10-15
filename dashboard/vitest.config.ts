import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./tests/tasks-setup.ts"] },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian-runtime.ts", import.meta.url)),
    },
  },
});
