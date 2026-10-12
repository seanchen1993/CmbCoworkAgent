// Portable launcher: the same browser gates run locally and under CI's Xvfb.
// The fixtures use installed Chrome (macOS/Linux) or Edge (Windows), and never
// require model credentials or change the user's Bot data.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
if (process.argv.length > 2) {
  console.log(
    "Usage: node tests/run-bot-browser.mjs\nRequires installed Chrome (macOS/Linux) or Edge (Windows)."
  )
  process.exit(process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2]) ? 0 : 1)
}
const directory = mkdtempSync(join(tmpdir(), "bot-browser-report-"))
const report = join(directory, "results.json")
const stages = [
  {
    name: "Browser ownership, virtual measurements, task paging and profile restore",
    args: [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/renderer/src/lib/use-bot-transcript-scroll.test.ts",
      "src/renderer/src/lib/use-bot-transcript-scroll.browser.test.ts",
      "src/renderer/src/lib/bot-virtual-window.test.ts",
      "src/renderer/src/lib/bot-conversation-tasks.test.ts",
      "src/renderer/src/lib/bot-conversation-tasks.browser.test.ts",
      "src/main/bots/browser-maintenance.browser.test.ts",
      "src/main/bots/grok-browser-actions-handles.browser.test.ts",
      "src/main/bots/browser-keyboard-recovery.browser.test.ts",
      "src/main/bots/browser-new-tab-target.browser.test.ts",
      "src/main/bots/computer-idle.browser.test.ts",
      "src/main/bots/computer-idle-host.browser.test.ts",
      "src/main/bots/computer-ownership.test.ts",
      "src/main/bots/browser-child.test.ts",
      "src/main/bots/workflow-child-runtime.test.ts",
      "src/main/bots/browser-child-ui.browser.test.ts",
      "src/main/bots/grok-computer-ui.browser.test.ts",
      "src/main/bots/user-form-ui.browser.test.ts",
      "src/main/bots/teach-browser.test.ts",
      "src/renderer/src/lib/bot-skill-dependencies.browser.test.ts",
      "src/main/bots/skill-trial-review-epoch.browser.test.ts",
      "src/main/bots/computer-help-runtime.test.ts",
      "src/main/bots/peer-images-runtime.test.ts",
      "src/main/bots/peer-images.browser.test.ts",
      "src/main/bots/peer-exchange.browser.test.ts",
      "src/main/bots/peer-dispatch.browser.test.ts",
      "src/main/bots/file-delete-epoch.browser.test.ts",
      "src/main/bots/clone-epoch.browser.test.ts",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${report}`
    ],
    env: {
      CMB_SKILL_TRIAL_REVIEW_UI_TEST: "1",
      CMB_BROWSER_CHILD_UI_TEST: "1",
      CMB_GROK_COMPUTER_UI_TEST: "1",
      CMB_TYPED_FORM_UI_TEST: "1",
      CMB_PEER_EXCHANGE_BROWSER_TEST: "1",
      CMB_FILE_DELETE_EPOCH_BROWSER_TEST: "1",
      CMB_CLONE_EPOCH_BROWSER_TEST: "1"
    },
    verify: () => {
      const results = JSON.parse(readFileSync(report, "utf8"))
      if (
        results.numPassedTests === 0 ||
        results.numPassedTests !== results.numTotalTests ||
        results.numFailedTests !== 0 ||
        results.numPendingTests !== 0 ||
        results.testResults.length !== 27
      ) {
        throw new Error("Browser checks were skipped or incomplete; refusing partial acceptance.")
      }
    }
  },
  ...[
    "tests/bot-transcript-virtual-browser.spec.ts",
    "tests/bot-search-pagination-browser.spec.ts",
    "tests/bot-palette-browser.spec.ts",
    "tests/bot-unified-search-browser.spec.ts",
    "tests/bot-composer-teach-menu-browser.spec.ts",
    "tests/bot-error-trays-browser.spec.ts",
    "tests/bot-computer-checkpoints-browser.spec.ts",
    "tests/bot-downloads-browser.spec.ts",
    "tests/bot-message-links-browser.spec.ts",
    "tests/bot-link-preview-browser.spec.ts",
    "tests/bot-profile-creation-browser.spec.ts",
    "tests/bot-profile-inline-browser.spec.ts",
    "tests/bot-menu-handoff-browser.spec.ts",
    "tests/bot-profile-save-epoch-browser.spec.ts",
    "tests/bot-presentation-browser.spec.ts",
    "tests/bot-shell-resources-browser.spec.ts",
    "tests/bot-windows-setup-browser.spec.ts",
    "tests/bot-operation-epoch-browser.spec.ts",
    "tests/bot-routine-trial-plugin-epoch-browser.spec.ts",
    "tests/bot-skill-save-browser.spec.ts",
    "tests/bot-approval-rules-browser.spec.ts",
    "tests/bot-protected-operation-pending-browser.spec.ts",
    "tests/bot-settings-save-recovery-browser.spec.ts",
    "tests/bot-routine-pending-recovery-browser.spec.ts",
    "tests/bot-routine-mutation-epoch-browser.spec.ts",
    "tests/bot-inspector-routines-browser.spec.ts",
    "tests/bot-routine-readiness-browser.spec.ts",
    "tests/bot-budget-notification-save-browser.spec.ts",
    "tests/bot-memory-backup-save-browser.spec.ts",
    "tests/bot-memory-policy-epoch-browser.spec.ts",
    "tests/bot-memory-card-epoch-browser.spec.ts",
    "tests/bot-private-memory-receipts-browser.spec.ts",
    "tests/bot-profile-skill-mutation-epoch-browser.spec.ts",
    "tests/bot-recovery-shell-save-browser.spec.ts",
    "tests/bot-recovery-records-browser.spec.ts",
    "tests/mods-workspace-scope-browser.spec.ts",
    "tests/bot-computer-view-lifetime-browser.spec.ts",
    "tests/bot-computer-navigation-browser.spec.ts",
    "tests/bot-native-computer-browser.spec.mjs",
    "tests/bot-native-secret-browser.spec.mjs",
    "tests/bot-library-read-browser.spec.mjs",
    "tests/bot-file-delete-read-browser.spec.mjs",
    "tests/bot-files-owner-browser.spec.ts",
    "tests/bot-group-member-lifecycle-browser.spec.ts",
    "tests/bot-delete-epoch-browser.spec.ts",
    "tests/bot-local-tool-permission-browser.spec.ts",
    "tests/bot-workspace-browser.spec.ts"
  ].map((file) => ({ name: file, args: ["--import", "tsx", file] })),
  {
    name: "New Chat recipient chooser, original creation and preserved draft/computer ownership",
    args: ["--import", "tsx", "tests/bot-workspace-browser.spec.ts"],
    env: { CMB_BOT_NEW_CHAT_ENTRY_ONLY: "1" }
  }
]

try {
  for (const stage of stages) {
    console.log(`Running ${stage.name}`)
    const result = spawnSync(process.execPath, stage.args, {
      cwd: root,
      env: { ...process.env, CMB_BOT_BROWSER_TEST: "1", ...stage.env },
      stdio: "inherit",
      windowsHide: true
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1
      break
    }
    stage.verify?.()
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
