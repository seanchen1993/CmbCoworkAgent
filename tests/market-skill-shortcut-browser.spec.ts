import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { _electron } from "playwright"

interface ShortcutFixture {
  selectThread: (threadId: string) => void
  openView: (view: string) => void
  hasPendingInstall: () => boolean
  finishInstall: () => void
  clearInstalled: () => void
  readClipboard: () => string
  publish: (enabled: boolean) => void
  loadCatalog: () => void
  setAdministrator: (allowed: boolean) => void
}
declare global {
  interface Window {
    shortcutFixture: ShortcutFixture
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const isolated = mkdtempSync(join(tmpdir(), "cmb-market-shortcut-browser-"))
  const bundle = await build({
    entryPoints: [join(root, "tests/support/market-skill-shortcut-fixture.tsx")],
    alias: { "@": join(root, "src/renderer/src") },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [
      {
        name: "shortcut-fixture-store",
        setup(builder) {
          builder.onResolve({ filter: /(?:^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "fixture-store",
            namespace: "shortcut-fixture"
          }))
          builder.onLoad({ filter: /^fixture-store$/, namespace: "shortcut-fixture" }, () => ({
            contents: `
            import { create } from "zustand"
            export const useAppStore = create((set) => ({
              bumpPluginVersion: () => {},
              setShowCustomizeView: (show, tab) => { if (show) set({mainView: tab}) },
              selectThread: (threadId) => set({currentThreadId: threadId, mainView: "thread"}),
              setMainView: (mainView) => set({mainView}),
              accountRevision: 0,
              currentThreadId: null,
              mainView: "thread",
              showCustomizeView: false
            }))
          `,
            loader: "js",
            resolveDir: root
          }))
        }
      }
    ]
  })
  const html = join(isolated, "index.html")
  writeFileSync(html, '<meta charset="UTF-8"><div id="root"></div>')
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `
    const {app, BrowserWindow} = require("electron")
    app.disableHardwareAcceleration()
    app.whenReady().then(() => new BrowserWindow({show: true}).loadFile(${JSON.stringify(html)}))
  `
  )
  const app = await _electron.launch({
    executablePath: createRequire(import.meta.url)("electron"),
    args: [entry, `--user-data-dir=${join(isolated, "profile")}`]
  })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (error) => console.error(error))
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const development = page.getByRole("button", { name: "开发项目模式插件", exact: true })
    const draft = page.getByRole("textbox", { name: "消息草稿" })
    const copy = page.getByRole("button", { name: "复制导航配置" })
    const startDevelopment = page.getByRole("button", { name: "开始开发", exact: true })
    const guide = page.getByRole("dialog", { name: "开发项目模式插件" })
    const install = guide.getByRole("button", { name: "安装技能" })
    const original = "继续这个会话的草稿 @spec.md"
    await draft.fill(original)
    await page.getByLabel("草稿附件").setInputFiles({
      name: "spec.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# specification")
    })
    await page.evaluate(() => window.shortcutFixture.openView("plugins"))
    await development.waitFor({ state: "hidden" })
    await page.evaluate(() => {
      window.shortcutFixture.publish(true)
      window.shortcutFixture.loadCatalog()
    })
    await development.waitFor()

    await page.evaluate(() => window.shortcutFixture.selectThread("new"))
    await development.waitFor({ state: "hidden" })
    assert.equal(await draft.inputValue(), original)

    await page.evaluate(() => window.shortcutFixture.openView("market"))
    await copy.click()
    assert.deepEqual(
      JSON.parse(await page.evaluate(() => window.shortcutFixture.readClipboard())),
      {
        conversationShortcuts: {
          projectPluginCreation: { itemId: "fixture-item", marketName: "fixture-market-name" }
        }
      }
    )
    await startDevelopment.waitFor()
    await page.evaluate(() => window.shortcutFixture.openView("other-market"))
    await startDevelopment.waitFor({ state: "hidden" })

    await page.evaluate(() => window.shortcutFixture.openView("harness"))
    const name = page.getByRole("textbox", { name: "项目名称" })
    const adapter = page.getByRole("combobox", { name: "插件选择" })
    await name.fill("未保存的项目")
    await adapter.selectOption("installed-adapter")
    await development.click()
    await install.click()
    await page.waitForFunction(() => window.shortcutFixture.hasPendingInstall())
    await page.evaluate(() => window.shortcutFixture.finishInstall())
    await guide.getByText(/在普通会话的技能列表中选择/).waitFor()
    await page.keyboard.press("Escape")
    await guide.waitFor({ state: "hidden" })
    assert.equal(await name.inputValue(), "未保存的项目")
    assert.equal(await adapter.inputValue(), "installed-adapter")

    await page.evaluate(() => window.shortcutFixture.selectThread("new"))
    assert.equal(await draft.inputValue(), original)
    assert.equal(await page.getByLabel("已附加文件").textContent(), "spec.md")
    await development.waitFor({ state: "hidden" })

    await page.evaluate(() => window.shortcutFixture.openView("market"))
    await startDevelopment.click()
    await guide.getByText(/在普通会话的技能列表中选择/).waitFor()
    await page.keyboard.press("Escape")

    await page.evaluate(() => window.shortcutFixture.openView("workspace-plugins"))
    const workspaceGuide = page.getByTitle("开发项目模式插件")
    await workspaceGuide.hover()
    await workspaceGuide.click()
    await workspaceGuide.waitFor({ state: "hidden" })
    await development.click()
    await guide.getByText(/在普通会话的技能列表中选择/).waitFor()
    await page.keyboard.press("Escape")
    await page.evaluate(() => window.shortcutFixture.publish(false))
    await development.waitFor({ state: "hidden" })
    await page.evaluate(() => window.shortcutFixture.openView("market"))
    await startDevelopment.waitFor({ state: "hidden" })
    await page.evaluate(() => window.shortcutFixture.openView("harness"))
    await development.waitFor({ state: "hidden" })
    await name.waitFor()
    await page.evaluate(() => window.shortcutFixture.openView("workspace-plugins"))
    await workspaceGuide.waitFor({ state: "hidden" })
    console.log("Market skill shortcut browser regression passed")
  } finally {
    await app.close()
    rmSync(isolated, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
