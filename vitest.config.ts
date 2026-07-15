import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Node-only suite. Renderer-side tests would need jsdom and a separate
    // config; we don't have any yet, so keep scope narrow.
    environment: "node",
    include: ["src/main/**/*.test.ts"]
  }
})
