/** Built Electron, real preload and IPC, local HTTP fixtures. Run with tsx. */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { _electron, type ElectronApplication, type Page } from "playwright"

const root = resolve(import.meta.dirname, "..")
const requireLocal = createRequire(join(root, "package.json"))
const binary = requireLocal("electron") as string
const name = "e2e-project-plugin-author"
const label = "E2E plugin development skill"
const originTitle = "Original shortcut draft"
const entry = "开发项目模式插件"
const markdown =
  "---\nname: " + name + "\ndescription: Development fixture\n---\n\nFixture instructions.\n"
const user = { sapId: "shortcut-e2e", ystId: "e2e-shortcut", userName: "E2E User" }
const basePath = "/api/trajectories/marketplace"

async function build(output: string, baseUrl: string): Promise<void> {
  await new Promise<void>((resolveBuild, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(root, "node_modules/electron-vite/bin/electron-vite.js"),
        "build",
        "--outDir",
        output,
        "--logLevel",
        "error"
      ],
      {
        cwd: root,
        env: { ...process.env, VITE_API_BASE_URL: baseUrl, VITE_UPDATE_SERVER_URL: baseUrl },
        stdio: ["ignore", "ignore", "inherit"]
      }
    )
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) resolveBuild()
      else reject(new Error("Electron build exited with code " + code))
    })
  })
}

