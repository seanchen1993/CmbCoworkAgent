import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

// Run with npx tsx tests/git-panel-workspace-rebind-browser.spec.ts.
async function main(): Promise<void> {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { Dialog, DialogContent, DialogTitle } from "./src/renderer/src/components/ui/dialog"
import { GitPanelView } from "./src/renderer/src/components/panels/GitPanelView"
import { GIT_BRANCH_REFRESH_EVENT } from "./src/shared/git-branches"
import { normalizeWorkspaceFilesChangedPayload } from "./src/shared/workspace-files-changed"

const threadId = "same-thread"
const oldWorkspace = "/new-repo "
const newWorkspace = "/new-repo/subdir"
const initialGitContext = { workspacePath: oldWorkspace, isGitRepo: true, branch: "old-main" }
const root = createRoot(document.getElementById("root"))
let workspacePath = oldWorkspace
let branch = "old-main"
let file = "old.txt"
let delayDiff = false
let rejectDiff
let finishNewMeta
let finishPull
let filesChanged
let holdMeta = false
let finishPushMeta
let approval = false
let finishPush
let backgroundEscapes = 0
window.addEventListener("keydown", event => {
  if (event.key === "Escape" && !event.defaultPrevented) backgroundEscapes++
})
let metaReads = 0
let diffReads = 0
const gitRoot = () => workspacePath === newWorkspace ? "/new-repo" : oldWorkspace
const base = { success: true, isGitRepo: true, isWorktree: false, taskId: threadId, hasPendingDiff: true }
window.api = {
  ide: { getSettings: async () => ({}) },
  autoCommit: { getWorkspaceCard: async () => ({ cardNumber: "" }) },
  workspace: {
    cancelGitPanelReads: async () => {},
    onFilesChanged: (listener) => {
      filesChanged = listener
      return () => { if (filesChanged === listener) filesChanged = undefined }
    },
    getGitPanelMeta: async () => {
      metaReads++
      const result = { ...base, repositoryRoots: [gitRoot()], worktreeBranch: branch }
      if (holdMeta) {
        holdMeta = false
        return new Promise(resolve => { finishPushMeta = () => resolve({
          ...result, pendingCommits: [{ hash: "abcdef0", message: "pending change", date: "" }]
        }) })
      }
      if (branch !== "new-main") return result
      return new Promise(resolve => { finishNewMeta = () => resolve(result) })
    },
    getGitPanelDiffs: async () => {
      diffReads++
      if (delayDiff) {
        delayDiff = false
        return new Promise((_, reject) => { rejectDiff = reject })
      }
      return {
        ...base,
        changedFilesTotal: 1,
        repositories: [{ path: workspacePath, displayPath: ".", gitRoot: gitRoot() }],
        files: [{ path: file, status: "modified", additions: 1, deletions: 0 }],
        totals: { fileCount: 1, additions: 1, deletions: 0 }
      }
    },
    pushWorktree: () => new Promise(resolve => { finishPush = () => resolve({ success: true }) }),
    pullWorktree: () => new Promise(resolve => { finishPull = resolve })
  }
}
function render() {
  root.render(<>
    <GitPanelView threadId={threadId} workspacePath={workspacePath} initialGitContext={initialGitContext} />
    <Dialog open={approval} onOpenChange={open => { approval = open; render() }}>
      <DialogContent><DialogTitle>审批</DialogTitle><button>查看审批</button></DialogContent>
    </Dialog>
    <Toaster />
  </>)
}
window.fixture = {
  finishPush: () => finishPush(),
  backgroundEscapes: () => backgroundEscapes,
  holdPushMeta: () => { holdMeta = true },
  finishPushMeta: () => finishPushMeta(),
  showApproval: () => { approval = true; render() },
  delayDiff: () => { delayDiff = true },
  hasPendingDiff: () => Boolean(rejectDiff),
  hasPendingPull: () => Boolean(finishPull),
  rejectOldDiff: () => rejectDiff(new Error("old diff response")),
  finishOldPull: () => finishPull({ success: true, detail: "old pull result" }),
  filesChanged: (path) => {
    const event = { threadIds: [threadId], workspacePath: path, changeType: "meta" }
    filesChanged(path === undefined ? event : normalizeWorkspaceFilesChangedPayload(event))
  },
  hasPendingNewMeta: () => Boolean(finishNewMeta),
  finishNewMeta: () => finishNewMeta(),
  readCounts: () => [metaReads, diffReads],
  changeWorkspace: () => {
    workspacePath = newWorkspace
    branch = "new-main"
    file = "new.txt"
    render()
  },
  checkout: () => {
    branch = "new-topic"
    file = "topic.txt"
    window.dispatchEvent(new CustomEvent(GIT_BRANCH_REFRESH_EVENT, {
      detail: { workspacePath, repositoryPath: workspacePath, gitRoot: gitRoot(), branch }
    }))
  }
}
render()
`
    },
    alias: { "@": resolve("src/renderer/src") },
    bundle: true,
    write: false,
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.VITE_MMJ_CDN_URL": "undefined"
    }
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage()
    const pageErrors: Error[] = []
    page.on("pageerror", (error) => pageErrors.push(error))
    page.setDefaultTimeout(4000)
    await page.setContent('<main id="root"></main>')
    await page.addStyleTag({ content: `
      [popover="manual"]:popover-open { inset: 0; margin: 0; width: 100%; height: 100%; max-width: none; display: grid; place-items: center; padding: 0 }
    ` })
    await page.addScriptTag({ content: outputFiles[0].text })

    const oldFile = page.getByRole("button", { name: "查看 old.txt 的 diff" })
    const newFile = page.getByRole("button", { name: "查看 new.txt 的 diff" })
    await oldFile.waitFor()
    const pushTrigger = page.getByRole("button", { name: "Push 推送", exact: true })
    const dialog = page.getByRole("dialog", { name: "Git 推送" })
    const push = dialog.getByRole("button", { name: "Push 推送" })
    const cancel = dialog.getByRole("button", { name: "取消" })
    const close = dialog.getByRole("button", { name: "Close" })
    const focused = (element: typeof push) => element.evaluate(node => node === document.activeElement)

    await page.evaluate("window.fixture.holdPushMeta()")
    await pushTrigger.click()
    await dialog.waitFor()
    assert.ok(await push.isDisabled())
    assert.ok(await focused(cancel))
    await page.keyboard.press("Shift+Tab")
    assert.ok(await focused(close))
    await page.keyboard.press("Tab")
    assert.ok(await focused(cancel))
    await page.evaluate("window.fixture.finishPushMeta()")
    await dialog.getByText("pending change").waitFor()
    assert.ok(await focused(cancel))
    await page.keyboard.press("Shift+Tab")
    assert.ok(await focused(push))
    await page.evaluate("window.fixture.showApproval()")
    await page.getByRole("dialog", { name: "审批" }).waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === "查看审批")
    await page.keyboard.press("Escape")
    await dialog.waitFor()
    assert.ok(await focused(push))
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Push 推送")

    await pushTrigger.press("Enter")
    await dialog.getByText("没有可 Push 的 commit").waitFor()
    assert.ok(await push.isDisabled())
    await cancel.press("Enter")
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Push 推送")
    await pushTrigger.click()
    await close.click()
    await dialog.waitFor({ state: "hidden" })
    await pushTrigger.click()
    await dialog.waitFor()
    await page.mouse.click(2, 2)
    await dialog.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Push 推送")
    await page.evaluate("window.fixture.holdPushMeta()")
    await pushTrigger.click()
    await dialog.waitFor()
    await page.evaluate("window.fixture.finishPushMeta()")
    await push.click()
    await dialog.getByText(/推送中/).waitFor()
    const escapes = await page.evaluate("window.fixture.backgroundEscapes()")
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate("window.fixture.backgroundEscapes()"), escapes)
    await page.evaluate("window.fixture.finishPush()")
    await page.getByRole("button", { name: "Pull 远端代码" }).click()
    await page.waitForFunction("window.fixture.hasPendingPull()")
    await page.evaluate("window.fixture.delayDiff()")
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingDiff()")

    await page.evaluate("window.fixture.changeWorkspace()")
    await page.waitForFunction("window.fixture.hasPendingNewMeta()")
    assert.equal(await page.getByText("分支 old-main", { exact: true }).count(), 0)
    assert.equal(await oldFile.count(), 0)
    await page.evaluate("window.fixture.finishNewMeta()")
    await newFile.waitFor()
    await page.getByText("分支 new-main", { exact: true }).waitFor()

    const counts = await page.evaluate("window.fixture.readCounts()")
    await page.evaluate("window.fixture.rejectOldDiff(); window.fixture.finishOldPull()")
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "old pull result" })
    await toast.waitFor()
    assert.match(await toast.innerText(), /后台 Git 操作（\/new-repo ）/)
    assert.equal(await page.getByText("old diff response").count(), 0)

    await page.evaluate("window.fixture.filesChanged('/new-repo ')")
    await page.waitForTimeout(250)
    assert.deepEqual(await page.evaluate("window.fixture.readCounts()"), counts)

    const waitForFileRefresh = (before: number[]) =>
      page.waitForFunction((previous) => {
        const { fixture } = window as Window & { fixture: { readCounts: () => number[] } }
        return fixture.readCounts().every((count, index) => count > previous[index])
      }, before)

    await page.evaluate("window.fixture.filesChanged('/new-repo')")
    await waitForFileRefresh(counts)
    const newCounts = await page.evaluate("window.fixture.readCounts()")
    await page.evaluate("window.fixture.filesChanged()")
    await waitForFileRefresh(newCounts)

    // A subdirectory watcher may never publish the Git root's HEAD change.
    await page.evaluate("window.fixture.checkout()")
    await page.getByText("分支 new-topic", { exact: true }).waitFor()
    await page.getByRole("button", { name: "查看 topic.txt 的 diff" }).waitFor()
    assert.equal(await newFile.count(), 0)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
