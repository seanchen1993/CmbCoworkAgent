import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@renderer": resolve(__dirname, "src/renderer/src")
    }
  },
  test: {
    // Node-only suite. Renderer-side tests would need jsdom and a separate
    // config; we don't have any yet, so keep scope narrow.
    environment: "node",
    include: ["src/main/**/*.test.ts"]
  }
})
