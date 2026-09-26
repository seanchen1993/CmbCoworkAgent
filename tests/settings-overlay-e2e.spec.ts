/** Real Electron shell, React and preload. Remote market responses are deterministic fixtures. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { _electron, type ElectronApplication, type Page } from "playwright"
import AdmZip from "adm-zip"

const root = resolve(__dirname, "..")
const requireLocal = createRequire(join(root, "package.json"))
const binary = requireLocal("electron") as string
const isolated = mkdtempSync(join(tmpdir(), "cmb-settings-overlay-"))
const artifacts = join(root, "output/settings-overlay")
mkdirSync(artifacts, { recursive: true })
const checks: string[] = []
const pass = (label: string): void => {
  checks.push(label)
  console.log(`PASS ${label}`)
}

type GitFixtureMain = typeof globalThis & {
  gitOverlay: { version: number; reads: Array<{ kind: string; threadId: string }> }
}

async function main(): Promise<void> {
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const errors: string[] = []
  const counts = { lists: 0, downloads: 0 }
  let mcpPublished = false
  const zip = new AdmZip()
  zip.addFile(
    "overlay-skill/SKILL.md",
    Buffer.from(
      "---\nname: overlay-skill\ndescription: settings test\n---\n# Preserved skill preview\n\nOriginal file content."
    )
  )
  const items = Array.from({ length: 24 }, (_, i) => ({
    name: i ? `overlay-skill-${i}` : "overlay-skill",
    description: "Settings overlay regression fixture",
    filename: "overlay-skill.zip",
    created_at: "2026-09-24T10:00:00Z",
    version: "1.0.0",
    category: "开发工具"
  }))
  try {
    // Start with a known logged-in fixture before the renderer's startup login check runs.
    const dataRoot = join(isolated, "data")
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(
      join(dataRoot, "userinfo-models.json"),
      JSON.stringify({
        sapId: "overlay-initial-user",
        ystId: "initial-fixture",
        userName: "Initial Fixture",
        originOrgId: "",
        orgName: "",
        pathName: "",
        originPathId: "",
        ystRefreshToken: "",
        ystCode: "",
        ystAccessToken: ""
      })
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value && /^(path|systemroot|windir|comspec|pathext|display|lang|tmpdir)$/i.test(key)
      )
    ) as Record<string, string>
    Object.assign(env, {
      CMB_COWORK_AGENT_HOME: dataRoot,
      CMB_TASK_CARDS_MOCK: "1",
      CMB_E2E_DISABLE_GPU: "1",
      CMB_E2E_ELECTRON_BIN: binary,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost"
    })
    app = await _electron.launch({
      executablePath:
        process.platform === "win32" ? join(root, "tests/support/electron-launcher.cmd") : binary,
      args: [join(root, "out/main/index.js"), `--user-data-dir=${join(isolated, "electron")}`],
      cwd: root,
      env,
      timeout: 60_000
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await app.evaluate(({ ipcMain }) => {
      for (const channel of ["open-login-page", "open-login-window"]) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => undefined)
      }
      ipcMain.removeHandler("dashboard:isAllowed")
      ipcMain.handle("dashboard:isAllowed", () => true)
      ipcMain.removeHandler("featureGates:isEnabled")
      ipcMain.handle("featureGates:isEnabled", () => ({
        enabled: true,
        reason: "settings-fixture"
      }))
      for (const channel of [
        "dashboard:skillUsageSummary",
        "dashboard:skillUserStats",
        "dashboard:skillRecentTraces",
        "dashboard:userProfiles"
      ]) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => ({ success: false, error: "Fixture has no statistics" }))
      }
    })
    await page.addInitScript("window.__name = (value) => value")
    await page.route("**/cowork/login-info", async (route) => {
      const user = await page!.evaluate(() => window.api.models.getUserInfo())
      await route.fulfill({ json: { returnCode: "SUC0000", body: user } })
    })
    await page.route("**/api/trajectories/marketplace/**", async (route) => {
      if (route.request().url().includes("/list/")) {
        counts.lists++
        const mcp = {
          ...items[0],
          name: "overlay-mcp",
          description: mcpPublished ? "Published from settings" : "Before publish",
          filename: "overlay-mcp.json"
        }
        await route.fulfill({
          json: { items: route.request().url().includes("/list/mcp") ? [mcp] : items }
        })
      } else if (route.request().method() === "POST" || route.request().method() === "PUT") {
        mcpPublished = true
        await route.fulfill({
          json: { name: "overlay-mcp", type: "mcp", message: "Published fixture" }
        })
      } else {
        counts.downloads++
        await route.fulfill({
          body: zip.toBuffer(),
          contentType: "application/zip",
          headers: { "Content-Disposition": 'attachment; filename="overlay-skill.zip"' }
        })
      }
    })
    await page.getByRole("button", { name: "自定义设置", exact: true }).waitFor()
    await page.reload({ waitUntil: "domcontentloaded" })
    page.on("pageerror", (error) => errors.push(error.message))
    await page.getByRole("button", { name: "自定义设置", exact: true }).waitFor()
    await page.evaluate(() =>
      window.api.mcp.create({
        name: "overlay-mcp",
        kind: "stdio",
        command: "node",
        args: [],
        enabled: false
      })
    )
    const open = async (): Promise<void> => {
      await page!.getByRole("button", { name: "自定义设置", exact: true }).click()
      await page!.getByRole("button", { name: "返回应用", exact: true }).waitFor()
      assert.equal(await page!.locator("[data-workspace-surface]").getAttribute("inert"), "")
    }
    const close = async (): Promise<void> => {
      await page!.getByRole("button", { name: "返回应用", exact: true }).click()
      await page!.locator("[data-workspace-surface][inert]").waitFor({ state: "detached" })
    }

    await open()
    await page.evaluate(() => {
      const action = document.createElement("button")
      action.textContent = "Outside notification action"
      action.style.cssText = "position:fixed;top:8px;left:50%;z-index:999999999"
      action.onclick = () => {
        document.body.dataset.settingsNotificationClicked = "true"
      }
      document.body.append(action)
    })
    await page.getByRole("button", { name: "Outside notification action" }).click()
    assert.equal(
      await page.evaluate(() => document.body.dataset.settingsNotificationClicked),
      "true"
    )
    assert.notEqual(
      await page
        .locator(".app-drag-region")
        .first()
        .evaluate((node) => getComputedStyle(node).pointerEvents),
      "none"
    )
    await page
      .getByRole("button", { name: "Outside notification action" })
      .evaluate((node) => node.remove())
    await close()
    pass("settings keeps external notification actions and titlebar interactive")

    await page.getByRole("button", { name: "应用市场", exact: true }).click()
    await page.getByRole("heading", { name: "overlay-skill", exact: true }).waitFor()
    const search = page.getByPlaceholder(/搜索/).last()
    await search.fill("overlay-skill")
    await page.getByRole("heading", { name: "overlay-skill", exact: true }).click()
    await page.getByText("Original file content.", { exact: false }).waitFor()
    const preview = await page.getByText("Original file content.", { exact: false }).elementHandle()
    const before = { ...counts }
    await open()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f")
    await close()
    assert(
      await preview!.evaluate((element) => element.isConnected),
      "market detail DOM must survive"
    )
    assert.deepEqual(counts, before, "ordinary settings return must not refetch lists or ZIP files")
    pass("market detail and file preview stay mounted without repeat downloads")
    await page.screenshot({ path: join(artifacts, "market-return.png") })

    await page.getByRole("button", { name: /返回列表/ }).click()
    assert.equal(await search.inputValue(), "overlay-skill")
    const scroll = page.locator("main [data-radix-scroll-area-viewport]").first()
    await scroll.evaluate((node) => {
      node.scrollTop = 180
    })
    const scrollTop = await scroll.evaluate((node) => node.scrollTop)
    await open()
    await page.keyboard.press("Escape")
    await page.locator("[data-workspace-surface][inert]").waitFor({ state: "detached" })
    assert.equal(await scroll.evaluate((node) => node.scrollTop), scrollTop)
    assert.equal(await search.inputValue(), "overlay-skill")
    pass("search and list scroll position survive settings and Escape")

    await open()
    await page.getByRole("button", { name: "个人信息", exact: true }).last().click()
    await page.getByRole("button", { name: "退出登录", exact: true }).click()
    await page.getByRole("button", { name: "立即登录", exact: true }).waitFor()
    await page.evaluate(() =>
      window.api.models.upsertUserInfo({
        sapId: "overlay-user",
        ystId: "fixture",
        userName: "Fixture",
        originOrgId: "",
        orgName: "",
        pathName: "",
        originPathId: "",
        ystRefreshToken: "",
        ystCode: "",
        ystAccessToken: ""
      })
    )
    await close()
    await page.getByRole("heading", { name: "overlay-skill", exact: true }).waitFor()
    assert.equal(await search.inputValue(), "", "relogin reloads identity-dependent market data")
    pass("logout and login through real IPC refresh identity-dependent market data")

    await page.getByRole("tab", { name: "MCPs", exact: true }).click()
    await page.getByRole("heading", { name: "overlay-mcp", exact: true }).waitFor()
    await page.getByRole("button", { name: "卸载", exact: true }).waitFor()
    await page.getByRole("button", { name: "全部项目", exact: true }).click()
    await page.getByRole("button", { name: "精品", exact: true }).click()
    await page.keyboard.press("Escape")
    await open()
    await page.getByRole("button", { name: "MCP 连接器", exact: true }).click()
    await page.getByRole("button", { name: "overlay-mcp", exact: true }).click()
    await page.getByRole("button", { name: "发布到市场", exact: true }).click()
    await page.locator("#chinese-name").fill("覆盖层测试连接器")
    await page.locator("#description").fill("Published from settings")
    await page.locator("#guidance").fill("Use this test connector")
    await page.locator("#version").fill("1.0.1")
    await page.getByRole("button", { name: "一键发布", exact: true }).click()
    await page.getByRole("button", { name: "全部项目", exact: true }).waitFor()
    await page.getByRole("heading", { name: "overlay-mcp", exact: true }).waitFor()
    await page.getByText("Published from settings", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "返回应用", exact: true }).count(), 0)
    pass("publishing from a nested settings dialog refreshes and opens the existing market")

    await open()
    await page.getByRole("button", { name: "MCP 连接器", exact: true }).click()
    await page.getByRole("button", { name: "overlay-mcp", exact: true }).click()
    page.once("dialog", (dialog) => {
      void dialog.accept()
    })
    await page.getByRole("button", { name: "删除", exact: true }).click()
    await page.getByRole("button", { name: "删除", exact: true }).waitFor({ state: "detached" })
    await close()
    await page.getByRole("button", { name: "安装", exact: true }).waitFor()
    pass("deleting an MCP in settings updates the retained market installation state")

    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await page.getByRole("heading", { name: "overlay-skill", exact: true }).click()
    await page.getByText("Original file content.", { exact: false }).waitFor()
    const signedInPreview = await page
      .getByText("Original file content.", { exact: false })
      .elementHandle()
    await open()
    await page.getByRole("button", { name: "个人信息", exact: true }).last().click()
    await page.getByRole("button", { name: "退出登录", exact: true }).click()
    await page.getByRole("button", { name: "立即登录", exact: true }).waitFor()
    await close()
    await page.getByRole("heading", { name: "overlay-skill", exact: true }).waitFor()
    assert.equal(await signedInPreview!.evaluate((node) => node.isConnected), false)
    pass("logout through settings clears retained identity-dependent detail and preview")

    await page.getByRole("button", { name: "自动化", exact: true }).click()
    await page.getByRole("heading", { name: "定时任务", exact: true }).waitFor()
    const scheduler = await page.locator("main").elementHandle()
    await open()
    await close()
    assert(await scheduler!.evaluate((element) => element.isConnected))
    assert.equal(await page.getByRole("button", { name: /右侧面板/ }).count(), 0)
    pass("automation stays mounted and has no irrelevant right-panel toggle")

    await page.getByRole("button", { name: "看板视图", exact: true }).click()
    await page.locator("main").getByRole("button", { name: /子代理$/ }).waitFor()
    const board = await page.locator("main").elementHandle()
    await open()
    await close()
    assert(await board!.evaluate((element) => element.isConnected))
    pass("kanban stays mounted after settings")

    await page.getByRole("button", { name: "运营面板", exact: true }).click()
    await page.getByRole("button", { name: "自定义", exact: true }).click()
    const dateInput = page.locator('main input[type="date"]').first()
    await dateInput.fill("2026-09-01")
    const dateNode = await dateInput.elementHandle()
    await open()
    await close()
    assert(await dateNode!.evaluate((node) => node.isConnected))
    assert.equal(await dateInput.inputValue(), "2026-09-01")
    pass("dashboard preserves its date controls and in-progress filter input")

    await page.getByRole("tab", { name: "项目模式", exact: true }).click()
    await page.getByText("暂无项目", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "自定义设置", exact: true }).count(), 0)
    pass("project mode keeps its existing entry visibility")
    await page.getByRole("tab", { name: "对话模式", exact: true }).click()

    await page.locator("[data-chat-thread-id]").waitFor()
    const previousThread = await page
      .locator("[data-chat-thread-id]")
      .getAttribute("data-chat-thread-id")
    await page.getByRole("button", { name: "新任务", exact: true }).click()
    await page.waitForFunction((previousThread) => {
      const current = document
        .querySelector("[data-chat-thread-id]")
        ?.getAttribute("data-chat-thread-id")
      return (
        current &&
        current !== previousThread &&
        document.querySelector("[data-workspace-surface]")?.getAttribute("aria-busy") === "false"
      )
    }, previousThread)
    const input = page.locator("textarea").first()
    await input.fill("Keep my unsent draft")
    const draft = await input.elementHandle()
    await open()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f")
    await close()
    assert(await draft!.evaluate((element) => element.isConnected))
    assert.equal(await input.inputValue(), "Keep my unsent draft")
    assert.equal(await page.getByPlaceholder("在当前会话中搜索").count(), 0)
    pass("current thread and unsent draft survive; settings shortcut does not open chat search")

    // Count real renderer -> preload -> main requests, with deterministic Git results.
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as GitFixtureMain).gitOverlay = { version: 0, reads: [] }
      for (const kind of ["Meta", "Diffs", "FileDiff"]) {
        ipcMain.removeHandler(`workspace:getGitPanel${kind}`)
        ipcMain.handle(`workspace:getGitPanel${kind}`, (_event, { threadId }) => {
          const fixture = (globalThis as GitFixtureMain).gitOverlay
          fixture.reads.push({ kind, threadId })
          const file = {
            path: "overlay-change.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
            diff: `--- a/overlay-change.txt\n+++ b/overlay-change.txt\n@@ -1 +1 @@\n-old\n+overlay-git-${fixture.version}\n`
          }
          return {
            success: true,
            isGitRepo: true,
            isWorktree: false,
            taskId: threadId,
            hasPendingDiff: true,
            hasPushableCommit: false,
            worktreeBranch: "overlay-test",
            files: [file],
            file,
            totals: { additions: 1, deletions: 1, fileCount: 1 }
          }
        })
      }
    })
    const gitThread = (await page
      .locator("[data-chat-thread-id]")
      .getAttribute("data-chat-thread-id"))!
    const gitReads = () => app!.evaluate(() => (globalThis as GitFixtureMain).gitOverlay.reads)
    const emitGitChanges = () =>
      app!.evaluate(
        ({ BrowserWindow }, { threadId, workspacePath }) => {
          const fixture = (globalThis as GitFixtureMain).gitOverlay
          fixture.version++
          for (const win of BrowserWindow.getAllWindows()) {
            for (const changeType of ["meta", "file", "file"]) {
              win.webContents.send("workspace:files-changed", {
                threadIds: [threadId],
                workspacePath,
                changeType
              })
            }
          }
        },
        { threadId: gitThread, workspacePath: isolated }
      )
    await page.getByRole("button", { name: "Git 面板", exact: true }).click()
    await page.getByText("overlay-change.txt", { exact: true }).first().click()
    await page.getByText("overlay-git-0", { exact: false }).last().waitFor()
    const gitPreview = await page
      .getByText("overlay-git-0", { exact: false })
      .last()
      .elementHandle()
    let beforeGit = await gitReads()
    await open()
    await close()
    await page.waitForTimeout(250) // Longer than Git's 120 ms file-event debounce.
    assert.deepEqual(await gitReads(), beforeGit)
    assert(await gitPreview!.evaluate((node) => node.isConnected))
    pass("Git preview survives settings without changes or extra reads")

    await open()
    await emitGitChanges()
    await page.waitForTimeout(250)
    assert.deepEqual(await gitReads(), beforeGit, "hidden Git must defer file-triggered reads")
    await close()
    await page.getByText("overlay-git-1", { exact: false }).last().waitFor()
    await page.waitForTimeout(250)
    assert.deepEqual(
      (await gitReads()).slice(beforeGit.length).map((read) => read.kind),
      ["Meta", "Diffs", "FileDiff"]
    )
    pass("hidden Git changes coalesce and retain metadata refresh before ordinary file changes")

    beforeGit = await gitReads()
    await open()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("cmb:git-branch-switched")))
    await page.waitForTimeout(250)
    assert.deepEqual(
      await gitReads(),
      beforeGit,
      "branch refresh must also wait for settings to close"
    )
    await close()
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>("#git-refresh-button")?.disabled
    )
    await page.waitForTimeout(250)
    assert.deepEqual(
      (await gitReads()).slice(beforeGit.length).map((read) => read.kind),
      ["Meta", "Diffs", "FileDiff"]
    )
    pass("branch refresh waits for settings and drains once")

    beforeGit = await gitReads()
    await emitGitChanges()
    // Open and close within the debounce window: consume its pending request only once.
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="自定义设置"]')!.click()
    )
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
    await close()
    await page.getByText("overlay-git-2", { exact: false }).last().waitFor()
    await page.waitForTimeout(250)
    assert.deepEqual(
      (await gitReads()).slice(beforeGit.length).map((read) => read.kind),
      ["Meta", "Diffs", "FileDiff"]
    )
    pass("quick settings roundtrip does not duplicate the pending Git debounce")

    await open()
    await emitGitChanges()
    await close()
    await page.getByRole("button", { name: "新任务", exact: true }).click()
    await page.waitForFunction((oldId) => {
      const id = document
        .querySelector("[data-chat-thread-id]")
        ?.getAttribute("data-chat-thread-id")
      return (
        id &&
        id !== oldId &&
        document.querySelector("[data-workspace-surface]")?.getAttribute("aria-busy") === "false"
      )
    }, gitThread)
    const afterSwitch = await gitReads()
    await emitGitChanges()
    await page.waitForTimeout(250)
    assert.deepEqual(
      await gitReads(),
      afterSwitch,
      "unmounted Git must stop reacting to the old task"
    )
    pass("switching tasks removes the old Git refresh listener")

    assert.deepEqual(errors, [])
    writeFileSync(
      join(artifacts, "result.json"),
      JSON.stringify({ checks, counts, errors }, null, 2)
    )
  } catch (error) {
    await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined)
    console.error("Renderer errors:", errors)
    throw error
  } finally {
    await app?.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