async function main(): Promise<void> {
  mkdirSync(join(root, "output"), { recursive: true })
  const isolated = mkdtempSync(join(root, "output", "market-shortcut-e2e-"))
  assert.equal(dirname(resolve(isolated)), resolve(root, "output"))
  const output = join(isolated, "bundle")
  const data = join(isolated, "data")
  const workspace = join(isolated, "workspace")
  mkdirSync(data)
  mkdirSync(workspace)
  writeFileSync(join(data, "userinfo-models.json"), JSON.stringify(user))
  let published = false
  let catalogReads = 0
  let downloads = 0

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("access-control-allow-origin", "*")
    response.setHeader("access-control-allow-headers", "*")
    response.setHeader("content-type", "application/json")
    if (request.method === "OPTIONS") {
      response.writeHead(204).end()
    } else if (url.pathname === "/download") {
      response.end(
        JSON.stringify({
          version: "0.0.1",
          conversationShortcuts: published
            ? {
                projectPluginCreation: {
                  marketName: name,
                  allowSourceForAll: true,
                  sha256: createHash("sha256").update(markdown).digest("hex")
                }
              }
            : undefined
        })
      )
    } else if (url.pathname === basePath + "/list/skill") {
      catalogReads++
      response.end(
        JSON.stringify({
          type: "skill",
          items: [
            {
              name,
              chinese_name: label,
              user_id: "another-author / E2E Publisher",
              filename: name + ".md",
              description: "Development fixture",
              version: "1.0.0"
            }
          ]
        })
      )
    } else if (url.pathname === basePath + "/download/skill/" + name) {
      downloads++
      response.setHeader("content-type", "text/markdown")
      response.setHeader("content-disposition", 'attachment; filename="SKILL.md"')
      response.end(markdown)
    } else if (url.pathname.startsWith(basePath + "/list/")) {
      response.end(JSON.stringify({ items: [] }))
    } else if (url.pathname.endsWith("/cowork/login-info")) {
      response.end(JSON.stringify({ returnCode: "SUC0000", body: user }))
    } else {
      response.writeHead(404).end("{}")
    }
  })
  let app: ElectronApplication | undefined
  let observedPage: Page | undefined
  const pageErrors: string[] = []
  try {
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer))
    const baseUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port
    await build(output, baseUrl)
    // The Vite resource plugin writes these assets beneath the default output directory.
    cpSync(join(root, "out/main/generated"), join(output, "main/generated"), { recursive: true })
    cpSync(join(root, "out/skills"), join(output, "skills"), { recursive: true })
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) =>
          value && /^(path|systemroot|windir|comspec|pathext|temp|tmp|display|lang)$/i.test(key)
      )
    ) as Record<string, string>
    for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
      env[key] = join(isolated, key)
      mkdirSync(env[key])
    }
    Object.assign(env, {
      CMB_COWORK_AGENT_HOME: data,
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
      args: [join(output, "main/index.js"), "--user-data-dir=" + join(isolated, "electron")],
      cwd: root,
      env,
      timeout: 60_000
    })
    await app.context().route(/^https?:/, (route) => {
      const url = new URL(route.request().url())
      if (url.origin === baseUrl) return route.continue()
      if (
        url.hostname.startsWith("archguardservice.paas.") &&
        url.pathname === "/cowork/login-info"
      ) {
        return route.fulfill({
          headers: { "access-control-allow-origin": "*" },
          json: { returnCode: "SUC0000", body: user }
        })
      }
      return route.abort()
    })
    const page = await app.firstWindow()
    observedPage = page
    page.on("pageerror", (error) => pageErrors.push(error.message))
    page.setDefaultTimeout(20_000)
    const settingsButton = page.getByRole("button", { name: "自定义设置", exact: true })
    const intro = page.getByRole("dialog", { name: "把助手变成适合你的工作台" })
    await settingsButton.or(intro).first().waitFor()
    if (await intro.isVisible()) {
      await intro.getByRole("button", { name: "先自己试试", exact: true }).click()
    }
    await settingsButton.waitFor()
    await page.evaluate(
      async ({ title, workspace }) => {
        await window.api.workspace.set(undefined, workspace)
        await window.api.threads.create({ title, workspacePath: workspace })
      },
      { title: originTitle, workspace }
    )
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(originTitle, { exact: true }).first().click()
    const composer = page.locator("textarea.composer-textarea")
    const originalDraft = "Unsent original draft @fixture.md"
    await composer.fill(originalDraft)
    const drop = await page.evaluateHandle(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(["Fixture attachment"], "attached.md", { type: "text/markdown" }))
      return transfer
    })
    await composer.dispatchEvent("drop", { dataTransfer: drop })
    await drop.dispose()
    const attachment = page.getByRole("button", { name: /attached\.md/ })
    await attachment.waitFor()
    const settings = page.getByRole("dialog", { name: "设置", exact: true })
    const openPlugins = async () => {
      await page.getByRole("button", { name: "自定义设置", exact: true }).click()
      await settings.getByRole("button", { name: "插件", exact: true }).click()
      await settings.getByRole("heading", { name: "Plugins", exact: true }).waitFor()
    }
    await openPlugins()
    const developer = settings.getByRole("button", { name: entry, exact: true })
    assert.equal(await developer.count(), 0)
    assert.ok(catalogReads > 0, "the existing startup path should have requested the catalog")
    published = true
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await developer.waitFor()
    const startupReads = catalogReads
    await developer.click()
    const guide = page.getByRole("dialog", { name: entry, exact: true })
    await guide.getByRole("button", { name: "安装并开始", exact: true }).click()
    await settings.waitFor({ state: "hidden" })
    await page.getByText(name, { exact: true }).waitFor()
    assert.equal(await composer.inputValue(), "帮我创造项目模式插件")
    assert.equal(downloads, 1)
    assert.equal(catalogReads, startupReads, "using the guide must not request the catalog again")
    const installed = await page.evaluate(
      (path) => window.api.skills.read(path),
      join(data, "skills", name, "SKILL.md")
    )
    assert.equal(installed.success, true)
    assert.equal(installed.content, markdown)
    const exported = await page.evaluate(
      (path) => window.api.skills.exportForMarket(path),
      join(data, "skills", name, "SKILL.md")
    )
    assert.equal(exported.success, true)
    console.log(
      "PASS plugin management installs the publisher-approved editable source and opens a draft in the latest workspace"
    )

    await page.getByText(originTitle, { exact: true }).first().click()
    assert.equal(await composer.inputValue(), originalDraft)
    await attachment.waitFor()
    await page.getByRole("button", { name: "应用市场", exact: true }).click()
    await page.getByRole("heading", { name: label }).click()
    await page.getByRole("button", { name: "开始开发", exact: true }).click()
    await composer.waitFor()
    await page.getByText(name, { exact: true }).waitFor()
    assert.equal(await composer.inputValue(), "帮我创造项目模式插件")
    assert.equal(downloads, 1, "starting an already installed skill does not download it again")
    console.log(
      "PASS market details share the launcher and preserve the original draft and attachment"
    )

    const workspaceShortcut = page
      .getByRole("button", { name: entry, exact: true })
      .and(page.getByTitle(entry, { exact: true }))
    if (!(await workspaceShortcut.isVisible())) {
      await page.getByRole("button", { name: /^(?:工作目录)$/ }).click()
    }
    await workspaceShortcut.getByText("项", { exact: true }).waitFor()
    await workspaceShortcut.click()

    await page.waitForFunction(async (title) => {
      const threads = await window.api.threads.list()
      return threads.filter((thread) => thread.metadata?.title === title).length === 3
    }, entry)
    await page.getByText(name, { exact: true }).waitFor()
    assert.equal(await composer.inputValue(), "帮我创造项目模式插件")
    assert.equal(downloads, 1)
    assert.deepEqual(
      await page.evaluate(
        async ({ title, workspace }) => {
          const threads = await window.api.threads.list()
          return threads
            .filter((thread) => thread.metadata?.title === title)
            .map((thread) => thread.metadata?.workspacePath === workspace)
        },
        { title: entry, workspace }
      ),
      [true, true, true]
    )
    console.log("Name-only market shortcut E2E passed in built Electron")
  } catch (error) {
    console.error("Shortcut browser errors", pageErrors)
    if (observedPage && !observedPage.isClosed()) {
      const visible = await observedPage
        .evaluate(() => document.body.innerText.slice(0, 1500))
        .catch(() => "")
      console.error("Shortcut browser view", visible)
    }
    throw error
  } finally {
    await app?.close()
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()))
    rmSync(isolated, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
