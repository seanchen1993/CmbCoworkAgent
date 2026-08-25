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
      "tests/browser/**/*.test.ts",
      "src/renderer/src/components/panels/git-panel-file-tree.test.ts",
      "src/renderer/src/lib/**/*.test.ts",
      "src/renderer/src/lib/agent-git-commit-selection.test.ts",
      "src/renderer/src/components/dashboard/project-mode-export.test.ts",
      "src/renderer/src/components/update/release-notes.test.ts",
      "src/renderer/src/components/trace/TraceConversation.test.ts",
      "src/renderer/src/components/chat/chat-message-virtual-list-initial-position.test.ts",
      "src/renderer/src/components/chat/chat-scroll-regressions.test.ts",
      "src/renderer/src/components/chat/chat-scroll-runtime-harness.test.ts",
      "src/renderer/src/components/chat/chat-scroll-navigator.test.ts",
      "src/renderer/src/components/chat/chat-search-overlay.test.ts",
      "src/renderer/src/lib/chat-scroll-tail-change.test.ts",
      "src/renderer/src/lib/chat-thread-projection-cache.test.ts",
      "src/renderer/src/lib/app-catalog-cache.test.ts",
      "src/renderer/src/lib/customize-hook-catalog.test.ts",
      "src/renderer/src/lib/skill-plugin-catalog.test.ts",
      "src/renderer/src/lib/model-catalog-cache.test.ts",
      "src/renderer/src/api/market-bounded-response.test.ts",
      "src/renderer/src/api/chat-upload.test.ts",
      "src/renderer/src/lib/thread-list-reconciliation.test.ts",
      "src/renderer/src/lib/thread-directory-pagination.test.ts",
      "src/renderer/src/lib/workspace-file-tree-projection.test.ts",
      "src/renderer/src/lib/workspace-file-preview-cache.test.ts",
      "src/renderer/src/features/mentions/at-file-mention-index.test.ts",
      "src/renderer/src/features/mentions/atFileAttachments.test.ts",
      "src/renderer/src/app-route-isolation.test.ts",
      "src/renderer/src/components/panels/right-panel-skill-projection.test.ts",
      "src/renderer/src/components/panels/right-panel-render-window.test.ts",
      "src/renderer/src/components/harness-board/harness-board-cache.test.ts",
      "src/renderer/src/components/harness-board/bounded-latest-task-queue.test.ts",
      "src/renderer/src/components/harness-board/harness-board-render-window.test.ts",
      "src/renderer/src/components/harness-board/harness-settings-lazy.test.ts",
      "src/renderer/src/components/harness-board/knowledge-preview-lazy.test.ts",
      "src/renderer/src/components/tabs/file-preview-isolation.test.ts",
      "src/renderer/src/components/sidebar/thread-sidebar-window.test.ts",
      "src/renderer/src/lib/bounded-chat-search-text.test.ts",
      "src/renderer/src/lib/apple-intelligence-glow.test.ts",
      "tests/close-to-tray.spec.ts"
    ]
  }
})
