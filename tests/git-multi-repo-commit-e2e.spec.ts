/**
 * Real Electron E2E for the multi-repository Git commit flow.
 *
 * The test creates a main checkout plus a linked worktree below a non-Git
 * parent, changes the same tracked file in both, then drives the real Git Panel
 * through Playwright. It proves that the repository selector is reachable and
 * that submitting the dialog commits only the selected linked worktree. It
 * also authorizes a same-named checkout outside the workspace and verifies
 * that the panel isolates its file list and diff until access is revoked.
 *
 * Run:
 *   npm run test:git:e2e
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs"
import { rm as rmAsync } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { _electron as electron, type ElectronApplication, type Page } from "playwright"

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const ELECTRON_PACKAGE_ROOT = dirname(require.resolve("electron/package.json"))
const ELECTRON_BINARY = join(
  ELECTRON_PACKAGE_ROOT,
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron"
)
const ELECTRON_LAUNCHER =
  process.platform === "win32"
    ? join(PROJECT_ROOT, "tests", "support", "electron-launcher.cmd")
    : ELECTRON_BINARY
const MAIN_ENTRY = join(PROJECT_ROOT, "out", "main", "index.js")
const SCREENSHOT_DIR = join(PROJECT_ROOT, "tests", "screenshots")
const THREAD_TITLE = `Git multi-repository commit E2E ${process.pid}-${Date.now()}`
const WORKSPACE_BRANCH = "e2e-workspace"
const LINKED_BRANCH = "e2e-linked-worktree"
const EXTERNAL_BRANCH = "e2e-authorized"
const EXPECTED_COMMIT_MESSAGE =
  "M10000749-9 #comment fix:e2e multi-repository target #CMBDevClaw"

interface WindowWithApi {
  api: {
    threads: {
      create: (metadata?: Record<string, unknown>) => Promise<{
        id?: string
        thread_id?: string
        threadId?: string
      }>
      delete: (threadId: string) => Promise<void>
    }
    workspace: {
      set: (threadId: string, workspacePath: string) => Promise<unknown>
      getGitPanelDiffs: (
        threadId: string,
        options: {
          includeDiffs: boolean
          includeChangedFiles: boolean
          worktreePath?: string
          commitBindingVersion?: string
        }
      ) => Promise<{
        success: boolean
        error?: string
        repositories?: Array<{ path: string; displayPath: string }>
        changedFiles?: string[]
        commitPreviewRevision?: string
      }>
      commitWorktree: (
        thread: string,
        message: string,
        files: string[],
        options: { worktreePath: string; commitBindingVersion: string; commitPreviewRevision: string }
      ) => Promise<{ success: boolean; error?: string }>
    }
    taskCommitBinding: {
      read: (thread: string) => Promise<{ cardNumber: string; version: string; repositoryPaths: string[] } | null>
    }
  }
}

function log(message: string): void {
  console.log(`[git-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
  log(`PASS ${message}`)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null"
    }
  }).trim()
}

function initializeRepository(mainRepository: string, linkedWorktree: string): string {
  mkdirSync(mainRepository, { recursive: true })
  git(mainRepository, ["init", "-q"])
  git(mainRepository, ["config", "user.name", "Git E2E"])
  git(mainRepository, ["config", "user.email", "git-e2e@example.invalid"])
  writeFileSync(join(mainRepository, "tracked.txt"), "initial\n")
  git(mainRepository, ["add", "tracked.txt"])
  git(mainRepository, ["commit", "-q", "-m", "initial"])
  git(mainRepository, ["branch", "-m", WORKSPACE_BRANCH])
  const initialCommit = git(mainRepository, ["rev-parse", "HEAD"])
  git(mainRepository, ["worktree", "add", "-q", "-b", LINKED_BRANCH, linkedWorktree])
  writeFileSync(join(mainRepository, "tracked.txt"), "pending in main checkout\n")
  writeFileSync(join(linkedWorktree, "tracked.txt"), "pending in linked worktree\n")
  return initialCommit
}

async function waitForApi(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded")
  await page.waitForFunction(() => Boolean((window as unknown as Partial<WindowWithApi>).api), {
    timeout: 30_000
  })
}

async function waitForAppPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const candidate of app.windows().reverse()) {
      if (candidate.isClosed()) continue
      const hasApi = await candidate
        .evaluate(() => Boolean((window as unknown as Partial<WindowWithApi>).api))
        .catch(() => false)
      if (hasApi) return candidate
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error("No Electron renderer with preload API appeared within 30 seconds")
}

async function createWorkspaceThread(page: Page, workspacePath: string): Promise<string> {
  return page.evaluate<string, { title: string; workspacePath: string }>(
    async ({ title, workspacePath }) => {
      const api = (window as unknown as WindowWithApi).api
      const thread = await api.threads.create({
        workspacePath,
        model: "custom:git-e2e-no-model",
        title
      })
      const threadId = thread.thread_id || thread.id || thread.threadId
      if (!threadId) throw new Error(`threads.create returned no id: ${JSON.stringify(thread)}`)
      await api.workspace.set(threadId, workspacePath)
      const gitState = await api.workspace.getGitPanelDiffs(threadId, {
        includeDiffs: false,
        includeChangedFiles: true
      })
      if (!gitState.success || gitState.repositories?.length !== 2) {
        throw new Error(
          `Expected two Git repositories before UI navigation: ${JSON.stringify(gitState)}`
        )
      }
      return threadId
    },
    { title: THREAD_TITLE, workspacePath }
  )
}

async function runGitPanelCommit(page: Page): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" })
  await waitForApi(page)
  const threadEntry = page.getByText(THREAD_TITLE, { exact: true }).first()
  await threadEntry.waitFor({ timeout: 30_000 })
  await threadEntry.click()
  // Selecting a thread intentionally resets the right panel to workspace mode.
  // Let that effect settle before opening Git, otherwise an unrealistically fast
  // E2E click can be overwritten by the pending reset.
  await page.waitForTimeout(750)

  const gitPanelButton = page.getByRole("button", { name: "Git 面板" })
  await gitPanelButton.waitFor({ timeout: 30_000 })
  await gitPanelButton.click()
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Git 面板"]')
    return button?.getAttribute("aria-pressed") === "true"
  })

  const openCommitButton = page.locator("button").filter({ hasText: /^Commit$/ }).first()
  try {
    await openCommitButton.waitFor({ timeout: 30_000 })
  } catch (waitError) {
    const bodyText = await page.locator("body").innerText().catch(() => "<body unavailable>")
    console.error(`[git-e2e] UI snapshot before Commit timeout:\n${bodyText.slice(0, 8_000)}`)
    throw waitError
  }
  await openCommitButton.waitFor({ state: "visible" })
  await page.waitForFunction(() => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === "Commit"
    )
    return Boolean(button && !button.disabled)
  })
  // Both checkouts contain a change. Select both so the dialog must narrow
  // the file list when the user chooses the linked worktree.
  await page.getByRole("button", { name: "全选文件", exact: true }).click()
  await openCommitButton.click()

  const dialog = page.locator('[role="dialog"]').filter({ hasText: "Git Commit" })
  await dialog.waitFor({ timeout: 15_000 })
  assert(await dialog.locator("#git-commit-repository").isVisible(), "提交仓库选择器真实可见")
  assert(await dialog.getByText("0 文件", { exact: true }).isVisible(), "未选仓库前不会扩大提交范围")

  await dialog.locator("#git-commit-repository").click()
  await page.getByRole("option", { name: "linked" }).click()
  await dialog.getByText(LINKED_BRANCH, { exact: true }).waitFor({ timeout: 15_000 })
  assert(await dialog.getByText("Git Worktree", { exact: true }).isVisible(), "目标被识别为 linked worktree")
  await dialog.getByText("1 文件", { exact: true }).waitFor({ timeout: 15_000 })
  assert(await dialog.getByText("1 文件", { exact: true }).isVisible(), "选择目标后仅统计该仓库文件")

  await dialog.getByRole("button", { name: "选择任务卡片" }).click()
  await page.getByRole("button", { name: /M10000749-9/ }).click()
  await dialog.locator("#git-commit-type").click()
  await page.getByRole("option", { name: "fix", exact: true }).click()
  await dialog.locator("#git-message").fill("e2e multi-repository target")

  const submitButton = dialog.locator("#git-commit-button")
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>("#git-commit-button")
    return Boolean(button && !button.disabled)
  })
  await submitButton.click()
  await dialog.waitFor({ state: "hidden", timeout: 30_000 })
  await page.getByText("提交成功", { exact: true }).waitFor({ timeout: 15_000 })
  log("PASS 真实 Electron UI 完成 Commit")
}

async function verifyAuthorizedPanel(
  page: Page,
  mainRepository: string,
  linkedWorktree: string,
  external: string
): Promise<void> {
  const picker = page.getByRole("button", { name: /^操作仓库/ })
  const option = (repository: string) =>
    page.getByRole("dialog").getByRole("button").filter({ hasText: repository })
  await picker.click()
  const mainOption = option(mainRepository)
  const externalOption = option(external)
  await mainOption.filter({ hasText: WORKSPACE_BRANCH }).waitFor()
  await externalOption.filter({ hasText: EXTERNAL_BRANCH }).waitFor()
  await page.screenshot({ path: join(SCREENSHOT_DIR, "git-panel-authorized-repositories.png") })
  log("PASS 同名工作区仓库与新授权仓库均显示绝对路径和分支")

  const file = (path: string) =>
    page.getByRole("button", { name: `查看 ${path} 的 diff`, exact: true })
  await mainOption.click()
  await file("workspace-only.txt").waitFor()
  await file("external-only.txt").waitFor({ state: "hidden" })
  await file("tracked.txt").click()
  const workspaceLine = page.getByText("pending in main checkout", { exact: true })
  await workspaceLine.waitFor()

  await picker.click()
  await externalOption.click()
  await file("external-only.txt").waitFor()
  await file("workspace-only.txt").waitFor({ state: "hidden" })
  await file("tracked.txt").click()
  const externalLine = page.getByText("reviewed external change", { exact: true })
  await externalLine.waitFor()
  await workspaceLine.waitFor({ state: "hidden" })
  await page.screenshot({ path: join(SCREENSHOT_DIR, "git-panel-authorized-diff.png") })
  log("PASS 切换同名仓库后只显示所选仓库的文件列表和 tracked.txt 内容")

  await picker.click()
  await option(linkedWorktree).filter({ hasText: LINKED_BRANCH }).click()
  await file("linked-only.txt").waitFor()
  await file("workspace-only.txt").waitFor({ state: "hidden" })
  await externalLine.waitFor({ state: "hidden" })
  await picker.click()
  await externalOption.click()
  await file("tracked.txt").click()
  await externalLine.waitFor()
  log("PASS 从外部仓库切回指定的工作区子仓库并再次打开外部 diff")
}

async function verifyExternalTaskBinding(
  app: ElectronApplication,
  page: Page,
  threadId: string,
  mainRepository: string,
  linkedWorktree: string,
  external: string
): Promise<void> {
  writeFileSync(join(mainRepository, "workspace-only.txt"), "workspace only\n")
  writeFileSync(join(linkedWorktree, "linked-only.txt"), "linked only\n")
  writeFileSync(join(external, "external-only.txt"), "external only\n")
  writeFileSync(join(external, "tracked.txt"), "reviewed external change\n")
  // Supply only the native folder-picker response. The desktop frame, binding
  // editor, authorization checks, database, preview and Git execution are real.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
  }, external)
  page.setDefaultTimeout(15_000)
  await page.getByRole("button", { name: "任务提交设置", exact: true }).click()
  log("已打开当前会话的任务提交设置")
  const settings = page.getByRole("dialog", { name: "本任务的 Git 提交" })
  const choose = settings.getByRole("button", { name: "选择本地仓库" })
  await choose.or(settings.getByRole("alert")).first().waitFor()
  if (!(await choose.isVisible())) throw new Error(await settings.innerText())
  await choose.click()
  await settings.getByRole("checkbox", { name: external }).waitFor()
  const clear = settings.getByRole("button", { name: "清除预选任务卡" })
  if (await clear.isVisible()) await clear.click()
  await settings.getByRole("button", { name: "选择或输入任务卡号" }).click()
  await page.getByPlaceholder("手动输入卡号").fill("QA-EXTERNAL")
  await page.keyboard.press("Escape")
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await settings.screenshot({ path: join(SCREENSHOT_DIR, "task-commit-desktop.png") })
  await settings.getByRole("button", { name: "确认本任务授权" }).click()
  await settings.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "QA-EXTERNAL", exact: true }).waitFor()
  try {
    await verifyAuthorizedPanel(page, mainRepository, linkedWorktree, external)
  } catch (error) {
    console.error(`[git-e2e] 授权仓库面板快照：\n${await page.locator("body").innerText()}`)
    throw error
  }
  unlinkSync(join(external, "external-only.txt"))

  const hooks = join(external, ".git", "task-hooks")
  mkdirSync(hooks)
  git(external, ["config", "core.hooksPath", ".git/task-hooks"])
  writeFileSync(join(hooks, "pre-commit"), [
    "#!/bin/sh",
    'test "$(git diff --cached --name-only)" = tracked.txt || exit 1',
    'echo checked > "$(git rev-parse --git-dir)/task-hook-receipt"'
  ].join("\n") + "\n", { mode: 0o755 })
  const message = "QA-EXTERNAL #comment test:review external change #CMBDevClaw"
  const openPreview = () =>
    page.evaluate(
      async ({ threadId, external }) => {
        const { taskCommitBinding, workspace } = (window as unknown as WindowWithApi).api
        const binding = await taskCommitBinding.read(threadId)
        if (!binding?.repositoryPaths.includes(external) || binding.cardNumber !== "QA-EXTERNAL") {
          throw new Error(
            `Expected persisted binding for ${external}, got ${JSON.stringify(binding)}`
          )
        }
        const options = { worktreePath: external, commitBindingVersion: binding.version }
        const preview = await workspace.getGitPanelDiffs(threadId, {
          ...options,
          includeDiffs: false,
          includeChangedFiles: true
        })
        if (
          !preview.success ||
          preview.changedFiles?.join() !== "tracked.txt" ||
          !preview.commitPreviewRevision
        ) {
          throw new Error(preview.error || "Expected one reviewed external file")
        }
        return { ...options, commitPreviewRevision: preview.commitPreviewRevision }
      },
      { threadId, external }
    )
  const submit = (options: Awaited<ReturnType<typeof openPreview>>) =>
    page.evaluate(
      ({ threadId, message, options }) =>
        (window as unknown as WindowWithApi).api.workspace.commitWorktree(
          threadId,
          message,
          ["tracked.txt"],
          options
        ),
      { threadId, message, options }
    )

  const first = await openPreview()
  const repeat = await openPreview()
  assert(
    first.commitPreviewRevision !== repeat.commitPreviewRevision,
    "授权后可以连续打开有效的新预览"
  )
  const startingHead = git(external, ["rev-parse", "HEAD"])
  git(external, ["checkout", "-q", "-b", "same-tip-branch"])
  const stale = await submit(repeat)
  assert(
    !stale.success && Boolean(stale.error?.includes("变化")),
    "切换到相同 SHA 的另一分支后拒绝旧预览"
  )
  assert(git(external, ["rev-parse", "HEAD"]) === startingHead, "拒绝过期预览时保持原提交")
  const result = await submit(await openPreview())
  assert(result.success, result.error || "桌面授权的外部仓库已完成提交")
  assert(existsSync(join(external, ".git", "task-hook-receipt")), "外仓配置的提交钩子已验证候选暂存区")
  assert(git(external, ["log", "-1", "--format=%s"]) === message, "外部提交使用已保存的任务卡号")

  await page.getByText("当前仓库没有待查看的文件改动", { exact: true }).waitFor()
  await page.getByText("分支 same-tip-branch", { exact: true }).waitFor()
  log("PASS 外部提交后当前面板自动更新分支并清空变更列表")
  writeFileSync(join(external, "tracked.txt"), "pending when access revoked\n")
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await page.getByRole("button", { name: "查看 tracked.txt 的 diff", exact: true }).click()
  const pendingLine = page.getByText("pending when access revoked", { exact: true })
  await pendingLine.waitFor()

  await page.getByRole("button", { name: "QA-EXTERNAL", exact: true }).click()
  await settings.getByRole("button", { name: "撤销授权", exact: true }).click()
  await settings.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: "任务提交设置", exact: true }).waitFor()
  await pendingLine.waitFor({ state: "hidden" })
  await page.getByRole("button", { name: /^操作仓库/ }).click()
  await page.getByText(mainRepository, { exact: true }).waitFor()
  await page.getByText(external, { exact: true }).waitFor({ state: "hidden" })
  log("PASS 撤销后无需重开面板，外部仓库和 diff 消失，工作区仓库仍可选择")
}

async function deleteWorkspaceThread(page: Page, threadId: string): Promise<void> {
  await page.evaluate<void, string>(async (id) => {
    await (window as unknown as WindowWithApi).api.threads.delete(id)
  }, threadId)
}

async function main(): Promise<void> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error(`No built output at ${MAIN_ENTRY}; run npm run build first`)
  }

  const testRoot = mkdtempSync(join(tmpdir(), "cmb-git-multi-repo-e2e-"))
  const isolatedHome = join(testRoot, "home")
  const appData = join(isolatedHome, "AppData", "Roaming")
  const localAppData = join(isolatedHome, "AppData", "Local")
  const openworkHome = join(testRoot, "cmbcoworkagent-home")
  const electronUserData = join(testRoot, "electron-user-data")
  const workspace = join(testRoot, "workspace")
  const mainRepository = join(workspace, "main")
  const linkedWorktree = join(workspace, "linked")
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  mkdirSync(workspace, { recursive: true })

  const initialCommit = initializeRepository(mainRepository, linkedWorktree)
  log(`Temporary workspace: ${workspace} (${git(testRoot, ["--version"])})`)

  const cleanEnv = {
    ...process.env,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    CMB_COWORK_AGENT_HOME: openworkHome,
    CMB_TASK_CARDS_MOCK: "1",
    CMB_E2E_DISABLE_GPU: "1",
    CMB_E2E_ELECTRON_BIN: ELECTRON_BINARY,
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1"
  }
  if (process.platform !== "win32") cleanEnv.HOME = isolatedHome
  delete (cleanEnv as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE

  let app: ElectronApplication | undefined
  let page: Page | undefined
  let threadId: string | undefined
  try {
    app = await electron.launch({
      executablePath: ELECTRON_LAUNCHER,
      args: [MAIN_ENTRY, `--user-data-dir=${electronUserData}`],
      cwd: PROJECT_ROOT,
      env: cleanEnv,
      timeout: 60_000
    })
    page = await waitForAppPage(app)
    await waitForApi(page)
    threadId = await createWorkspaceThread(page, workspace)
    log(`Thread created: ${threadId}`)

    await runGitPanelCommit(page)

    const linkedStatus = git(linkedWorktree, ["status", "--porcelain"])
    const mainStatus = git(mainRepository, ["status", "--porcelain"])
    const linkedHead = git(linkedWorktree, ["rev-parse", "HEAD"])
    const mainHead = git(mainRepository, ["rev-parse", "HEAD"])
    const linkedSubject = git(linkedWorktree, ["log", "-1", "--pretty=%s"])

    assert(linkedStatus === "", "目标 linked worktree 提交后状态干净")
    assert(mainStatus === "M tracked.txt", "未选择的主仓库改动仍然保留")
    assert(linkedHead !== initialCommit, "linked worktree 分支产生新 commit")
    assert(mainHead === initialCommit, "主仓库分支 HEAD 未被移动")
    assert(linkedSubject === EXPECTED_COMMIT_MESSAGE, "最终 commit message 符合 CMB 规范")
    const outside = join(testRoot, "outside")
    mkdirSync(outside)
    const external = join(outside, "main")
    git(testRoot, ["clone", "-q", "--no-local", mainRepository, external])
    git(external, ["checkout", "-q", "-b", EXTERNAL_BRANCH])
    git(external, ["config", "user.name", "Task Commit QA"])
    git(external, ["config", "user.email", "test@example.invalid"])
    await verifyExternalTaskBinding(app, page, threadId, mainRepository, linkedWorktree, external)
    assert(git(mainRepository, ["rev-parse", "HEAD"]) === mainHead, "外部提交保留会话内主仓库的 HEAD")
    log("ALL PASS multi-repository Git commit E2E")
  } finally {
    if (app) {
      if (page && threadId) {
        log(`Deleting temporary thread: ${threadId}`)
        await withTimeout(deleteWorkspaceThread(page, threadId), 5_000, "thread cleanup")
          .then(() => log("Temporary thread removed"))
          .catch((cleanupError) => {
            console.warn(`[git-e2e] thread cleanup deferred: ${String(cleanupError)}`)
          })
      }
      const processHandle = (() => {
        try {
          return app.process()
        } catch {
          return undefined
        }
      })()
      log("Closing isolated Electron app")
      await withTimeout(app.close(), 5_000, "Electron close").catch((closeError) => {
        console.warn(`[git-e2e] graceful close failed: ${String(closeError)}`)
      })
      if (processHandle && processHandle.exitCode === null && !processHandle.killed) {
        processHandle.kill()
      }
      log("Electron app closed")
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    await withTimeout(
      rmAsync(testRoot, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 10 : 2,
        retryDelay: 250
      }),
      5_000,
      "temporary directory cleanup"
    )
      .then(() => log("Temporary data removed"))
      .catch((cleanupError) => {
        console.warn(`[git-e2e] temporary directory cleanup deferred: ${String(cleanupError)}`)
      })
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: Error) => {
    console.error(`\n❌ ${error.stack || error.message}`)
    process.exit(1)
  })
