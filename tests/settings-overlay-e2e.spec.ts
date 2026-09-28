/** Real Electron shell, React and preload. Remote market responses are deterministic fixtures. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
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
  gitOverlay: {
    version: number
    reads: Array<{ kind: string; threadId: string; filePath?: string }>
    holdKind?: string
    releaseRead?: () => void
    failFile?: boolean
    failPath?: string
  }
  approvalDecisions: Array<{ requestId: string; type: string }>
  skillDecisions: Array<{ requestId: string; approved: boolean; content?: string }>
  releaseGroupSelection?: () => void
  releaseForkCheckpoint?: () => void
  releaseBrowserRequest?: () => void
  browserLibraryReads?: number
  restoreSkillFallbackHandlers?: () => void
}

async function main(): Promise<void> {
  let app: ElectronApplication | undefined
  let page: Page | undefined
  const errors: string[] = []
  const counts = { lists: 0, downloads: 0 }
  let orgDownloads = 0
  let mcpPublished = false
  let pluginPublished = false
  let skillPublished = false
  const orgSkillName = "覆盖层组织技能"
  const orgSkillMarkdown = `---\nname: ${orgSkillName}\ndescription: organization skill fixture\n---\n# Preserved organization preview\n\nOrganization file content.`
  const orgZip = new AdmZip()
  orgZip.addFile("overlay-org-skill/SKILL.md", Buffer.from(orgSkillMarkdown))
  const zip = new AdmZip()
  zip.addFile(
    "overlay-skill/SKILL.md",
    Buffer.from(
      "---\nname: overlay-skill\ndescription: settings test\n---\n# Preserved skill preview\n\nOriginal file content."
    )
  )
  const pluginZip = new AdmZip()
  pluginZip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name: "overlay-plugin", version: "1.0.0" }))
  )
  pluginZip.addFile("skills/sample/SKILL.md", Buffer.from("# Overlay plugin skill"))
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
    const orgSkillDir = join(dataRoot, "skills", "overlay-org-skill")
    mkdirSync(orgSkillDir, { recursive: true })
    const orgSkillPath = join(orgSkillDir, "SKILL.md")
    writeFileSync(orgSkillPath, orgSkillMarkdown)
    const publishSkillDir = join(dataRoot, "skills", "overlay-publish-skill")
    mkdirSync(publishSkillDir, { recursive: true })
    writeFileSync(
      join(publishSkillDir, "SKILL.md"),
      "---\nname: overlay-publish-skill\ndescription: Publish redirect fixture\n---\n# Publish redirect fixture"
    )
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
    await app.evaluate((_electron, sandboxHome) => {
      process.env.HOME = sandboxHome
    }, isolated)
    await app.evaluate("globalThis.__name = (value) => value")
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
    await page.route("**/gw/mgr/open-api/skill/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.endsWith("/document/download")) {
        orgDownloads++
        await route.fulfill({
          body: orgZip.toBuffer(),
          contentType: "application/zip",
          headers: { "Content-Disposition": 'attachment; filename="overlay-org-skill.zip"' }
        })
      } else {
        await route.fulfill({
          json: {
            returnCode: "SUC0000",
            body: pathname.endsWith("/labels")
              ? []
              : {
                  list: [
                    {
                      id: 90001,
                      slug: "overlay-org-skill",
                      name: orgSkillName,
                      description: "Organization settings regression fixture",
                      labels: [],
                      versions: [{ id: 90002, skillId: 90001, name: "1.0.0" }]
                    }
                  ],
                  total: 1,
                  pageNum: 1,
                  pageSize: 10,
                  pages: 1
                }
          }
        })
      }
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
        const plugin = {
          ...items[0],
          name: "overlay-plugin",
          description: pluginPublished ? "Plugin published from settings" : "Before publish",
          filename: "overlay-plugin.zip"
        }
        const skillItems = skillPublished
          ? [
              ...items,
              {
                ...items[0],
                name: "overlay-publish-skill",
                description: "Skill published from settings",
                filename: "overlay-publish-skill.zip"
              }
            ]
          : items
        await route.fulfill({
          json: {
            items: route.request().url().includes("/list/mcp")
              ? [mcp]
              : route.request().url().includes("/list/plugin")
                ? [plugin]
                : skillItems
          }
        })
      } else if (route.request().method() === "POST" || route.request().method() === "PUT") {
        const resourceType = route.request().postData()?.match(/name="resource_type"\r?\n\r?\n([^\r\n]+)/)?.[1]
        if (resourceType === "mcp") mcpPublished = true
        if (resourceType === "plugin") pluginPublished = true
        if (resourceType === "skill") skillPublished = true
        await route.fulfill({
          json: { message: "Published fixture" }
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
    const pluginInstall = await page.evaluate(
      (bytes) =>
        window.api.plugins.install(
          new Uint8Array(bytes).buffer,
          "overlay-plugin.zip",
          "local"
        ),
      Array.from(pluginZip.toBuffer())
    )
    assert.equal(pluginInstall.success, true, pluginInstall.error)
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
    await close()
    assert.equal(await page.getByRole("button", { name: "精品", exact: true }).count(), 1)
    pass("ordinary settings return preserves the selected market filter")
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

    await page.getByRole("tab", { name: "Plugins", exact: true }).click()
    await page.getByRole("heading", { name: "overlay-plugin", exact: true }).waitFor()
    await page.getByRole("button", { name: "卸载", exact: true }).waitFor()
    await open()
    const pluginSettings = page.getByRole("dialog", { name: "设置", exact: true })
    await pluginSettings.getByRole("button", { name: "插件", exact: true }).click()
    await pluginSettings.getByText("overlay-plugin", { exact: true }).first().click()
    await pluginSettings.getByRole("button", { name: "发布到市场", exact: true }).click()
    await page.locator("#chinese-name").fill("覆盖层测试插件")
    await page.locator("#description").fill("Plugin published from settings")
    await page.locator("#guidance").fill("Use this test plugin")
    await page.locator("#version").fill("1.0.1")
    await page.getByRole("button", { name: "一键发布", exact: true }).click()
    await page.getByRole("heading", { name: "overlay-plugin", exact: true }).waitFor()
    await page.getByText("Plugin published from settings", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "返回应用", exact: true }).count(), 0)
    pass("publishing a plugin from settings opens its refreshed market result")

    await open()
    await pluginSettings.getByRole("button", { name: "插件", exact: true }).click()
    await pluginSettings.getByText("overlay-plugin", { exact: true }).first().click()
    await pluginSettings.getByRole("button", { name: "卸载", exact: true }).click()
    await page
      .getByRole("dialog", { name: "确认卸载", exact: true })
      .getByRole("button", { name: "卸载", exact: true })
      .click()
    await close()
    await page.getByRole("button", { name: "安装", exact: true }).waitFor()
    pass("deleting a plugin in settings updates the retained market installation state")

    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await page.getByRole("button", { name: "全部项目", exact: true }).click()
    await page.getByRole("button", { name: "精品", exact: true }).click()
    await page.keyboard.press("Escape")
    await open()
    const skillSettings = page.getByRole("dialog", { name: "设置", exact: true })
    await skillSettings.getByRole("button", { name: "技能", exact: true }).click()
    await skillSettings.getByRole("button", { name: "overlay-publish-skill", exact: true }).click()
    await skillSettings.getByRole("button", { name: "同步到市场", exact: true }).click()
    await page.locator("#chinese-name").fill("覆盖层测试技能")
    await page.locator("#description").fill("Skill published from settings")
    await page.locator("#guidance").fill("Use this test skill")
    await page.getByRole("button", { name: "一键发布", exact: true }).click()
    await page.getByRole("button", { name: "全部项目", exact: true }).waitFor()
    await page.getByRole("heading", { name: "overlay-publish-skill", exact: true }).waitFor()
    await page.getByText("Skill published from settings", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "返回应用", exact: true }).count(), 0)
    pass("publishing a skill from settings clears the featured filter and opens its market result")

    await page.getByRole("tab", { name: "组织级技能", exact: true }).click()
    await page.getByRole("heading", { name: orgSkillName, exact: true }).click()
    await page.getByText("Organization file content.", { exact: false }).waitFor()
    await page.getByRole("button", { name: "卸载", exact: true }).waitFor()
    const orgPreview = await page
      .getByText("Organization file content.", { exact: false })
      .elementHandle()
    const beforeOrgDownloads = orgDownloads
    await open()
    const settings = page.getByRole("dialog", { name: "设置", exact: true })
    await settings.getByRole("button", { name: "技能", exact: true }).click()
    await settings.getByRole("button", { name: orgSkillName, exact: true }).click()
    // Keep the real handlers: a burst must share the existing catalog path,
    // not start a legacy full-directory scan for every notification.
    const skillRefreshReads = await app.evaluate(async ({ ipcMain, BrowserWindow }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const handlers = (ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Handler>
      })._invokeHandlers
      const list = handlers.get("skills:list")!
      const catalog = handlers.get("skills:catalog:read")!
      let legacyReads = 0
      const sharedReads: string[] = []
      handlers.set("skills:list", async (event, ...args) => {
        legacyReads++
        return list(event, ...args)
      })
      handlers.set("skills:catalog:read", async (event, ...args) => {
        const { input, scope } = args[0] as {
          input: { kind: string; revision?: string; cursor?: string }
          scope: string
        }
        if (scope.startsWith("app-skill-catalog:")) {
          sharedReads.push(JSON.stringify([input.revision, input.kind, input.cursor]))
        }
        return catalog(event, ...args)
      })
      try {
        for (let i = 0; i < 12; i++) {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send("hooks:changed", { reason: "skills-disabled-changed" })
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
        return { legacyReads, sharedReads }
      } finally {
        handlers.set("skills:list", list)
        handlers.set("skills:catalog:read", catalog)
      }
    })
    assert.equal(skillRefreshReads.legacyReads, 0, "skill events must not trigger legacy full scans")
    assert(skillRefreshReads.sharedReads.length > 0, "skill events must still refresh the catalog")
    assert.equal(
      new Set(skillRefreshReads.sharedReads).size,
      skillRefreshReads.sharedReads.length,
      "market and settings must share catalog requests at the same revision"
    )
    pass("skill change bursts share catalog reads without legacy scans under settings")
    page.once("dialog", (dialog) => {
      void dialog.accept()
    })
    await settings.getByRole("button", { name: "删除", exact: true }).click()
    await settings.getByRole("button", { name: "删除", exact: true }).waitFor({ state: "detached" })
    assert.equal(existsSync(orgSkillPath), false, "settings must actually remove the local skill")
    await close()
    await page.getByRole("button", { name: "安装", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "卸载", exact: true }).count(), 0)
    assert(await orgPreview!.evaluate((element) => element.isConnected))
    assert.equal(orgDownloads, beforeOrgDownloads, "installation flags must not reload the preview")
    await page.getByRole("button", { name: "安装", exact: true }).click()
    await page.getByRole("button", { name: "卸载", exact: true }).waitFor()
    const reinstalledSkill = await page.evaluate(
      async (name) => (await window.api.skills.list()).find((skill) => skill.name === name),
      orgSkillName
    )
    assert(reinstalledSkill, "detail must support reinstalling the local skill")
    assert(existsSync(reinstalledSkill.path), "reinstalled skill must exist on disk")
    assert(await orgPreview!.evaluate((element) => element.isConnected))
    pass(
      "organization detail updates after settings deletion and supports reinstall without leaving detail"
    )

    // Exercise the market's fallback itself, through real preload/React subscriptions.
    for (const mode of ["truncated", "failed", "cancelled"] as const) {
      const reads = await app.evaluate(async ({ ipcMain, BrowserWindow }, mode) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
        const handlers = (ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, Handler>
        })._invokeHandlers
        const list = handlers.get("skills:list")!
        const catalog = handlers.get("skills:catalog:read")!
        const restoreHandlers = (): void => {
          handlers.set("skills:list", list)
          handlers.set("skills:catalog:read", catalog)
        }
        let scans = 0
        let active = 0
        let peak = 0
        let releaseFirst: (() => void) | undefined
        const revisions = new Set<string>()
        let catalogStarted = 0
        let catalogSettled = 0
        const emitChange = (): void => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send("hooks:changed", { reason: "skills-disabled-changed" })
          }
        }
        const waitFor = async (ready: () => boolean): Promise<void> => {
          const deadline = Date.now() + 10_000
          while (!ready()) {
            if (Date.now() > deadline) throw new Error(`Timed out in ${mode} fallback fixture`)
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
        handlers.set("skills:catalog:read", async (event, ...args) => {
          const { input, scope } = args[0] as { input: { revision: string }; scope: string }
          if (!scope.startsWith("app-skill-catalog:")) return catalog(event, ...args)
          revisions.add(input.revision)
          catalogStarted++
          try {
            if (mode !== "truncated") {
              throw new Error(mode === "cancelled"
                ? "Skill/plugin catalog request was superseded"
                : "Fixture catalog unavailable")
            }
            const result = await catalog(event, ...args) as Record<string, unknown>
            return { ...result, truncated: true, truncatedReasons: ["fixture-snapshot-limit"] }
          } finally {
            catalogSettled++
          }
        })
        handlers.set("skills:list", async (event, ...args) => {
          const scan = ++scans
          active++
          peak = Math.max(peak, active)
          try {
            if (scan === 1) {
              const oldList = await list(event, ...args)
              await new Promise<void>((resolve) => { releaseFirst = resolve })
              return oldList
            }
            // The newest read sees deletion; the blocked first read still sees installation.
            return []
          } finally {
            active--
          }
        })
        let keepHandlersForAssertion = false
        try {
          emitChange()
          if (mode === "cancelled") {
            await waitFor(() => revisions.size > 0)
            await new Promise((resolve) => setTimeout(resolve, 300))
          } else {
            await waitFor(() => Boolean(releaseFirst))
            for (let i = 0; i < 12; i++) emitChange()
            await waitFor(() => revisions.size >= 13 && catalogSettled === catalogStarted)
            releaseFirst!()
            await waitFor(() => scans >= 2 && active === 0)
          }
          keepHandlersForAssertion = mode !== "cancelled"
          return { scans, peak }
        } finally {
          releaseFirst?.()
          if (keepHandlersForAssertion) {
            ;(globalThis as GitFixtureMain).restoreSkillFallbackHandlers = restoreHandlers
          } else {
            restoreHandlers()
          }
        }
      }, mode)
      try {
        if (mode === "cancelled") {
          assert.equal(reads.scans, 0, "cancelled catalog requests must not start a full scan")
        } else {
          assert.equal(reads.peak, 1, "fallback scans must never overlap")
          assert.equal(reads.scans, 2, "a burst during a fallback needs only one final read")
          await page.getByRole("button", { name: "安装", exact: true }).waitFor()
          await page.getByRole("button", { name: "卸载", exact: true }).waitFor({ state: "detached" })
        }
      } finally {
        await app.evaluate(() => {
          const fixture = globalThis as GitFixtureMain
          fixture.restoreSkillFallbackHandlers?.()
          fixture.restoreSkillFallbackHandlers = undefined
        })
      }
      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("hooks:changed", { reason: "skills-disabled-changed" })
        }
      })
      await page.getByRole("button", { name: "卸载", exact: true }).waitFor()
      pass(`${mode} skill catalog: bounded fallback and current installation state`)
    }
    await page.getByRole("button", { name: /返回列表/ }).click()

    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await search.fill("")
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

    const currentThread = page.locator("[data-chat-thread-id]")
    const previousThread = await currentThread.count()
      ? await currentThread.getAttribute("data-chat-thread-id")
      : null
    await page.getByRole("button", { name: "新任务", exact: true }).click()
    await page.waitForFunction((previousThread) => {
      const current = document
        .querySelector("[data-chat-thread-id]")
        ?.getAttribute("data-chat-thread-id")
      return (
        current &&
        (previousThread === null || current !== previousThread) &&
        document.querySelector("[data-workspace-surface]")?.getAttribute("aria-busy") === "false"
      )
    }, previousThread)
    const input = page.locator("textarea").first()
    await input.fill("Keep my unsent draft")
    const draft = await input.elementHandle()
    await input.evaluate((element) => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File(["Attachment retained while settings is open"], "overlay-attachment.txt", {
          type: "text/plain"
        })
      )
      element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    const attachment = page.getByRole("button", { name: "移除附件 overlay-attachment.txt" })
    await attachment.waitFor({ state: "attached" })
    const attachmentNode = await attachment.elementHandle()
    await open()
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f")
    await close()
    assert(await draft!.evaluate((element) => element.isConnected))
    assert.equal(await input.inputValue(), "Keep my unsent draft")
    assert.equal(await page.getByPlaceholder("在当前会话中搜索").count(), 0)
    pass("current thread and unsent draft survive; settings shortcut does not open chat search")
    assert(await attachmentNode!.evaluate((element) => element.isConnected))
    assert.equal(await attachment.count(), 1)
    await attachment.click()
    pass("unsent file attachment survives settings and can still be removed")

    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as GitFixtureMain).skillDecisions = []
      ipcMain.removeHandler("skill:confirmResponse")
      ipcMain.handle("skill:confirmResponse", (_event, decision) => {
        ;(globalThis as GitFixtureMain).skillDecisions.push(decision)
      })
    })
    const skillThread = await page.locator("[data-chat-thread-id]").getAttribute("data-chat-thread-id")
    const emitSkillConfirmation = (requestId: string) => app!.evaluate(
      ({ BrowserWindow }, { requestId, threadId }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("skill:confirmRequest", {
            requestId,
            threadId,
            skillId: "overlay-confirm-skill",
            name: "Overlay confirmation",
            description: "Pending skill must survive settings",
            content: "# Original skill draft"
          })
        }
      },
      { requestId, threadId: skillThread }
    )
    await open()
    await emitSkillConfirmation("overlay-skill-approve")
    await page.waitForTimeout(250)
    const skillDialog = page.getByRole("dialog", { name: "保存为技能？", exact: true })
    assert.equal(await skillDialog.count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
    await skillDialog.waitFor()
    assert.deepEqual(await app.evaluate(() => (globalThis as GitFixtureMain).skillDecisions), [])
    pass("skill confirmation waits behind settings; Escape closes settings without rejecting it")

    await skillDialog.getByRole("button", { name: "查看/编辑完整 SKILL.md 草稿" }).click()
    await skillDialog.locator("textarea").fill("# Edited skill draft")
    // A global notification can open settings while a workspace dialog is open.
    // Invoke the same settings action without depending on a remote notification.
    await page.locator('button[aria-label="自定义设置"]').evaluate((node: HTMLButtonElement) => node.click())
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
    await skillDialog.waitFor({ state: "detached" })
    assert.deepEqual(await app.evaluate(() => (globalThis as GitFixtureMain).skillDecisions), [])
    await close()
    await skillDialog.waitFor()
    assert.equal(await skillDialog.locator("textarea").inputValue(), "# Edited skill draft")
    await skillDialog.getByRole("button", { name: "保存技能", exact: true }).click()
    await skillDialog.waitFor({ state: "detached" })
    assert.deepEqual(await app.evaluate(() => (globalThis as GitFixtureMain).skillDecisions), [{
      requestId: "overlay-skill-approve", approved: true, content: "# Edited skill draft"
    }])
    pass("skill draft survives settings and saving sends the edited content exactly once")

    await emitSkillConfirmation("overlay-skill-reject")
    await skillDialog.waitFor()
    await page.keyboard.press("Escape")
    await skillDialog.waitFor({ state: "detached" })
    assert.deepEqual(
      (await app.evaluate(() => (globalThis as GitFixtureMain).skillDecisions)).at(-1),
      { requestId: "overlay-skill-reject", approved: false, content: undefined }
    )
    pass("Escape still rejects skill confirmation when the workspace dialog is visible")

    // Count real renderer -> preload -> main requests, with deterministic Git results.
    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as GitFixtureMain).gitOverlay = { version: 0, reads: [] }
      for (const kind of ["Meta", "Diffs", "FileDiff"]) {
        ipcMain.removeHandler(`workspace:getGitPanel${kind}`)
        ipcMain.handle(`workspace:getGitPanel${kind}`, async (_event, { threadId, filePath }) => {
          const fixture = (globalThis as GitFixtureMain).gitOverlay
          fixture.reads.push({ kind, threadId, filePath })
          if (fixture.holdKind === kind) {
            fixture.holdKind = undefined
            await new Promise<void>((resolve) => { fixture.releaseRead = resolve })
            fixture.releaseRead = undefined
          }
          if (kind === "FileDiff" && (fixture.failFile || fixture.failPath === filePath)) {
            await new Promise((resolve) => setTimeout(resolve, 30))
            return { success: false, taskId: threadId, error: "Fixture diff unavailable" }
          }
          const file = {
            path: "overlay-change.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
            diff: `--- a/overlay-change.txt\n+++ b/overlay-change.txt\n@@ -1 +1 @@\n-old\n+overlay-git-${fixture.version}\n`
          }
          const secondFile = {
            ...file,
            path: "overlay-second.txt",
            diff: "--- a/overlay-second.txt\n+++ b/overlay-second.txt\n@@ -1 +1 @@\n-old\n+second-file-preview\n"
          }
          return {
            success: true,
            isGitRepo: true,
            isWorktree: false,
            taskId: threadId,
            hasPendingDiff: true,
            hasPushableCommit: false,
            worktreeBranch: "overlay-test",
            files: [file, secondFile],
            file: filePath === secondFile.path ? secondFile : file,
            totals: { additions: 2, deletions: 2, fileCount: 2 }
          }
        })
      }
    })
    const gitThread = (await page
      .locator("[data-chat-thread-id]")
      .getAttribute("data-chat-thread-id"))!
    const gitReads = () => app!.evaluate(() => (globalThis as GitFixtureMain).gitOverlay.reads)
    const waitForHeldGitRead = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await app!.evaluate(() => Boolean((globalThis as GitFixtureMain).gitOverlay.releaseRead))) return
        await page!.waitForTimeout(50)
      }
      assert.fail("Git fixture did not receive the expected held request")
    }
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

    // A list request already in flight may finish behind settings. It must not start a file read.
    await app.evaluate(() => { (globalThis as GitFixtureMain).gitOverlay.holdKind = "Diffs" })
    await page.locator("#git-refresh-button").click()
    await waitForHeldGitRead()
    await open()
    beforeGit = await gitReads()
    await app.evaluate(() => { (globalThis as GitFixtureMain).gitOverlay.releaseRead?.() })
    await page.waitForTimeout(250)
    assert.deepEqual(await gitReads(), beforeGit, "hidden list completion must defer single-file reads")
    await close()
    await page.getByText("overlay-git-2", { exact: false }).last().waitFor()
    assert.deepEqual((await gitReads()).slice(beforeGit.length).map((read) => read.kind), ["FileDiff"])
    pass("an in-flight list refresh defers its file preview until settings closes")

    // Complete an already-issued file read with an error while settings is open.
    await app.evaluate(() => {
      const fixture = (globalThis as GitFixtureMain).gitOverlay
      fixture.holdKind = "FileDiff"
      fixture.failFile = true
    })
    await page.locator("#git-refresh-button").click()
    await waitForHeldGitRead()
    await open()
    beforeGit = await gitReads()
    await app.evaluate(() => { (globalThis as GitFixtureMain).gitOverlay.releaseRead?.() })
    await page.waitForTimeout(500)
    assert.deepEqual(await gitReads(), beforeGit, "a failed file read must not loop behind settings")
    await close()
    await page.getByText("Fixture diff unavailable", { exact: true }).waitFor()
    await page.waitForTimeout(250)
    assert.deepEqual(await gitReads(), beforeGit, "showing a file error must not restart the loop")
    await app.evaluate(() => { (globalThis as GitFixtureMain).gitOverlay.failFile = false })
    await page.locator("#git-refresh-button").click()
    await page.getByText("overlay-git-2", { exact: false }).last().waitFor()
    assert.equal((await gitReads()).slice(beforeGit.length).filter((read) => read.kind === "FileDiff").length, 1)
    pass("failed file reads stop retrying and recover after explicit refresh")

    for (const failSecondFile of [false, true]) {
      // A is cached. Hold B, switch back to A, then finish the obsolete B request.
      beforeGit = await gitReads()
      await app.evaluate((_electron, fail) => {
        const fixture = (globalThis as GitFixtureMain).gitOverlay
        fixture.holdKind = "FileDiff"
        fixture.failPath = fail ? "overlay-second.txt" : undefined
      }, failSecondFile)
      await page.getByText("overlay-second.txt", { exact: true }).first().click()
      await waitForHeldGitRead()
      await page.getByText("overlay-change.txt", { exact: true }).first().click()
      await page.getByText("overlay-git-2", { exact: false }).last().waitFor()
      const currentPreview = await page.getByText("overlay-git-2", { exact: false }).last().elementHandle()
      await app.evaluate(() => { (globalThis as GitFixtureMain).gitOverlay.releaseRead?.() })
      await page.waitForTimeout(250)
      assert(await currentPreview!.evaluate((node) => node.isConnected), "late B result must not replace A")
      assert.equal(await page.getByText("Fixture diff unavailable", { exact: true }).count(), 0)
      assert.equal(await page.getByText("正在加载该文件 diff...", { exact: true }).count(), 0)
      assert.equal(await page.getByText("second-file-preview", { exact: false }).count(), 0)
      assert.deepEqual(
        (await gitReads()).slice(beforeGit.length).filter((read) => read.kind === "FileDiff").map((read) => read.filePath),
        ["overlay-second.txt", "overlay-change.txt"]
      )
      pass(`switching A → pending B → A preserves A after B ${failSecondFile ? "fails" : "succeeds"}`)
    }
    await app.evaluate(() => { (globalThis as GitFixtureMain).gitOverlay.failPath = undefined })

    await app.evaluate(({ ipcMain }) => {
      ;(globalThis as GitFixtureMain).approvalDecisions = []
      ipcMain.on("sandbox:approvalDecision", (_event, decision) => {
        ;(globalThis as GitFixtureMain).approvalDecisions.push(decision)
      })
    })
    await open()
    await app.evaluate(({ BrowserWindow }, threadId) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(`approval:request:${threadId}`, {
          id: "overlay-commit-approval",
          operation: "git_commit",
          tool_call: { id: "overlay-commit-tool", name: "execute", args: {} },
          suggestedCommitMessage: "test: overlay approval",
          _orchestratorRequestId: "overlay-commit-approval"
        })
      }
    }, gitThread)
    await page.waitForTimeout(250)
    assert.equal(await page.getByText("Agent 请求提交", { exact: true }).count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
    await page.getByText("Agent 请求提交", { exact: true }).waitFor()
    assert.deepEqual(await app.evaluate(() => (globalThis as GitFixtureMain).approvalDecisions), [])
    // Only dismissing the now-visible approval is a rejection.
    await page.keyboard.press("Escape")
    await page.getByText("Agent 请求提交", { exact: true }).waitFor({ state: "detached" })
    const decisions = await app.evaluate(() => (globalThis as GitFixtureMain).approvalDecisions)
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0].requestId, "overlay-commit-approval")
    assert.equal(decisions[0].type, "reject")
    pass("commit approval waits behind settings and Escape does not reject it until displayed")

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

    // Delay the real group lookup so settings opens before its confirmation.
    await app.evaluate(({ ipcMain }, workspacePath) => {
      ipcMain.removeHandler("workspace:select")
      ipcMain.handle("workspace:select", () => workspacePath)
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const handlers = (ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Handler>
      })._invokeHandlers
      const original = handlers.get("threads:list-group-ids")!
      handlers.set("threads:list-group-ids", async (event, ...args) => {
        const selection = await original(event, ...args)
        await new Promise<void>((resolve) => {
          ;(globalThis as GitFixtureMain).releaseGroupSelection = resolve
        })
        handlers.set("threads:list-group-ids", original)
        return selection
      })
    }, isolated)
    await page.locator("button:has(svg.lucide-folder-plus)").click()
    const workspaceGroup = page.getByText(basename(isolated), { exact: true }).first()
    await workspaceGroup.waitFor()
    await workspaceGroup.click({ button: "right" })
    await page.getByRole("menuitem", { name: "删除工作区会话", exact: true }).click()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseGroupSelection))) break
      await page.waitForTimeout(50)
    }
    assert(await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseGroupSelection)))
    await open()
    await app.evaluate(() => (globalThis as GitFixtureMain).releaseGroupSelection?.())
    await page.waitForTimeout(250)
    const groupDialog = page.getByRole("dialog", { name: "确认删除工作区会话", exact: true })
    assert.equal(await groupDialog.count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await groupDialog.waitFor()
    await groupDialog.getByRole("button", { name: "取消", exact: true }).click()
    await groupDialog.waitFor({ state: "detached" })
    await workspaceGroup.waitFor()
    pass("delayed workspace deletion confirmation waits for settings and remains cancellable")

    await page.evaluate(async (workspacePath) => {
      const thread = await window.api.threads.create({ title: "Overlay fork fixture", workspacePath })
      await window.api.threads.appendMessages(thread.thread_id, [{
        id: "overlay-fork-message", role: "assistant", content: "Overlay fork message"
      }])
    }, isolated)
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      ipcMain.removeHandler("threads:resolve-fork-checkpoint-for-message")
      ipcMain.handle("threads:resolve-fork-checkpoint-for-message", async () => {
        await new Promise<void>((resolve) => {
          ;(globalThis as GitFixtureMain).releaseForkCheckpoint = resolve
        })
        return {
          checkpointId: "overlay-checkpoint", checkpointNs: "",
          resolvedMessageId: "overlay-fork-message", messageForkMode: "message",
          createdAt: "2026-09-24T10:00:00Z", messageCount: 1,
          lastMessagePreview: "Overlay fork message", isStableTurnBoundary: true,
          hasInterrupt: false, hasPendingWrites: false
        }
      })
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send("threads:changed")
    })
    await page.getByText("Overlay fork fixture", { exact: true }).click()
    await page.getByText("Overlay fork message", { exact: true }).waitFor()
    await page.getByRole("button", { name: "从这里 fork", exact: true }).click()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseForkCheckpoint))) break
      await page.waitForTimeout(50)
    }
    assert(await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseForkCheckpoint)))
    await open()
    await app.evaluate(() => (globalThis as GitFixtureMain).releaseForkCheckpoint?.())
    await page.waitForTimeout(250)
    const forkDialog = page.getByRole("dialog", { name: "Fork 这条消息", exact: true })
    assert.equal(await forkDialog.count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await forkDialog.waitFor()
    await forkDialog.getByText("Overlay fork message", { exact: true }).waitFor()
    await forkDialog.getByRole("button", { name: "取消", exact: true }).click()
    await forkDialog.waitFor({ state: "detached" })
    pass("delayed message fork confirmation waits for settings and preserves the selected message")

    await app.evaluate(({ ipcMain }) => {
      const state = {
        sessionId: "app-browser", url: "about:blank", title: "Overlay browser",
        isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1,
        visible: false, created: true, consoleEntries: []
      }
      // Exercise the real browser controls without opening an external page.
      for (const channel of ["browser:attach", "browser:setBounds", "browser:getState"]) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, () => state)
      }
      ipcMain.removeHandler("browser:isProfileImportRuntimeEnabled")
      ipcMain.handle("browser:isProfileImportRuntimeEnabled", () => false)
      const config = { enabled: false, profileImportEnabled: false }
      ipcMain.removeHandler("browser:getCdpConfig")
      ipcMain.handle("browser:getCdpConfig", () => config)
      ipcMain.removeHandler("browser:saveCdpConfig")
      ipcMain.handle("browser:saveCdpConfig", async () => {
        await new Promise<void>((resolve) => {
          ;(globalThis as GitFixtureMain).releaseBrowserRequest = resolve
        })
        return config
      })
      const session = {
        id: "overlay-recording", source: "script", status: "idle", actions: [],
        script: "// Preserved browser recording"
      }
      ipcMain.removeHandler("browser:getScriptRecording")
      ipcMain.handle("browser:getScriptRecording", () => session)
      ipcMain.removeHandler("browser:startScriptRecording")
      ipcMain.handle("browser:startScriptRecording", () => {
        session.status = "recording"
        return session
      })
      for (const [channel, status] of [
        ["browser:pauseScriptRecording", "paused"],
        ["browser:stopScriptRecording", "completed"]
      ]) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async () => {
          await new Promise<void>((resolve) => {
            ;(globalThis as GitFixtureMain).releaseBrowserRequest = resolve
          })
          session.status = status
          return session
        })
      }
    })
    const showRightPanel = page.getByRole("button", { name: "显示右侧面板", exact: true })
    if (await showRightPanel.count()) await showRightPanel.click()
    await page.getByRole("button", { name: "内置浏览器", exact: true }).click()
    const completeBrowserRequestBehindSettings = async (): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await app!.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseBrowserRequest))) break
        await page!.waitForTimeout(50)
      }
      assert(await app!.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseBrowserRequest)))
      await open()
      await app!.evaluate(() => {
        ;(globalThis as GitFixtureMain).releaseBrowserRequest?.()
        ;(globalThis as GitFixtureMain).releaseBrowserRequest = undefined
      })
      await page!.waitForTimeout(250)
    }
    await page.getByRole("button", { name: "保存配置", exact: true }).click()
    await completeBrowserRequestBehindSettings()
    const restartDialog = page.getByRole("dialog", { name: "内置浏览器配置已保存", exact: true })
    assert.equal(await restartDialog.count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
    await restartDialog.waitFor()
    await restartDialog.getByRole("button", { name: "取消", exact: true }).click()
    await restartDialog.waitFor({ state: "detached" })
    pass("browser configuration restart confirmation waits for settings after delayed save")

    await page.locator('button[aria-label="录制脚本"]').click()
    await page.getByRole("status").getByRole("button", { name: "录制脚本", exact: true }).click()
    const recordingDialog = page.getByRole("dialog", { name: "录制脚本结果", exact: true })
    for (const action of ["暂停", "终止"]) {
      await page.getByRole("button", { name: action, exact: true }).click()
      await completeBrowserRequestBehindSettings()
      assert.equal(await recordingDialog.count(), 0)
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
      await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
      await recordingDialog.waitFor()
      assert.equal(
        await recordingDialog.getByRole("textbox", { name: "Playwright 脚本草稿编辑器" }).inputValue(),
        "// Preserved browser recording"
      )
      if (action === "暂停") {
        await page.keyboard.press("Escape")
        await recordingDialog.waitFor({ state: "detached" })
      }
      pass(`browser recording ${action} result waits for settings without consuming Escape`)
    }
    await recordingDialog.getByRole("textbox", { name: "Playwright 脚本草稿编辑器" }).fill("// Edited recording")
    await recordingDialog.getByPlaceholder("文件中文名（必填）").fill("保留名称")
    await page.locator('button[aria-label="自定义设置"]').evaluate((node: HTMLButtonElement) => node.click())
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
    await recordingDialog.waitFor({ state: "detached" })
    await close()
    await recordingDialog.waitFor()
    assert.equal(await recordingDialog.getByRole("textbox", { name: "Playwright 脚本草稿编辑器" }).inputValue(), "// Edited recording")
    assert.equal(await recordingDialog.getByPlaceholder("文件中文名（必填）").inputValue(), "保留名称")
    await page.keyboard.press("Escape")
    await recordingDialog.waitFor({ state: "detached" })
    pass("browser recording edits and save name survive settings without dismissing the result")

    // Save through the real IPC, holding its response while the user leaves the result dialog.
    await app.evaluate(({ ipcMain }) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const handlers = (ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Handler>
      })._invokeHandlers
      const save = handlers.get("browser:saveScriptLibraryEntry")!
      handlers.set("browser:saveScriptLibraryEntry", async (event, ...args) => {
        const result = await save(event, ...args)
        await new Promise<void>((resolve) => {
          ;(globalThis as GitFixtureMain).releaseBrowserRequest = resolve
        })
        handlers.set("browser:saveScriptLibraryEntry", save)
        return result
      })
      const read = handlers.get("browser:readScriptLibraryScript")!
      ;(globalThis as GitFixtureMain).browserLibraryReads = 0
      handlers.set("browser:readScriptLibraryScript", (event, ...args) => {
        ;(globalThis as GitFixtureMain).browserLibraryReads!++
        return read(event, ...args)
      })
    })
    await page.getByRole("button", { name: "查看录制", exact: true }).click()
    await recordingDialog.getByPlaceholder("文件中文名（必填）").fill("延迟保存录制")
    await recordingDialog.getByRole("button", { name: "保存", exact: true }).click()
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseBrowserRequest))) break
      await page.waitForTimeout(50)
    }
    assert(await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseBrowserRequest)))
    await page.keyboard.press("Escape")
    await recordingDialog.waitFor({ state: "detached" })
    await completeBrowserRequestBehindSettings()
    const libraryDialog = page.getByRole("dialog", { name: "录制列表", exact: true })
    assert.equal(await libraryDialog.count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
    await libraryDialog.waitFor()
    const libraryEditor = libraryDialog.getByRole("textbox", { name: "录制脚本编辑器", exact: true })
    await libraryEditor.waitFor()
    await page.waitForFunction(() =>
      (document.querySelector('textarea[aria-label="录制脚本编辑器"]') as HTMLTextAreaElement | null)?.value === "// Edited recording"
    )
    assert.equal(await libraryEditor.inputValue(), "// Edited recording")
    assert.equal(await libraryDialog.getByLabel("文件中文名", { exact: true }).inputValue(), "延迟保存录制")
    pass("saving a recording then closing its result defers the library until settings closes")

    await libraryEditor.fill("// Unsaved library edit")
    await libraryDialog.getByLabel("文件中文名", { exact: true }).fill("未保存的名称")
    const readsBeforeLibrarySettings = await app.evaluate(() => (globalThis as GitFixtureMain).browserLibraryReads)
    await page.locator('button[aria-label="自定义设置"]').evaluate((node: HTMLButtonElement) => node.click())
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
    await libraryDialog.waitFor({ state: "detached" })
    await close()
    await libraryDialog.waitFor()
    assert.equal(await libraryEditor.inputValue(), "// Unsaved library edit")
    assert.equal(await libraryDialog.getByLabel("文件中文名", { exact: true }).inputValue(), "未保存的名称")
    assert.equal(await app.evaluate(() => (globalThis as GitFixtureMain).browserLibraryReads), readsBeforeLibrarySettings)
    await page.keyboard.press("Escape")
    await libraryDialog.waitFor({ state: "detached" })
    pass("recording library edits survive settings without re-reading the saved script")

    const variableFileName = await page.evaluate(async () => {
      const entries = await window.api.browser.listScriptLibraryEntries()
      const entry = entries.find((item) => item.displayName === "延迟保存录制")
      if (!entry) throw new Error("Saved recording fixture is missing")
      const variableEntry = await window.api.browser.saveScriptLibraryEntry({
        displayName: "延迟变量执行",
        recordingSource: "script",
        script: 'const 变量_目标地址 = ""; // 变量-目标地址\nawait page.goto(变量_目标地址);',
        isEdited: true,
        threadId: entry.threadId,
        workspacePath: entry.workspacePath
      })
      return variableEntry.fileName
    })
    await page.getByRole("button", { name: "列表", exact: true }).click()
    await libraryDialog.getByRole("row").filter({ hasText: "延迟保存录制" }).first().click()
    await app.evaluate(({ ipcMain }, targetFileName) => {
      type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const handlers = (ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, Handler>
      })._invokeHandlers
      const read = handlers.get("browser:readScriptLibraryScript")!
      handlers.set("browser:readScriptLibraryScript", async (event, ...args) => {
        const result = await read(event, ...args)
        if ((args[0] as { fileName?: string })?.fileName === targetFileName) {
          await new Promise<void>((resolve) => {
            ;(globalThis as GitFixtureMain).releaseBrowserRequest = resolve
          })
          handlers.set("browser:readScriptLibraryScript", read)
        }
        return result
      })
    }, variableFileName)
    const variableRow = libraryDialog.getByRole("row").filter({ hasText: "延迟变量执行" })
    await variableRow.locator("button").first().click()
    await libraryDialog.waitFor({ state: "detached" })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseBrowserRequest))) break
      await page.waitForTimeout(50)
    }
    assert(await app.evaluate(() => Boolean((globalThis as GitFixtureMain).releaseBrowserRequest)))
    await open()
    await app.evaluate(() => {
      ;(globalThis as GitFixtureMain).releaseBrowserRequest?.()
      ;(globalThis as GitFixtureMain).releaseBrowserRequest = undefined
    })
    const variableDialog = page.getByRole("dialog", { name: "填写脚本变量", exact: true })
    await page.waitForTimeout(250)
    assert.equal(await variableDialog.count(), 0)
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), "none")
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "返回应用", exact: true }).waitFor({ state: "detached" })
    await variableDialog.waitFor()
    await variableDialog.getByRole("textbox").fill("https://example.com")
    assert.equal(await variableDialog.getByRole("textbox").inputValue(), "https://example.com")
    await variableDialog.getByRole("button", { name: "取消", exact: true }).click()
    pass("delayed script variable prompt waits for settings and keeps execution inputs")

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
