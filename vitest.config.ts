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
    // Node-only suite (main process + framework-free shared utils, plus a few
    // renderer tests that are pure TypeScript utilities). Renderer-side tests that
    // need jsdom would require a separate config; keep this scope narrow.
    environment: "node",
    include: [
      "src/main/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/renderer/src/components/panels/git-panel-file-tree.test.ts",
      "src/renderer/src/lib/agent-git-commit-selection.test.ts",
      "src/renderer/src/components/dashboard/active-user-export.test.ts",
      "src/renderer/src/components/dashboard/project-mode-export.test.ts",
      "src/renderer/src/components/update/release-notes.test.ts",
      "src/renderer/src/components/trace/TraceConversation.test.ts",
      "src/renderer/src/lib/apple-intelligence-glow.test.ts",
      "tests/close-to-tray.spec.ts"
    ]
  }
})
