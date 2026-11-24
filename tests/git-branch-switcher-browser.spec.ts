import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

const denseBranch = (index: number): string => `Packed/${index}/${"x".repeat(128)}分支`

// Run with npx tsx tests/git-branch-switcher-browser.spec.ts.
async function main(): Promise<void> {
  const { outputFiles } = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import { createRoot } from "react-dom/client"
import { Toaster } from "sonner"
import { GitBranchSwitcher } from "./src/renderer/src/components/chat/GitBranchSwitcher"
import { UserInputRequestDialog } from "./src/renderer/src/components/chat/UserInputRequestDialog"
import { GitPanelView } from "./src/renderer/src/components/panels/GitPanelView"

const repositories = (cwd, names) => names.map(displayPath => ({
  path: cwd + "/" + displayPath, displayPath, gitRoot: cwd + "/" + displayPath
}))
const wideRepositories = repositories("/wide", [
  "slow", ...Array.from({ length: 38 }, (_, index) => "unused-" + index), "retry", "chosen"
])
const branches = {
  app: "main", lib: "team", linked: "review", elsewhere: "independent",
  slow: "slow-head", chosen: "chosen-head", retry: "retry-head", large: "bulk-0",
  "bare.git": "bare-main", recovery: "legacy-main", "graph-wide": "main", "retry-single": "main",
  "graph-retry": "retry-graph-main", dense: "dense-head", "stale-menu": "main"
}
const largeChoices = [
  ...Array.from({ length: 10000 }, (_, index) => ({ name: "bulk-" + index, kind: "local" })),
  { name: "origin/bulk-9999", kind: "remote" }
]
const appCountRequests = []
const probes = []
let probeCancellations = 0
let finishSlowProbe
let finishRefresh
let finishCreate
let finishSwitch
let finishAppList
let delayStaleList = false
let finishStaleList
const staleMenuNames = ["release-old", "feature-old", "patch-old"]
let finishDenseList
let failDensePage = false
let finishGraphPage
let graphRequests = 0
const graphRetryReads = []
let pendingGraphRetry
let aliasGraphRequests = 0
let branchCancellations = 0
let delaySwitch = false
let delayAppList = false
let delayRecoveryProbe = false
let finishRecoveryProbe
let delayAliasProbe = false
let finishAliasProbe
let switched
const repo = cwd => cwd === "/elsewhere/subdir" ? "elsewhere" : cwd.split("/").at(-1)
const gitDir = cwd => ["elsewhere", "dense"].includes(repo(cwd)) ? "/" + repo(cwd) + "/.git" : undefined
const gitRoot = cwd => cwd === "/elsewhere/subdir" ? "/elsewhere" : cwd
const denseBranch = ${denseBranch.toString()}
let denseSnapshot = 0
const densePage = ({ snapshot, offset }) => {
  const end = Math.min(offset + 1500, 12001)
  return {
    local: Array.from({ length: end - offset }, (_, index) => {
      const branch = offset + index
      return branch ? denseBranch(branch - 1) : "dense-head"
    }).join("\\n"),
    remote: end === 12001 ? "origin/" + denseBranch(11999) : "",
    next: end === 12001 ? undefined : { snapshot, offset: end }
  }
}
const choices = cwd => cwd === "/large" ? largeChoices : [
  ...(branches[repo(cwd)] ? [{ name: branches[repo(cwd)], kind: "local" }] : []),
  ...(repo(cwd) === "bare.git"
    ? Array.from({ length: 40 }, (_, i) => ({ name: "readonly-" + i, kind: "local" }))
    : []),
  ...(repo(cwd) === "elsewhere" && branches.elsewhere !== "already-checked-out"
    ? [{ name: "already-checked-out", kind: "local" }]
    : []),
  ...(repo(cwd) === "recovery"
    ? ["vanished", "topic", "topic\u00a0"].filter(name => name !== branches.recovery)
        .map(name => ({ name, kind: "local" }))
    : []),
  ...(repo(cwd) === "lib" && branches.lib !== "lib-review"
    ? [{ name: "lib-review", kind: "local" }] : []),
  ...(repo(cwd) === "stale-menu"
    ? staleMenuNames.filter(name => name !== branches["stale-menu"]).map(name => ({ name, kind: "local" }))
    : []),
  ...(repo(cwd) === "app" ? [
    ...["origin/topic", "race-target-newer", "race-target", "same-chat-target"]
      .filter(name => name !== branches.app)
      .map(name => ({ name, kind: "local" })),
    { name: "origin/topic", kind: "remote" }
  ] : [])
]
const branchList = cwd => {
  const all = choices(cwd)
  const refs = kind => all.filter(choice => choice.kind === kind).map(choice => choice.name).join("\\n")
  return { branch: branches[repo(cwd)], local: refs("local"), remote: refs("remote") }
}
const graphCommit = (hash, subject) => ({ hash, subject, parents: [], timestamp: 0, author: "Test", refs: [] })
const graphRetryFirstPage = snapshot => ({
  commits: Array.from({ length: 50 }, (_, index) =>
    graphCommit(snapshot + "-" + index, snapshot + " commit " + index)),
  hasMore: true,
  snapshot
})
window.api = { git: {
  currentBranch: async cwd => {
    probes.push(cwd)
    if (cwd === "/workspace" || cwd === "/wide") {
      return {
        isGitRepo: true, isMultiRepo: true, branch: null, isWorktree: false,
        repositories: cwd === "/wide" ? wideRepositories : repositories(cwd, ["app", "lib", "linked"])
      }
    }
    if (cwd === "/wide/slow") return new Promise(resolve => { finishSlowProbe = resolve })
    if (cwd === "/retry-single" && probes.filter(path => path === cwd).length === 1) {
      return { isGitRepo: false, branch: null, isWorktree: false, error: "读取 Git 仓库超时" }
    }
    if (cwd === "/wide/retry" && probes.filter(path => path === cwd).length === 1) {
      throw new Error("暂时无法读取状态")
    }
    const status = {
      isGitRepo: true, branch: branches[repo(cwd)], isWorktree: repo(cwd) === "linked",
      isInsideWorkTree: cwd !== "/bare.git", gitDir: gitDir(cwd), gitRoot: gitRoot(cwd)
    }
    if (cwd === "/recovery" && delayRecoveryProbe) {
      delayRecoveryProbe = false
      return new Promise(resolve => { finishRecoveryProbe = () => resolve(status) })
    }
    if (cwd === "/elsewhere/subdir" && delayAliasProbe) {
      delayAliasProbe = false
      return new Promise(resolve => { finishAliasProbe = () => resolve(status) })
    }
    return status
  },
  listBranchMenu: (cwd, { refreshRemote }) => {
    if (cwd === "/stale-menu" && delayStaleList) {
      delayStaleList = false
      return new Promise((resolve, reject) => {
        finishStaleList = (error, readRefs = false) => {
          finishStaleList = undefined
          if (error && !readRefs) reject(new Error(error))
          else resolve({ success: !error, error, ...branchList(cwd) })
        }
      })
    }
    if (refreshRemote) return new Promise(resolve => { finishRefresh = resolve })
    if (cwd === "/dense") {
      const first = densePage({ snapshot: ++denseSnapshot, offset: 0 })
      return new Promise(resolve => {
        finishDenseList = () => {
          finishDenseList = undefined
          resolve({ success: true, branch: branches.dense, ...first })
        }
      })
    }
    const result = { success: true, ...branchList(cwd) }
    if (delayAppList && repo(cwd) === "app") {
      delayAppList = false
      return new Promise(resolve => { finishAppList = () => resolve(result) })
    }
    return Promise.resolve(result)
  },
  readBranchMenuPage: async cursor => {
    if (failDensePage) {
      failDensePage = false
      throw new Error("Branch menu snapshot expired")
    }
    return densePage(cursor)
  },
  cancelBranchProbe: async () => { probeCancellations++ },
  readBranchHead: async dir => dir === "/dense/.git" ? branches.dense : dir === "/elsewhere/.git" ? branches.elsewhere : null,
  cancelBranchHead: async () => {},
  cancelBranchList: async () => { branchCancellations++ },
  getChangedFileCount: (cwd, branch) => {
    if (branch !== branches[repo(cwd)]) {
      return Promise.reject(new Error("当前分支已变化"))
    }
    return repo(cwd) === "app"
      ? new Promise(resolve => appCountRequests.push(resolve))
      : Promise.resolve(2)
  },
  createBranch: (name, cwd) => new Promise(resolve => {
    finishCreate = error => {
      if (!error) branches[repo(cwd)] = name
      resolve(error ? { success: false, error } : {
        success: true, branch: name, headChanged: true, gitDir: gitDir(cwd), gitRoot: gitRoot(cwd)
      })
      finishCreate = undefined
    }
  }),
  switchBranch: async (name, cwd, kind) => {
    switched = { name, cwd, kind }
    const branch = kind === "remote" ? "topic" : name
    if (delaySwitch) {
      delaySwitch = false
      const result = await new Promise(resolve => { finishSwitch = resolve })
      finishSwitch = undefined
      if (result) {
        if (result.headChanged) branches[repo(cwd)] = result.branch
        return result
      }
    }
    branches[repo(cwd)] = branch
    return {
      success: true, branch, headChanged: true,
      ...(repo(cwd) === "lib" ? { gitRoot: gitRoot(cwd) } : {})
    }
  },
  getCommitGraph: async (cwd, skip = 0, snapshot) => {
    if (cwd === "/workspace/lib") {
      const branch = branches.lib
      return { commits: [graphCommit(branch, "lib HEAD " + branch)], hasMore: false, snapshot: branch }
    }
    if (cwd === "/elsewhere/subdir") {
      aliasGraphRequests++
      const branch = branches.elsewhere
      return { commits: [graphCommit(branch, "HEAD " + branch)], hasMore: false, snapshot: branch }
    }
    if (cwd === "/graph-wide") {
      const parents = Array.from({ length: 512 }, (_, index) => "parent-" + index)
      const merge = { ...graphCommit("wide-merge", "Wide merge"), parents }
      const commits = [
        merge,
        ...parents.slice(0, 49).map(parent => graphCommit(parent, parent))
      ]
      return { commits, hasMore: false, snapshot: "wide-graph" }
    }
    if (cwd === "/graph-retry") {
      graphRetryReads.push([skip, snapshot])
      if (graphRetryReads.length === 1) return graphRetryFirstPage("Initial")
      return new Promise((resolve, reject) => { pendingGraphRetry = { skip, resolve, reject } })
    }
    if (!skip) return { commits: Array.from({length:50}, (_, i) => graphCommit("first-" + i, i === 0 ? "First page" : "History " + i)), hasMore: true, snapshot: "fixture" }
    graphRequests++
    return new Promise(resolve => { finishGraphPage = resolve })
  },
  cancelCommitGraph: async () => {}
} }
const gitPanelReads = []
const panelFileListeners = new Set()
const panelDiffFile = { path: "edited.txt", status: "modified", additions: 1, deletions: 0 }
const repositoryChangedFiles = new Map()
let finishPanelFileDiff
let delayNextPanelDiff
let finishCheckoutDiff
let pendingPull
const panelRepositories = cwd => cwd === "/workspace"
  ? repositories(cwd, ["app", "lib"])
  : [{ path: cwd, displayPath: ".", gitRoot: gitRoot(cwd) }]
const gitPanelState = cwd => ({
  success: true, isGitRepo: true, isWorktree: false, taskId: cwd, changedFilesTotal: 1,
  hasPendingDiff: true
})
window.api.ide = { getSettings: async () => ({}) }
window.api.gitPanel = { getCommitHistory: async () => ({ success: true, records: [] }) }
window.api.autoCommit = {
  getWorkspaceCard: async () => ({ cardNumber: "" })
}
window.api.workspace = {
  cancelGitPanelReads: async () => {},
  onFilesChanged: listener => {
    panelFileListeners.add(listener)
    return () => panelFileListeners.delete(listener)
  },
  getGitPanelMeta: async cwd => {
    gitPanelReads.push(["meta", cwd])
    return {
      ...gitPanelState(cwd), repositoryRoots: panelRepositories(cwd).map(repo => repo.gitRoot),
      worktreeBranch: branches[repo(cwd)], hasPushableCommit: false
    }
  },
  getGitPanelDiffs: async cwd => {
    gitPanelReads.push(["diff", cwd])
    if (delayNextPanelDiff) {
      delayNextPanelDiff = false
      await new Promise(resolve => { finishCheckoutDiff = resolve })
    }
    const files = cwd === "/workspace"
      ? panelRepositories(cwd).map(repo => ({
          ...panelDiffFile,
          path: repo.displayPath + "/" + (repositoryChangedFiles.get(repo.path) ??
            (branches[repo.displayPath] === "app-checkout" ? "new.txt" : "edited.txt")),
        }))
      : [panelDiffFile]
    return {
      ...gitPanelState(cwd),
      repositories: panelRepositories(cwd),
      files,
      totals: { fileCount: files.length, additions: files.length, deletions: 0 }
    }
  },
  pullWorktree: (_cwd, options) => new Promise(resolve => {
    pendingPull = { path: options?.worktreePath, resolve }
  }),
  getGitPanelFileDiff: async cwd => {
    const branch = branches[repo(cwd)]
    const result = {
      success: true, taskId: cwd,
      file: { ...panelDiffFile, diff: "--- a/edited.txt\\n+++ b/edited.txt\\n@@ -0,0 +1 @@\\n+" + branch + " file contents\\n" }
    }
    if (branch !== "refresh-git-panel") return result
    return new Promise(resolve => { finishPanelFileDiff = () => resolve(result) })
  }
}
const root = createRoot(document.getElementById("root"))
const questionRoot = createRoot(document.getElementById("pending-question-root"))
const questionResponses = []
const receiveQuestion = () => questionRoot.render(
  <UserInputRequestDialog
    request={{
      requestId: "workbench-pending-request",
      threadId: "thread",
      createdAt: Date.now(),
      questions: [{ id: "question", question: "Pending workbench question", options: [] }]
    }}
    onSubmit={(response) => {
      questionResponses.push(response)
      questionRoot.render(null)
    }}
  />
)
const openWorkspace = (cwd, showGitPanel = false) => root.render(
  <>
    <GitBranchSwitcher key={cwd} workspacePath={cwd} environmentRailCollapsed={false} />
    {showGitPanel && (
      <section aria-label="Git 面板">
        <GitPanelView key={cwd} workspacePath={cwd} threadId={cwd} />
      </section>
    )}
    <Toaster />
  </>
)
const branchEvents = []
window.addEventListener("cmb:git-branch-switched", event => branchEvents.push(event.detail))
window.fixture = {
  receiveQuestion,
  questionResponses: () => questionResponses,
  hasPendingCreate: () => Boolean(finishCreate),
  failCreate: (error = "分支已存在") => finishCreate(error),
  succeedCreate: () => finishCreate(),
  finishRefresh: (cwd = "/workspace/app") => finishRefresh({
    success: false, ...branchList(cwd), error: "远端刷新超时"
  }),
  finishAppCounts: () => appCountRequests.splice(0).forEach(resolve => resolve(9)),
  switched: () => switched,
  delaySwitch: () => { delaySwitch = true },
  hasPendingSwitch: () => Boolean(finishSwitch),
  finishSwitch: result => finishSwitch(result),
  finishSwitchDetached: () => finishSwitch({
    success: false, headChanged: true, branch: null, error: "未能检出目标分支，工作区当前处于游离 HEAD 状态。"
  }),
  delayRecoveryProbe: () => { delayRecoveryProbe = true },
  hasPendingRecoveryProbe: () => Boolean(finishRecoveryProbe),
  finishRecoveryProbe: () => finishRecoveryProbe(),
  delayAliasProbe: () => { delayAliasProbe = true },
  hasPendingAliasProbe: () => Boolean(finishAliasProbe),
  finishAliasProbe: () => finishAliasProbe(),
  delayAppList: () => { delayAppList = true },
  hasPendingAppList: () => Boolean(finishAppList),
  finishAppList: () => finishAppList(),
  delayStaleList: () => { delayStaleList = true },
  hasPendingStaleList: () => Boolean(finishStaleList),
  finishStaleList: (error, readRefs) => finishStaleList(error, readRefs),
  addStaleMenuBranch: name => { staleMenuNames.push(name) },
  hasPendingDenseList: () => Boolean(finishDenseList),
  finishDenseList: () => finishDenseList(),
  failDensePage: () => { failDensePage = true },
  graphRequests: () => graphRequests,
  graphRetryReads: () => graphRetryReads,
  finishGraphRetryRead: error => {
    const { skip, resolve, reject } = pendingGraphRetry
    pendingGraphRetry = undefined
    if (error) reject(new Error(error))
    else if (!skip) resolve(graphRetryFirstPage("Refreshed"))
    else resolve({
      commits: [graphCommit("retry-last", "End of retry graph")], hasMore: false, snapshot: "Refreshed"
    })
  },
  aliasGraphRequests: () => aliasGraphRequests,
  finishFullGraphPage: () => finishGraphPage({
    commits: Array.from({length: 50}, (_, i) => graphCommit("second-" + i, "More history " + i)),
    hasMore: true,
    snapshot: "fixture"
  }),
  finishGraphPage: (reset = false) => finishGraphPage({
    commits: [reset ? graphCommit("new", "Rewritten history") : graphCommit("last", "Last page")],
    hasMore: false,
    snapshot: reset ? "rewritten" : "fixture",
    reset
  }),
  branchEvents: () => branchEvents,
  gitPanelReads: () => gitPanelReads,
  delayNextPanelDiff: () => { delayNextPanelDiff = true },
  hasPendingCheckoutDiff: () => Boolean(finishCheckoutDiff),
  pendingPullPath: () => pendingPull?.path,
  failPull: (error) => {
    pendingPull.resolve({ success: false, error })
    pendingPull = undefined
  },
  finishCheckoutDiff: () => { finishCheckoutDiff(); finishCheckoutDiff = undefined },
  hasPendingPanelFileDiff: () => Boolean(finishPanelFileDiff),
  finishPanelFileDiff: () => {
    finishPanelFileDiff()
    finishPanelFileDiff = undefined
  },
  notifyPanelFiles: (cwd, changeType, update) => {
    for (const listener of panelFileListeners) listener({ threadIds: [cwd], workspacePath: cwd, changeType, update })
  },
  setRepositoryChangedFile: (cwd, file) => repositoryChangedFiles.set(cwd, file),
  branchCancellations: () => branchCancellations,
  wideProbes: () => probes.filter(path => path.startsWith("/wide")),
  probeCancellations: () => probeCancellations,
  finishSlowProbe: () => finishSlowProbe({
    isGitRepo: true, branch: "slow-head", isWorktree: true, isInsideWorkTree: true
  }),
  externalCheckout: (cwd, branch) => { branches[repo(cwd)] = branch },
  openWorkspace
}
openWorkspace("/workspace")
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
    page.setDefaultTimeout(10000)
    await page.setContent(
      '<main id="root" style="position:fixed;left:100px;top:10px"></main><button type="button">Outside</button><div id="pending-question-root" hidden></div>'
    )
    await page.addStyleTag({ path: resolve("src/renderer/src/components/chat/git-branch-menu.css") })
    await page.addStyleTag({content: `
      [aria-label="分支列表"] {overflow-y:auto}
      [data-branch-choice] {display:block;width:100%}
      [aria-label="提交历史"] {height:280px;overflow:auto}
      [aria-label="提交历史"] .relative {position:relative}
      [aria-label="提交历史"] .absolute {position:absolute;left:0}
      [aria-label="提交历史"] .border-r {box-sizing:border-box;border-right:1px solid}
      [aria-label="提交历史"] button {display:block}
    `})
    await page.addScriptTag({ content: outputFiles[0].text })

    const trigger = page.getByRole("button", { name: "切换 Git 分支" })
    const refresh = page.getByTitle("刷新分支列表")
    const create = page.getByRole("button", { name: "创建并检出新分支…" })
    const choices = page.getByRole("button", { name: "origin/topic", exact: true })
    const repository = page.getByRole("combobox", { name: "子仓库" })
    const branchSearch = page.getByRole("textbox", { name: "搜索分支" })
    const menu = page.getByRole("dialog", { name: "切换 Git 分支", exact: true })
    assert.equal(await trigger.evaluate((button) => {
      button.click()
      return document.activeElement?.getAttribute("aria-label")
    }), "搜索分支")
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    await trigger.press("Enter")
    await page.keyboard.type("x")
    assert.equal(await branchSearch.inputValue(), "x")
    await branchSearch.fill("")
    await choices.last().waitFor()
    assert.equal(await trigger.evaluate((button) => {
      const branchLabel = button.getAttribute("aria-describedby")
      return branchLabel && document.getElementById(branchLabel)?.textContent
    }), "app · main")
    const triggerBounds = (await trigger.boundingBox())!
    assert.ok((await menu.boundingBox())!.y >= triggerBounds.y + triggerBounds.height + 5,
      "the menu flips below a trigger near the top")

    await page.locator("#root").evaluate((root) => {
      root.style.cssText = "position:fixed;right:8px;bottom:60px"
    })
    await page.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="切换 Git 分支"]')?.getBoundingClientRect()
      const popup = document.querySelector(".git-branch-menu")?.getBoundingClientRect()
      return button && popup && popup.top >= 0 && popup.right <= innerWidth &&
        popup.left < button.left && popup.bottom <= button.top - 5
    })
    await repository.focus()
    await page.keyboard.press("Shift+Tab")
    assert.equal(await menu.getByRole("button", { name: "Git 图谱" }).evaluate(
      (button) => document.activeElement === button
    ), true)
    await page.keyboard.press("Tab")
    assert.equal(await repository.evaluate((input) => document.activeElement === input), true)
    const pendingQuestion = page.getByText("Pending workbench question", { exact: true })
    await page.evaluate("window.fixture.receiveQuestion()")
    await pendingQuestion.waitFor({ state: "attached" })
    await page.keyboard.press("Escape")
    assert.deepEqual(await page.evaluate("window.fixture.questionResponses()"), [])
    await menu.waitFor({ state: "hidden" })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "切换 Git 分支")

    await trigger.click()
    await branchSearch.evaluate((input) => input.blur())
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true)
    await menu.waitFor()
    await page.keyboard.press("Escape")
    assert.deepEqual(await page.evaluate("window.fixture.questionResponses()"), [])
    await menu.waitFor({ state: "hidden" })
    assert.equal(await trigger.evaluate((button) => document.activeElement === button), true)

    await trigger.click()
    await page.keyboard.type("x")
    assert.equal(await branchSearch.inputValue(), "x")
    const ime = await page.context().newCDPSession(page)
    await ime.send("Input.imeSetComposition", { text: "拼", selectionStart: 1, selectionEnd: 1 })
    await page.keyboard.press("Escape")
    await menu.waitFor()
    await ime.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 })
    const outside = page.getByRole("button", { name: "Outside" })
    await outside.click()
    await menu.waitFor({ state: "hidden" })
    assert.equal(await outside.evaluate((button) => document.activeElement === button), true)
    assert.deepEqual(await page.evaluate("window.fixture.questionResponses()"), [])
    await page.keyboard.press("Escape")
    await pendingQuestion.waitFor({ state: "detached" })
    assert.equal(await page.evaluate("window.fixture.questionResponses()[0].ignored"), true)

    await page.locator("#root").evaluate((root) => { root.style.cssText = "margin:100px" })
    await trigger.click()
    await choices.last().waitFor()
    assert.equal(await choices.count(), 2)
    await branchSearch.fill("origin/topic")
    await branchSearch.press("Enter")
    assert.equal(await choices.first().evaluate(el => el === document.activeElement), true)
    assert.equal(await page.evaluate("window.fixture.switched()"), undefined)
    await branchSearch.fill("")
    await refresh.click()
    assert.equal(await choices.count(), 2)
    await create.click()
    const branchName = page.getByRole("textbox", { name: "分支名" })
    await branchName.fill("draft/")
    await ime.send("Input.imeSetComposition", { text: "拼", selectionStart: 1, selectionEnd: 1 })
    await page.keyboard.press("Escape")
    assert.equal(await branchName.isVisible(), true)
    await ime.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 })
    assert.equal(await branchName.inputValue(), "draft/")
    await ime.detach()
    await branchName.fill("existing")
    await page.keyboard.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    assert.equal(await branchName.evaluate((input) => document.activeElement === input), true)
    await page.evaluate("window.fixture.failCreate()")
    await page.getByRole("alert").getByText("分支已存在").waitFor()
    assert.equal(await branchName.evaluate((input) => document.activeElement === input), true)
    await page.keyboard.press("ControlOrMeta+A")
    await page.keyboard.type("still-existing")
    assert.equal(await branchName.inputValue(), "still-existing")
    await page.getByRole("button", { name: "创建并切换" }).click()
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.evaluate("window.fixture.failCreate()")
    await page.getByRole("alert").getByText("分支已存在").waitFor()
    assert.equal(await branchName.evaluate((input) => document.activeElement === input), true)
    await page.evaluate("window.fixture.finishRefresh()")
    assert.equal(await page.getByRole("alert").textContent(), "分支已存在")
    await page.getByRole("button", { name: "取消" }).click()

    await trigger.click()
    await choices.last().click()
    await page.getByText("app · topic", { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), {
      name: "origin/topic",
      cwd: "/workspace/app",
      kind: "remote"
    })

    await trigger.click()
    await choices.last().waitFor()
    await refresh.click()
    await repository.selectOption("/workspace/lib")
    await page.getByText("未提交的更改：2 个文件").waitFor()
    await page.evaluate("window.fixture.finishRefresh(); window.fixture.finishAppCounts()")
    assert.equal(await choices.count(), 0)
    assert.equal(await page.getByText("未提交的更改：9 个文件").count(), 0)
    assert.equal(await page.getByRole("alert").count(), 0)

    const cancellations = await page.evaluate("window.fixture.branchCancellations()")
    await page.keyboard.press("Escape")
    assert.equal(
      await page.evaluate("window.fixture.branchCancellations()"),
      Number(cancellations) + 1
    )
    await page.evaluate('window.fixture.externalCheckout("/workspace/lib", "terminal")')
    await trigger.click()
    await trigger.getByText("lib · terminal", { exact: true }).waitFor()
    const terminalBranch = page.getByRole("button", { name: /^terminal/ })
    await terminalBranch.getByText("未提交的更改：2 个文件").waitFor()
    assert.equal(await terminalBranch.getAttribute("aria-current"), "true")

    await repository.selectOption("/workspace/linked")
    const linkedBranch = page.getByRole("button", { name: /^review/ })
    await linkedBranch.waitFor()
    assert.equal(await linkedBranch.isDisabled(), true)
    assert.equal(await create.count(), 0)
    await page.getByRole("button", { name: "Git 图谱" }).click()
    await page.getByRole("heading", { name: "Git 图谱" }).waitFor()
    const diagram = page.getByRole("dialog", { name: "Git 图谱" })
    await page.waitForFunction(() => document.activeElement?.closest('[aria-modal="true"]'))
    assert.equal(await trigger.count(), 0, "background controls must be hidden from assistive technology")
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[aria-label="切换 Git 分支"]')?.focus()
    )
    assert.equal(await diagram.evaluate(el => el.contains(document.activeElement)), true)
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Tab")
    assert.equal(await diagram.evaluate(el => el.contains(document.activeElement)), true)
    const history = diagram.getByRole("region", { name: "提交历史" })
    const graphRefresh = diagram.getByRole("button", { name: "刷新 Git 图谱" })
    const bottom = () => history.evaluate(el => { el.scrollTop = el.scrollHeight })
    assert.equal(await diagram.getByRole("button", { name: "下一页" }).count(), 0)
    await page.waitForFunction("window.fixture.graphRequests() === 1")
    assert.equal(await history.evaluate(el => el.scrollTop), 0)
    await history.locator('svg[aria-label="Git 提交图"]').nth(1).waitFor()
    const blockGap = await history.evaluate(list => {
      const [first, second] = list.querySelectorAll<SVGSVGElement>('svg[aria-label="Git 提交图"]')
      const end = new DOMPoint(0, first.viewBox.baseVal.height).matrixTransform(first.getScreenCTM()!)
      const start = new DOMPoint(0, 0).matrixTransform(second.getScreenCTM()!)
      return start.y - end.y
    })
    assert.ok(Math.abs(blockGap) < 0.5, `Graph blocks separated by ${blockGap}px`)
    // The button window should follow the real viewport even when its bounds fall inside SVG blocks.
    const graphRows = history.getByRole("button")
    assert.ok((await graphRows.count()) <= 11)
    await history.evaluate(el => { el.style.height = "160px" })
    await page.waitForFunction(() => document.querySelector('[aria-label="提交历史"]')!.querySelectorAll("button").length <= 8)
    await history.evaluate(el => { el.style.height = "" })
    await history.getByText("History 10", { exact: true }).waitFor()
    await bottom()
    const position = await history.evaluate(el => el.scrollTop)
    await history.evaluate(el => el.dispatchEvent(new Event("scroll")))
    assert.equal(await page.evaluate("window.fixture.graphRequests()"), 1)
    await page.evaluate("window.fixture.finishGraphPage()")
    await diagram.getByRole("button", { name: /Last page/ }).waitFor()
    assert.equal(await history.evaluate(el => el.scrollTop), position)
    assert.ok((await graphRows.count()) <= 14)
    await history.evaluate(el => { el.scrollTop = 0 })
    await diagram.getByRole("button", {name:/First page/}).waitFor()
    await graphRefresh.click()
    await page.waitForFunction(() => document.querySelector('[aria-label="提交历史"]')?.getAttribute("aria-busy") === "false")
    await bottom()
    await page.waitForFunction("window.fixture.graphRequests() === 2")
    await page.evaluate("window.fixture.finishGraphPage(true)")
    await diagram.getByRole("button", { name: /Rewritten history/ }).waitFor()
    assert.equal(await history.evaluate(el => el.scrollTop), 0)
    await graphRefresh.click()
    await page.waitForFunction("window.fixture.graphRequests() === 3")
    await page.evaluate("window.fixture.finishFullGraphPage()")
    await page.waitForFunction(() => {
      const list = document.querySelector('[aria-label="提交历史"]')
      return list && list.scrollHeight >= 100 * 42
    })
    assert.equal(await page.evaluate("window.fixture.graphRequests()"), 3)
    await history.evaluate(list => { list.scrollTop = 50 * 42 })
    await diagram.getByText("More history 2", { exact: true }).waitFor()
    await page.waitForFunction("window.fixture.graphRequests() === 4")
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
      detail: { workspacePath: "/workspace", repositoryPath: "/workspace/linked", branch: "review" }
    })))
    await diagram.getByRole("button", { name: /First page/ }).waitFor()
    assert.equal(await history.evaluate(list => list.scrollTop), 0)
    await history.getByRole("button", { name: /First page/ }).focus()
    await history.evaluate(el => { el.scrollTop = 24 * 42 })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "提交历史")
    await page.keyboard.press("PageDown")
    await page.waitForFunction(() => document.querySelector('[aria-label="提交历史"]')!.scrollTop > 25 * 42)
    await page.keyboard.press("Escape")
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "切换 Git 分支"
    )

    await trigger.click()
    await repository.selectOption("/workspace/app")
    await choices.first().waitFor()
    await page.evaluate("window.fixture.delaySwitch()")
    const priorBranchEvents = await page.evaluate("window.fixture.branchEvents().length")
    await choices.first().click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    const otherBranch = trigger.getByText("independent", { exact: true })
    await otherBranch.waitFor()
    await page.evaluate("window.fixture.finishSwitch()")
    await page.waitForFunction(
      (count) => window.fixture.branchEvents().length === count + 1,
      priorBranchEvents
    )
    assert.equal(await otherBranch.count(), 1)
    assert.deepEqual(await page.evaluate("window.fixture.branchEvents().at(-1)"), {
      workspacePath: "/workspace",
      repositoryPath: "/workspace/app",
      branch: "origin/topic"
    })

    await page.evaluate('window.fixture.openWorkspace("/workspace")')
    await trigger.getByText("app · origin/topic", { exact: true }).waitFor()
    await trigger.click()
    await page.evaluate("window.fixture.delaySwitch()")
    await branchSearch.fill("race-target")
    await branchSearch.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    await otherBranch.waitFor()
    await page.evaluate('window.fixture.openWorkspace("/workspace")')
    await trigger.getByText("app · origin/topic", { exact: true }).waitFor()
    await page.evaluate("window.fixture.delayAppList()")
    await trigger.click()
    await page.waitForFunction("window.fixture.hasPendingAppList()")
    await page.evaluate("window.fixture.finishSwitch()")
    await trigger.getByText("app · race-target", { exact: true }).waitFor()
    const activeRaceBranch = page.getByRole("button").filter({ has: page.getByText("race-target", { exact: true }) })
    await activeRaceBranch.waitFor()
    assert.equal(await activeRaceBranch.getAttribute("aria-current"), "true")
    await page.evaluate("window.fixture.finishAppList()")
    await repository.selectOption("/workspace/lib")
    await trigger.getByText("lib · terminal", { exact: true }).waitFor()
    assert.equal(
      await repository.locator('option[value="/workspace/app"]').textContent(),
      "app · race-target"
    )

    await page.evaluate('window.fixture.openWorkspace("/recovery")')
    await trigger.getByText("legacy-main", { exact: true }).waitFor()
    await trigger.click()
    await page.evaluate("window.fixture.delaySwitch()")
    await page.getByRole("button", { name: "vanished", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    await otherBranch.waitFor()
    await page.evaluate('window.fixture.delayRecoveryProbe(); window.fixture.openWorkspace("/recovery")')
    await page.waitForFunction("window.fixture.hasPendingRecoveryProbe()")
    const beforeDetached = await page.evaluate("window.fixture.branchEvents().length")
    await page.evaluate("window.fixture.finishSwitchDetached()")
    await page.waitForFunction(
      (count) => window.fixture.branchEvents().length === count + 1,
      beforeDetached
    )
    assert.deepEqual(await page.evaluate("window.fixture.branchEvents().at(-1)"), {
      workspacePath: "/recovery",
      repositoryPath: "/recovery",
      branch: null
    })
    await page.evaluate("window.fixture.finishRecoveryProbe()")
    await trigger.getByText("未识别分支", { exact: true }).waitFor()
    await page.getByText(/工作区当前处于游离 HEAD 状态/).waitFor()
    await trigger.click()
    const detachedSearch = page.getByRole("textbox", { name: "搜索分支" })
    await page.getByRole("button", { name: "vanished", exact: true }).waitFor()
    await detachedSearch.press("Enter")
    assert.equal(await trigger.getByText("未识别分支", { exact: true }).count(), 1)
    await detachedSearch.fill("vanished")
    await detachedSearch.press("Enter")
    await trigger.getByText("vanished", { exact: true }).waitFor()

    await page.evaluate('window.fixture.openWorkspace("/wide")')
    await trigger.click()
    const slowBranch = page.getByRole("button", { name: /^slow-head/ })
    await slowBranch.waitFor()
    assert.equal(await repository.locator("option").count(), 41)
    assert.equal(await slowBranch.isDisabled(), true)
    assert.equal(await create.count(), 0)
    await page.getByRole("button", { name: "Git 图谱" }).click()
    await diagram.getByRole("button", { name: /First page/ }).waitFor()
    await diagram.getByRole("button", { name: "关闭 Git 图谱" }).click()
    await diagram.waitFor({ state: "detached" })
    await trigger.click()
    const cancelledBeforeSelection = await page.evaluate<number>("window.fixture.probeCancellations()")
    await repository.selectOption("/wide/chosen")
    await create.waitFor()
    await page.getByRole("button", { name: /^chosen-head/ }).waitFor()
    assert.ok((await page.evaluate<number>("window.fixture.probeCancellations()")) > cancelledBeforeSelection)
    assert.deepEqual(await page.evaluate("window.fixture.wideProbes()"), [
      "/wide",
      "/wide/slow",
      "/wide/chosen"
    ])
    await page.evaluate("window.fixture.finishSlowProbe()")
    await repository.selectOption("/wide/retry")
    await page.getByRole("alert").getByText("暂时无法读取状态").waitFor()
    assert.equal(await create.count(), 0)
    const failedProbes = await page.evaluate("window.fixture.wideProbes()")
    await page.keyboard.press("Escape")
    await repository.waitFor({ state: "hidden" })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    assert.deepEqual(await page.evaluate("window.fixture.wideProbes()"), failedProbes)
    await trigger.click()
    await create.waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)

    await page.evaluate('window.fixture.openWorkspace("/large")')
    await trigger.click()
    const branchList = page.getByRole("region", { name: "分支列表" })
    const currentChoice = branchList.locator("button[aria-current=true]").filter({ hasText: "bulk-0" })
    const lastChoice = branchList.getByRole("button", { name: "origin/bulk-9999", exact: true })
    await currentChoice.waitFor()
    assert.ok((await branchList.getByRole("button").count()) < 30)
    await currentChoice.focus()
    await page.keyboard.press("End")
    await lastChoice.waitFor()
    await page.waitForFunction(() => {
      const list = document.querySelector('[aria-label="分支列表"]')!
      return list.scrollHeight - list.clientHeight - list.scrollTop < 1
    })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "分支列表")
    await page.keyboard.press("ArrowUp")
    assert.equal(await lastChoice.evaluate((button) => button === document.activeElement), true)
    assert.ok((await branchList.getByRole("button").count()) < 30)
    await page.keyboard.press("ArrowDown")
    assert.equal(await currentChoice.evaluate((button) => button === document.activeElement), true)

    await currentChoice.getByText("未提交的更改：2 个文件").waitFor()
    await branchList.evaluate((list) => { list.scrollTop = list.clientHeight * 3 })
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "分支列表")
    // At this scroll position the taller current row shifts the branch at each viewport edge.
    const dirtyRowScrollTop = 26 + 10 * 36
    await branchList.evaluate((list, top) => { list.scrollTop = top }, dirtyRowScrollTop)
    await page.keyboard.press("ArrowDown")
    assert.equal(await branchList.getByRole("button", { name: "bulk-9", exact: true }).evaluate(
      (button) => button === document.activeElement
    ), true)
    await branchList.evaluate((list, top) => {
      list.focus({ preventScroll: true })
      list.scrollTop = top
    }, dirtyRowScrollTop)
    await page.keyboard.press("ArrowUp")
    assert.equal(await branchList.getByRole("button", { name: "bulk-14", exact: true }).evaluate(
      (button) => button === document.activeElement
    ), true)

    await page.getByRole("textbox", { name: "搜索分支" }).fill("bulk-9999")
    await page
      .getByRole("group", { name: "远程分支" })
      .getByRole("button", {
        name: "origin/bulk-9999",
        exact: true
      })
      .waitFor()
    assert.equal(await page.locator("[data-branch-choice]").count(), 2)
    assert.equal(await page.getByRole("button", { name: "下一页" }).count(), 0)

    await page.evaluate('window.fixture.openWorkspace("/dense")')
    await trigger.getByText("dense-head", { exact: true }).waitFor()
    await trigger.click()
    await page.waitForFunction("window.fixture.hasPendingDenseList()")
    await page.evaluate("window.fixture.failDensePage(); window.fixture.finishDenseList()")
    await page.getByRole("alert").getByText("刷新分支列表失败").waitFor()
    await branchSearch.press("Escape")
    await branchSearch.waitFor({ state: "hidden" })
    await trigger.click()
    await page.waitForFunction("window.fixture.hasPendingDenseList()")
    const switchBeforeSearch = await page.evaluate("window.fixture.switched()")
    await branchSearch.fill(denseBranch(4))
    await branchSearch.press("Enter")
    await branchSearch.fill("DENSE-HEAD")
    await page.evaluate("window.fixture.finishDenseList()")
    await branchList.locator("button[aria-current=true]").getByText("dense-head", { exact: true }).waitFor()
    await branchSearch.press("Enter")
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), switchBeforeSearch)
    assert.equal(await branchSearch.isVisible(), true)

    await branchSearch.fill("missing-query")
    await branchSearch.fill("packed/11999")
    await branchList.getByText(denseBranch(11999), { exact: true }).waitFor()
    await branchList.getByText("origin/" + denseBranch(11999), { exact: true }).waitFor()
    assert.equal(await branchList.getByRole("button").count(), 2)
    await branchSearch.fill(denseBranch(11999))
    await branchSearch.press("Enter")
    await branchSearch.waitFor({ state: "hidden" })
    const lastDenseSwitch = { name: denseBranch(11999), cwd: "/dense", kind: "local" }
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), lastDenseSwitch)

    // Reopen through a fresh workspace view so Enter is waiting on the list.
    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    await otherBranch.waitFor()
    await page.evaluate('window.fixture.openWorkspace("/dense")')
    await trigger.getByText(denseBranch(11999), { exact: true }).waitFor()
    await trigger.click()
    await page.waitForFunction("window.fixture.hasPendingDenseList()")
    await branchSearch.fill(denseBranch(5))
    await branchSearch.press("Enter")
    await branchSearch.press("Escape")
    await branchSearch.waitFor({ state: "hidden" })
    await page.evaluate('window.fixture.openWorkspace("/elsewhere"); window.fixture.finishDenseList()')
    await otherBranch.waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), lastDenseSwitch)

    await page.evaluate('window.fixture.openWorkspace("/stale-menu")')
    await trigger.click()
    const oldRelease = branchList.getByRole("button", { name: "release-old", exact: true })
    await oldRelease.waitFor()
    await branchSearch.press("Escape")
    await branchSearch.waitFor({ state: "hidden" })
    await page.evaluate('window.fixture.addStaleMenuBranch("release"); window.fixture.delayStaleList()')
    await trigger.click()
    await page.waitForFunction("window.fixture.hasPendingStaleList()")
    await branchSearch.fill("release")
    await oldRelease.waitFor()
    await branchSearch.press("Enter")
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), lastDenseSwitch)
    await page.evaluate("window.fixture.finishStaleList()")
    await branchSearch.waitFor({ state: "hidden" })
    const releaseSwitch = { name: "release", cwd: "/stale-menu", kind: "local" }
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), releaseSwitch)

    await page.evaluate("window.fixture.delayStaleList()")
    await trigger.click()
    await page.waitForFunction("window.fixture.hasPendingStaleList()")
    await branchSearch.fill("feature")
    await branchSearch.press("Enter")
    await page.evaluate('window.fixture.finishStaleList("Branch list read failed")')
    await page.getByRole("alert").getByText("刷新分支列表失败").waitFor()
    await branchList.getByRole("button", { name: "feature-old", exact: true }).waitFor()
    await branchSearch.press("Enter")
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), releaseSwitch)

    await page.evaluate('window.fixture.addStaleMenuBranch("feature"); window.fixture.delayStaleList()')
    await refresh.click()
    await page.waitForFunction("window.fixture.hasPendingStaleList()")
    await branchSearch.press("Enter")
    await page.getByRole("button", { name: "Git 图谱", exact: true }).focus()
    await branchSearch.focus()
    await page.evaluate("window.fixture.finishStaleList()")
    await branchList.getByRole("button", { name: "feature", exact: true }).waitFor()
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), releaseSwitch)
    await branchSearch.press("Enter")
    await branchSearch.waitFor({ state: "hidden" })
    const featureSwitch = { name: "feature", cwd: "/stale-menu", kind: "local" }
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), featureSwitch)

    // A failed fetch can still return up-to-date local refs.
    await trigger.click()
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('[title="刷新分支列表"]')?.disabled === false)
    await page.evaluate('window.fixture.addStaleMenuBranch("patch"); window.fixture.delayStaleList()')
    await refresh.click()
    await page.waitForFunction("window.fixture.hasPendingStaleList()")
    await branchSearch.fill("patch")
    await branchSearch.press("Enter")
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), featureSwitch)
    await page.evaluate('window.fixture.finishStaleList("Origin fetch failed", true)')
    await branchSearch.waitFor({ state: "hidden" })
    assert.deepEqual(await page.evaluate("window.fixture.switched()"), {
      name: "patch", cwd: "/stale-menu", kind: "local"
    })

    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    await otherBranch.waitFor()
    await trigger.click()
    await create.click()
    await branchName.fill("background-failure")
    await page.keyboard.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.keyboard.press("Escape")
    await branchName.waitFor({ state: "hidden" })
    await trigger.click()
    assert.equal(await create.isDisabled(), true)
    await page.getByRole("button", { name: "Git 图谱" }).click()
    await diagram.getByRole("button", { name: /First page/ }).waitFor()
    await page.evaluate('window.fixture.failCreate("后台创建失败详情")')
    await page.getByText("后台创建失败详情").waitFor()
    assert.equal(await diagram.isVisible(), true)
    await page.keyboard.press("Escape")

    await trigger.click()
    await create.click()
    await branchName.fill("background-success")
    await page.keyboard.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await branchName.waitFor({ state: "hidden" })
    await page.evaluate('window.fixture.openWorkspace("/large")')
    await trigger.getByText("bulk-0", { exact: true }).waitFor()
    await page.evaluate("window.fixture.succeedCreate()")
    await page.getByText("已创建并检出新分支 background-success").waitFor()
    assert.equal(await trigger.getByText("bulk-0", { exact: true }).count(), 1)
    assert.equal(await branchName.count(), 0)

    await page.evaluate('window.fixture.openWorkspace("/bare.git")')
    await trigger.getByText("bare-main", { exact: true }).waitFor()
    await trigger.click()
    const bareBranch = page.getByRole("button", { name: "bare-main" })
    await bareBranch.waitFor()
    assert.equal(await bareBranch.isDisabled(), true)
    assert.equal(await create.count(), 0)
    await branchSearch.press("ArrowDown")
    assert.equal(await branchList.evaluate(list => list === document.activeElement), true)
    await page.keyboard.press("PageDown")
    await page.waitForFunction(() => document.querySelector('[aria-label="分支列表"]')!.scrollTop > 0)
    await page.getByRole("button", { name: "Git 图谱" }).click()
    await diagram.getByRole("button", { name: /First page/ }).waitFor()
    assert.equal(await diagram.getByRole("slider", { name: "图谱泳道" }).count(), 0)
    await page.mouse.click(1, 1)
    await diagram.waitFor({ state: "detached" })

    await page.evaluate('window.fixture.openWorkspace("/graph-wide")')
    await trigger.click()
    await page.getByRole("button", { name: "Git 图谱" }).click()
    const wideMerge = diagram.getByRole("button", { name: /Wide merge/ })
    await wideMerge.waitFor()
    const lanes = diagram.getByRole("slider", { name: "图谱泳道" })
    const drawings = history.locator('svg[aria-label="Git 提交图"]')
    const firstDrawing = drawings.first()
    await firstDrawing.and(history.locator('svg[viewBox="0 0 320 420"]')).waitFor()
    assert.equal(await firstDrawing.getAttribute("width"), "320")
    assert.equal(await firstDrawing.getAttribute("viewBox"), "0 0 320 420")
    assert.ok((await drawings.locator("path").count()) <= (await drawings.count()) * 4)
    await wideMerge.dispatchEvent("mouseover")
    await drawings.locator('path[opacity="0.3"]').first().waitFor()
    assert.ok((await drawings.locator("path").count()) <= (await drawings.count()) * 8)
    await lanes.press("End")
    await page.waitForFunction(
      () => document.querySelector('svg[aria-label="Git 提交图"]')?.getAttribute("viewBox") === "8922 0 320 420"
    )
    assert.equal(await wideMerge.isVisible(), true)
    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    await diagram.waitFor({ state: "detached" })
    await trigger.click()
    await create.click()
    await branchName.fill("alias-late-branch")
    await page.keyboard.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.evaluate('window.fixture.openWorkspace("/elsewhere/subdir")')
    await trigger.click()
    await page.getByRole("button", { name: "Git 图谱" }).click()
    await diagram.getByRole("button", { name: /HEAD background-success/ }).waitFor()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
      detail: {
        workspacePath: "/elsewhere/subdir",
        repositoryPath: "/elsewhere/subdir",
        branch: "another-head",
        gitDir: "/elsewhere/.git/worktrees/another"
      }
    })))
    assert.equal(await page.evaluate("window.fixture.aliasGraphRequests()"), 1)
    await page.evaluate("window.fixture.succeedCreate()")
    await diagram.getByRole("button", { name: /HEAD alias-late-branch/ }).waitFor()
    assert.equal(await page.evaluate("window.fixture.aliasGraphRequests()"), 2)
    await page.keyboard.press("Escape")
    await trigger.getByText("alias-late-branch", { exact: true }).waitFor()

    await page.evaluate('window.fixture.openWorkspace("/elsewhere")')
    await trigger.click()
    await create.click()
    await branchName.fill("alias-during-probe")
    await page.keyboard.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.evaluate('window.fixture.delayAliasProbe(); window.fixture.openWorkspace("/elsewhere/subdir")')
    await page.waitForFunction("window.fixture.hasPendingAliasProbe()")
    await page.evaluate("window.fixture.succeedCreate()")
    await page.getByText("已创建并检出新分支 alias-during-probe").waitFor()
    await page.evaluate("window.fixture.finishAliasProbe()")
    await trigger.getByText("alias-during-probe", { exact: true }).waitFor()
    await page.evaluate('window.fixture.openWorkspace("/recovery")')
    for (const name of ["topic\u00a0", "topic"]) {
      await trigger.click()
      await branchSearch.fill(name)
      await branchSearch.press("Enter")
      await page.waitForFunction(name => window.fixture.switched()?.name === name, name)
    }

    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "panel-before-change")
      window.fixture.openWorkspace("/elsewhere")
    })
    await trigger.click()
    await create.click()
    await branchName.fill("refresh-git-panel")
    await page.keyboard.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await page.evaluate('window.fixture.openWorkspace("/elsewhere/subdir", true)')
    const gitPanel = page.getByRole("region", { name: "Git 面板" })
    await gitPanel.getByText("分支 panel-before-change", { exact: true }).waitFor()
    await trigger.getByText("panel-before-change", { exact: true }).waitFor()

    const pullButton = gitPanel.getByRole("button", { name: "Pull 远端代码" })
    const commitButton = gitPanel.getByRole("button", { name: "Commit 提交" })
    assert.equal(await pullButton.isDisabled(), true)
    assert.equal(await commitButton.isDisabled(), true)
    assert.equal(await gitPanel.getByRole("button", { name: "Push 推送" }).isDisabled(), true)
    const editableDiff = gitPanel.getByRole("button", { name: "查看 edited.txt 的 diff" })
    const previousFileContents = gitPanel.getByText("panel-before-change file contents", { exact: true })
    await editableDiff.click()
    await previousFileContents.waitFor()
    await editableDiff.click()
    await previousFileContents.waitFor({ state: "hidden" })

    await page.evaluate(async () => {
      window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
        detail: {
          workspacePath: "/other-worktree",
          repositoryPath: "/other-worktree",
          branch: "unrelated-head",
          gitDir: "/elsewhere/.git/worktrees/another",
          gitRoot: "/other-worktree"
        }
      }))
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    })
    const panelReads = [["meta", "/elsewhere/subdir"], ["diff", "/elsewhere/subdir"]]
    assert.deepEqual(await page.evaluate("window.fixture.gitPanelReads()"), panelReads)

    await page.evaluate("window.fixture.succeedCreate()")
    await trigger.getByText("refresh-git-panel", { exact: true }).waitFor()
    await gitPanel.getByText("分支 refresh-git-panel", { exact: true }).waitFor({ timeout: 3000 })
    await page.waitForFunction("window.fixture.gitPanelReads().length >= 4")
    assert.deepEqual(await page.evaluate("window.fixture.gitPanelReads()"), [...panelReads, ...panelReads])
    await pullButton.and(gitPanel.locator(":enabled")).waitFor()

    await gitPanel.getByRole("button", { name: "查看 edited.txt 的 diff" }).click()
    await page.waitForFunction("window.fixture.hasPendingPanelFileDiff()")
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "watcher-test")
      window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
        detail: {
          workspacePath: "/elsewhere", repositoryPath: "/elsewhere",
          gitRoot: "/elsewhere", gitDir: "/elsewhere/.git", branch: "watcher-test"
        }
      }))
      setTimeout(() => window.fixture.notifyPanelFiles("/elsewhere/subdir", "meta"), 500)
    })
    await page.evaluate("window.fixture.finishPanelFileDiff()")
    await gitPanel.getByText("分支 watcher-test", { exact: true }).waitFor()
    await page.waitForFunction("window.fixture.gitPanelReads().length >= 6")
    await gitPanel.getByText("watcher-test file contents", { exact: true }).waitFor()
    assert.equal(await gitPanel.getByText("refresh-git-panel file contents", { exact: true }).count(), 0)
    await page.evaluate('window.fixture.notifyPanelFiles("/elsewhere/subdir", "file")')
    await page.waitForFunction("window.fixture.gitPanelReads().length >= 7")
    assert.deepEqual(await page.evaluate("window.fixture.gitPanelReads()"), [
      ...panelReads, ...panelReads, ...panelReads, ["diff", "/elsewhere/subdir"]
    ])
    await commitButton.click()
    const commitDialog = page.getByRole("dialog").getByText("Git Commit", { exact: true })
    await commitDialog.waitFor()
    const readsBeforeCheckout = await page.evaluate<number>("window.fixture.gitPanelReads().length")
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
        detail: {
          workspacePath: "/elsewhere/subdir", repositoryPath: "/other-worktree",
          gitRoot: "/other-worktree", gitDir: "/other-worktree/.git", branch: "other-worktree"
        }
      }))
    })
    assert.equal(await commitDialog.isVisible(), true)
    await page.evaluate(() => {
      window.fixture.delayNextPanelDiff()
      window.fixture.externalCheckout("/elsewhere", "confirmed-checkout")
      window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
        detail: {
          workspacePath: "/elsewhere/subdir", repositoryPath: "/elsewhere",
          gitRoot: "/elsewhere", gitDir: "/elsewhere/.git", branch: "confirmed-checkout"
        }
      }))
    })
    await commitDialog.waitFor({ state: "hidden" })
    await gitPanel.getByText("分支 confirmed-checkout", { exact: true }).waitFor()
    await page.waitForFunction("window.fixture.hasPendingCheckoutDiff()")
    assert.equal(await gitPanel.getByText("watcher-test file contents", { exact: true }).count(), 0)
    assert.equal(await commitButton.isDisabled(), true)
    assert.equal(await gitPanel.getByRole("button", { name: "Push 推送" }).isDisabled(), true)
    assert.equal(await gitPanel.getByRole("button", { name: "全部回退" }).count(), 0)
    await page.evaluate("window.fixture.finishCheckoutDiff()")
    await gitPanel.getByText("confirmed-checkout file contents", { exact: true }).waitFor()
    assert.equal(await commitButton.isEnabled(), true)
    assert.equal(await page.evaluate("window.fixture.gitPanelReads().length"), readsBeforeCheckout + 2)

    await commitButton.click()
    await commitDialog.waitFor()
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "external-head")
      window.fixture.notifyPanelFiles("/elsewhere/subdir", "meta")
    })
    await commitDialog.waitFor({ state: "hidden" })
    await trigger.getByText("external-head", { exact: true }).waitFor()
    await trigger.click()
    const previousHead = page.getByRole("region", { name: "分支列表" }).getByRole("button", { name: /external-head/ })
    await previousHead.waitFor()
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "terminal-while-open")
      window.fixture.notifyPanelFiles("/elsewhere/subdir", "meta")
    })
    await previousHead.click()
    await page.waitForFunction(() => window.fixture.switched()?.name === "external-head")
    await trigger.getByText("external-head", { exact: true }).waitFor()
    await trigger.click()
    await create.click()
    await branchName.fill("duplicate")
    await branchName.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    assert.equal(await page.locator("#git-pull-button").isDisabled(), true)
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "terminal-during-create")
      window.fixture.notifyPanelFiles("/elsewhere/subdir", "meta")
      window.fixture.failCreate()
    })
    await page.getByRole("alert").getByText("分支已存在").waitFor()
    await page.keyboard.press("Escape")
    await trigger.getByText("terminal-during-create", { exact: true }).waitFor()
    await pullButton.and(gitPanel.locator(":enabled")).waitFor()
    await page.evaluate('window.fixture.openWorkspace("/workspace", true)')
    await gitPanel.getByRole("button", { name: /操作仓库.*全部仓库/ }).click()
    await page.locator('button[title="/workspace/lib"]').click()
    await pullButton.click()
    await page.waitForFunction(() => window.fixture.pendingPullPath() === "/workspace/lib")
    await page.evaluate(() => {
      window.fixture.delayNextPanelDiff()
      window.fixture.externalCheckout("/workspace/app", "app-checkout")
      window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
        detail: {
          workspacePath: "/workspace", repositoryPath: "/workspace/app",
          gitRoot: "/workspace/app", branch: "app-checkout"
        }
      }))
    })
    await page.waitForFunction("window.fixture.hasPendingCheckoutDiff()")
    await page.evaluate('window.fixture.failPull("lib remote unavailable")')
    await page.locator("[data-sonner-toast]").filter({ hasText: "lib remote unavailable" }).waitFor()
    assert.equal(await gitPanel.getByRole("button", { name: "查看 edited.txt 的 diff" }).isVisible(), true)
    await gitPanel.getByRole("button", { name: /操作仓库.*lib/ }).click()
    await page.locator('button[title="/workspace/app"]').click()
    assert.equal(await pullButton.isDisabled(), true)
    assert.equal(await gitPanel.getByRole("button", { name: "查看 edited.txt 的 diff" }).count(), 0)
    await page.evaluate("window.fixture.finishCheckoutDiff()")
    await gitPanel.getByRole("button", { name: "查看 new.txt 的 diff" }).waitFor()

    // A late result belongs to its original checkout, even if the same panel now shows a different branch.
    await pullButton.click()
    await page.waitForFunction(() => window.fixture.pendingPullPath() === "/workspace/app")
    await page.evaluate(() => {
      window.fixture.externalCheckout("/workspace/app", "race-target-newer")
      window.dispatchEvent(new CustomEvent("cmb:git-branch-switched", {
        detail: {
          workspacePath: "/workspace", repositoryPath: "/workspace/app",
          gitRoot: "/workspace/app", branch: "race-target-newer"
        }
      }))
      window.fixture.failPull("prior checkout remote unavailable")
    })
    const lateError = page.locator("[data-sonner-toast]").filter({ hasText: "prior checkout remote unavailable" })
    await lateError.waitFor()
    assert.equal(await lateError.count(), 1)
    assert.match(await lateError.innerText(), /切换分支前的操作（app）/)
    assert.equal(await gitPanel.getByText(/prior checkout remote unavailable/).count(), 0)

    // A slow checkout must leave other repositories accessible in the same branch menu.
    await trigger.getByText("app · race-target-newer", { exact: true }).waitFor()
    await page.evaluate("window.fixture.delaySwitch()")
    await trigger.click()
    await branchList.getByRole("button", { name: "same-chat-target", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    assert.equal(await create.isDisabled(), true)
    assert.equal(await repository.isEnabled(), true)
    await repository.selectOption("/workspace/lib")
    await page.getByRole("button", { name: "Git 图谱" }).click()
    await diagram.getByRole("button", { name: /lib HEAD terminal/ }).waitFor()
    await page.keyboard.press("Escape")
    await trigger.click()
    await branchList.getByRole("button", { name: "lib-review", exact: true }).click()
    await trigger.getByText("lib · lib-review", { exact: true }).waitFor()
    await trigger.click()
    await repository.selectOption("/workspace/app")
    assert.equal(await create.isDisabled(), true)
    await repository.selectOption("/workspace/lib")
    await create.click()
    await branchName.fill("lib-created-in-same-chat")
    await branchName.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    assert.equal(await page.evaluate("window.fixture.hasPendingSwitch()"), true)
    await page.evaluate(() => window.fixture.finishSwitch({
      success: true, branch: "same-chat-target", headChanged: true,
      gitRoot: "/workspace/app", warning: "原仓库的后台 hook 警告"
    }))
    const sameChatResult = page.locator("[data-sonner-toast]").filter({ hasText: "/workspace/app 已切换分支 same-chat-target" })
    await sameChatResult.getByText("原仓库的后台 hook 警告", { exact: true }).waitFor()
    assert.equal(await branchName.inputValue(), "lib-created-in-same-chat")
    assert.equal(await page.getByRole("dialog").getByRole("alert").count(), 0)
    await page.evaluate("window.fixture.succeedCreate()")
    await trigger.getByText("lib · lib-created-in-same-chat", { exact: true }).waitFor()
    await trigger.click()
    assert.equal(
      await repository.locator('option[value="/workspace/app"]').textContent(),
      "app · same-chat-target"
    )
    await page.keyboard.press("Escape")
    await page.evaluate('window.fixture.externalCheckout("/workspace/app", "race-target-newer")')

    // Leaving the panel preserves the result of the operation started in the old workspace.
    await pullButton.click()
    await page.waitForFunction(() => window.fixture.pendingPullPath() === "/workspace/app")
    await page.evaluate('window.fixture.openWorkspace("/elsewhere", true)')
    await gitPanel.getByText("分支 terminal-during-create", { exact: true }).waitFor()
    await page.evaluate('window.fixture.failPull("background transport failed")')
    const backgroundError = page.locator("[data-sonner-toast]").filter({ hasText: "background transport failed" })
    await backgroundError.waitFor()
    assert.match(await backgroundError.innerText(), /后台 Git 操作（\/workspace\/app）/)
    assert.equal(await gitPanel.getByText(/background transport failed/).count(), 0)

    // Change chats while A is still checking out. The grouped panel can follow B's files and checkout.
    await page.evaluate('window.fixture.openWorkspace("/workspace/app")')
    await trigger.getByText("race-target-newer", { exact: true }).waitFor()
    await page.evaluate("window.fixture.delaySwitch()")
    await trigger.click()
    await page.getByRole("region", { name: "分支列表" }).getByRole("button", { name: "race-target", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate('window.fixture.openWorkspace("/workspace", true)')
    await gitPanel.getByRole("button", { name: /操作仓库.*全部仓库/ }).click()
    await page.locator('button[title="/workspace/lib"]').click()
    await gitPanel.getByRole("button", { name: "查看 edited.txt 的 diff" }).waitFor()
    await page.evaluate(() => {
      window.fixture.setRepositoryChangedFile("/workspace/lib", "watcher-new.txt")
      window.fixture.notifyPanelFiles("/workspace", "file", {
        kind: "patch",
        upserts: [{ path: "/lib/watcher-new.txt", is_dir: false, size: 1, modified_at: 1 }],
        deletes: ["/lib/edited.txt"]
      })
    })
    await gitPanel.getByRole("button", { name: "查看 watcher-new.txt 的 diff" }).waitFor({ timeout: 2500 })
    assert.equal(await page.evaluate("window.fixture.hasPendingSwitch()"), true)

    await trigger.click()
    await repository.selectOption("/workspace/lib")
    await create.click()
    await branchName.fill("lib-created-while-app-pending")
    await branchName.press("Enter")
    await page.waitForFunction("window.fixture.hasPendingCreate()")
    await page.evaluate(() => {
      window.fixture.setRepositoryChangedFile("/workspace/lib", "after-checkout.txt")
      window.fixture.succeedCreate()
    })
    await trigger.getByText("lib · lib-created-while-app-pending", { exact: true }).waitFor()
    await gitPanel.getByRole("button", { name: "查看 after-checkout.txt 的 diff" }).waitFor({ timeout: 2500 })
    assert.equal(await pullButton.isEnabled(), true)
    assert.equal(await page.evaluate("window.fixture.hasPendingSwitch()"), true)
    await page.evaluate("window.fixture.finishSwitch()")
    const toasts = page.locator("[data-sonner-toast]")
    await toasts.getByText("/workspace/app 已切换分支 race-target", { exact: true }).waitFor()
    assert.equal(await trigger.getByText("lib · lib-created-while-app-pending", { exact: true }).count(), 1)

    // Show a hook warning on the original repository's result after leaving its chat.
    await page.evaluate('window.fixture.openWorkspace("/workspace/app")')
    await trigger.getByText("race-target", { exact: true }).waitFor()
    await page.evaluate("window.fixture.delaySwitch()")
    await trigger.click()
    await page.getByRole("region", { name: "分支列表" }).getByRole("button", { name: "race-target-newer", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate('window.fixture.openWorkspace("/bare.git")')
    await trigger.getByText("bare-main", { exact: true }).waitFor()
    await page.evaluate(() => window.fixture.finishSwitch({
      success: true, branch: "race-target-newer", headChanged: true, warning: "原仓库的 post-checkout hook 失败"
    }))
    const backgroundWarning = toasts.filter({ hasText: "/workspace/app 已切换分支 race-target-newer" })
    await backgroundWarning.getByText("原仓库的 post-checkout hook 失败", { exact: true }).waitFor()

    // Another process may already have checked out the target before Git handles the request.
    await page.evaluate('window.fixture.openWorkspace("/workspace/app")')
    await trigger.getByText("race-target-newer", { exact: true }).waitFor()
    await page.evaluate("window.fixture.delaySwitch()")
    await trigger.click()
    await page.getByRole("group", { name: "本地分支" }).getByRole("button", { name: "origin/topic", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate('window.fixture.openWorkspace("/bare.git")')
    await trigger.getByText("bare-main", { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.fixture.externalCheckout("/workspace/app", "origin/topic")
      window.fixture.finishSwitch({ success: true, branch: "origin/topic", headChanged: false })
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    assert.equal(await toasts.getByText("已切换分支 origin/topic", { exact: false }).count(), 0)

    await page.evaluate('window.fixture.openWorkspace("/workspace/app")')
    await trigger.getByText("origin/topic", { exact: true }).waitFor()
    await page.evaluate("window.fixture.delaySwitch()")
    await trigger.click()
    await branchList.getByRole("button", { name: "race-target-newer", exact: true }).click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    const beforeNoOpClose = await page.evaluate("window.fixture.branchCancellations()")
    await page.evaluate(async () => {
      window.fixture.externalCheckout("/workspace/app", "race-target-newer")
      window.fixture.finishSwitch({ success: true, branch: "race-target-newer", headChanged: false })
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    await trigger.getByText("race-target-newer", { exact: true }).waitFor()
    await menu.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate("window.fixture.branchCancellations()"), Number(beforeNoOpClose) + 1)
    assert.equal(await toasts.getByText("已切换分支 race-target-newer", { exact: true }).count(), 0)

    // A terminal checkout can change HEAD without touching the watched subdirectory.
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "before-terminal-checkout")
      window.fixture.openWorkspace("/elsewhere/subdir", true)
    })
    await gitPanel.getByText("分支 before-terminal-checkout", { exact: true }).waitFor()
    const staleFileSelection = gitPanel.getByRole("checkbox", { name: "选择文件 edited.txt" })
    await staleFileSelection.check()
    await trigger.click()
    const alreadyCheckedOut = branchList.getByRole("button", { name: "already-checked-out", exact: true })
    await alreadyCheckedOut.waitFor()
    const beforeExternalHeads = await page.evaluate<number>("window.fixture.branchEvents().length")
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "already-checked-out")
      window.dispatchEvent(new Event("focus"))
      window.fixture.delaySwitch()
    })
    await alreadyCheckedOut.click()
    await page.waitForFunction("window.fixture.hasPendingSwitch()")
    await page.evaluate(() => window.fixture.finishSwitch({
      success: true, branch: "already-checked-out", headChanged: false
    }))
    await menu.waitFor({ state: "hidden" })
    await gitPanel.getByText("分支 already-checked-out", { exact: true }).waitFor()
    await staleFileSelection.waitFor()
    assert.equal(await staleFileSelection.isChecked(), false)
    assert.equal(await toasts.getByText("已切换分支 already-checked-out", { exact: true }).count(), 0)
    assert.equal(await page.evaluate("window.fixture.branchEvents().length"), beforeExternalHeads + 1)

    await trigger.click()
    await refresh.and(page.locator(":enabled")).waitFor()
    await page.evaluate(() => {
      window.fixture.externalCheckout("/elsewhere", "head-from-ref-list")
      window.dispatchEvent(new Event("focus"))
    })
    await refresh.click()
    await page.evaluate('window.fixture.finishRefresh("/elsewhere/subdir")')
    await branchList.getByRole("button", { name: /head-from-ref-list/ }).waitFor()
    await gitPanel.getByText("分支 head-from-ref-list", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await menu.waitFor({ state: "hidden" })
    assert.equal(await page.evaluate("window.fixture.branchEvents().length"), beforeExternalHeads + 2)

    await page.evaluate('window.fixture.openWorkspace("/retry-single")')
    const retryRepository = page.getByRole("button", { name: "重新读取 Git 仓库" })
    await retryRepository.click()
    await trigger.getByText("main", { exact: true }).waitFor()
    await trigger.click()
    assert.equal(await create.isEnabled(), true)
    assert.equal(await page.getByRole("button", { name: "Git 图谱", exact: true }).isEnabled(), true)

    await page.evaluate('window.fixture.openWorkspace("/graph-retry")')
    await trigger.getByText("retry-graph-main", { exact: true }).waitFor()
    await trigger.click()
    await page.getByRole("button", { name: "Git 图谱", exact: true }).click()
    const retryHistory = diagram.getByRole("region", { name: "提交历史" })
    const graphError = diagram.getByRole("alert")
    const retryGraph = diagram.getByRole("button", { name: "重试加载" })
    const waitForGraphRead = (count: number) => page.waitForFunction(
      (expected) => window.fixture.graphRetryReads().length === expected, count
    )
    await waitForGraphRead(2)
    await page.evaluate(async () => {
      window.fixture.finishGraphRetryRead("Automatic prefetch failed")
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
    })
    assert.equal(await graphError.count(), 0)

    await graphRefresh.click()
    await waitForGraphRead(3)
    await page.evaluate('window.fixture.finishGraphRetryRead("Refresh failed")')
    await graphError.filter({ hasText: "Refresh failed" }).waitFor()
    await retryHistory.getByText("Initial commit 0", { exact: true }).waitFor()
    await retryGraph.click()
    await waitForGraphRead(4)
    assert.deepEqual(await page.evaluate("window.fixture.graphRetryReads()"), [
      [0, undefined], [50, "Initial"], [0, undefined], [0, undefined]
    ])

    await page.evaluate("window.fixture.finishGraphRetryRead()")
    await retryHistory.getByText("Refreshed commit 0", { exact: true }).waitFor()
    await waitForGraphRead(5)
    await retryHistory.evaluate((node) => { node.scrollTop = node.scrollHeight })
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="提交历史"]')?.getAttribute("aria-busy") === "true"
    )
    await page.evaluate('window.fixture.finishGraphRetryRead("Next page failed")')
    await graphError.filter({ hasText: "Next page failed" }).waitFor()
    await retryGraph.click()
    await waitForGraphRead(6)
    assert.deepEqual(await page.evaluate("window.fixture.graphRetryReads().slice(-2)"), [
      [50, "Refreshed"], [50, "Refreshed"]
    ])
    await page.evaluate("window.fixture.finishGraphRetryRead()")
    await retryHistory.getByText("End of retry graph", { exact: true }).waitFor()
    assert.equal(await graphError.count(), 0)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
