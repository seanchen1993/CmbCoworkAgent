import { resolve } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"

// Keep the original collection scope shared by both scheduling projects.
export const VITEST_TEST_INCLUDE = [
  "src/main/**/*.test.ts",
  "src/preload/**/*.test.ts",
  "src/shared/**/*.test.ts",
  "tests/browser/**/*.test.ts",
  "src/renderer/src/components/panels/git-panel-file-tree.test.ts",
  "src/renderer/src/components/customize/development-creation-setup.test.ts",
  "src/renderer/src/components/customize/development-trial-view.test.ts",
  "src/renderer/src/components/customize/development-reuse-receipts.test.ts",
  "src/renderer/src/components/customize/creator-journey-view.test.ts",
  "src/renderer/src/components/customize/creator-project-route.test.ts",
  "src/renderer/src/components/customize/project-delivery-view.test.ts",
  "src/renderer/src/lib/**/*.test.ts",
  "src/renderer/src/lib/agent-git-commit-selection.test.ts",
  "src/renderer/src/components/dashboard/active-user-export.test.ts",
  "src/renderer/src/components/dashboard/project-mode-export.test.ts",
  "src/renderer/src/components/dashboard/panels/project-mode-table-columns.test.ts",
  "src/renderer/src/components/dashboard/project-stage-analysis-view.test.ts",
  "src/renderer/src/components/dashboard/thread-traces-response.test.ts",
  "src/renderer/src/components/dashboard/trace-export-scope.test.ts",
  "src/renderer/src/components/update/release-notes.test.ts",
  "src/renderer/src/components/trace/TraceConversation.test.ts",
  "src/renderer/src/components/chat/chat-message-virtual-list-initial-position.test.ts",
  "src/renderer/src/components/chat/chat-scroll-regressions.test.ts",
  "src/renderer/src/components/chat/chat-scroll-runtime-harness.test.ts",
  "src/renderer/src/components/chat/chat-scroll-navigator.test.ts",
  "src/renderer/src/components/chat/chat-virtual-window.test.ts",
  "src/renderer/src/components/chat/chat-search-overlay.test.ts",
  "src/renderer/src/components/chat/reasoning-expansion-context.test.ts",
  "src/renderer/src/lib/chat-scroll-tail-change.test.ts",
  "src/renderer/src/lib/chat-thread-projection-cache.test.ts",
  "src/renderer/src/lib/app-catalog-cache.test.ts",
  "src/renderer/src/lib/customize-hook-catalog.test.ts",
  "src/renderer/src/lib/skill-plugin-catalog.test.ts",
  "src/renderer/src/lib/model-catalog-cache.test.ts",
  "src/renderer/src/api/market-bounded-response.test.ts",
  "src/renderer/src/api/chat-upload.test.ts",
  "src/renderer/src/api/backend-endpoint.test.ts",
  "src/renderer/src/api/backend-endpoint-integration.test.ts",
  "src/renderer/src/components/chat/chat-report-backend-retry.test.ts",
  "src/renderer/src/components/chat/remote-catalog-failure.test.ts",
  "src/renderer/src/lib/thread-list-reconciliation.test.ts",
  "src/renderer/src/lib/thread-directory-pagination.test.ts",
  "src/renderer/src/lib/workspace-file-tree-projection.test.ts",
  "src/renderer/src/lib/workspace-file-preview-cache.test.ts",
  "src/renderer/src/features/mentions/at-file-mention-index.test.ts",
  "src/renderer/src/features/mentions/useAtFileMentions.test.ts",
  "src/renderer/src/features/mentions/atFileAttachments.test.ts",
  "src/renderer/src/features/slash-commands/*.test.ts",
  "src/renderer/src/app-route-isolation.test.ts",
  "src/renderer/src/components/panels/right-panel-skill-projection.test.ts",
  "src/renderer/src/components/panels/right-panel-render-window.test.ts",
  "src/renderer/src/components/harness-board/harness-board-cache.test.ts",
  "src/renderer/src/components/harness-board/project-capability-controller.test.ts",
  "src/renderer/src/components/harness-board/project-runtime-message.test.ts",
  "src/renderer/src/components/harness-board/project-check-diagnostics.test.ts",
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

export const NATIVE_INTEGRATION_TESTS = [
  "src/main/agent/function-conversation-native-host.test.ts",
  "src/main/agent/function-conversation-native-keeper.test.ts",
  "src/main/agent/native-derived-config.integration.test.ts",
  "src/main/agent/native-shared-derived-config.integration.test.ts",
  "src/main/harness-board/project-runtime/composition-host-adapter.test.ts",
  "src/main/mods/v2/conversation-shared-native-host.test.ts",
  "src/main/mods/devtools/project-stage-debug.test.ts",
  "src/main/mods/devtools/creator-source-set.integration.test.ts",
  "src/main/plugins/autobiz-native-host.integration.test.ts",
  "src/main/plugins/autobiz-native-code.integration.test.ts",
  "src/main/plugins/autobiz-native-performance.integration.test.ts",
  "src/main/plugins/autobiz-native-multirepo.integration.test.ts"
]

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@renderer": resolve(__dirname, "src/renderer/src")
    }
  },
  test: {
    // Preserve the Node-only suite and command-line file/name filters. These
    // native graph/OS suites need exclusive CPU while retaining their original time limits.
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "native-integration",
          include: NATIVE_INTEGRATION_TESTS,
          pool: "forks",
          poolOptions: { forks: { singleFork: true, isolate: true } },
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: {
          name: "parallel",
          include: VITEST_TEST_INCLUDE,
          exclude: [...configDefaults.exclude, ...NATIVE_INTEGRATION_TESTS],
          sequence: { groupOrder: 1 }
        }
      }
    ]
  }
})
