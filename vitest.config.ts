import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Node-only suite. Renderer-side tests would need jsdom and a separate
    // config; keep scope narrow and include only renderer tests that are pure
    // TypeScript utilities.
    environment: "node",
    include: ["src/main/**/*.test.ts", "src/renderer/src/components/panels/git-panel-file-tree.test.ts"]
  }
})
