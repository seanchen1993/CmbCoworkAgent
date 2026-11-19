import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { _electron } from "playwright"

interface ShortcutFixture {
  selectThread: (threadId: string) => void
  hasPendingInstall: () => boolean
  finishInstall: () => void
  clearInstalled: () => void
  readClipboard: () => string
  publish: (enabled: boolean) => void
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
          builder.onLoad({ filter: /.*/, namespace: "shortcut-fixture" }, () => ({
            contents: `
            import { create } from "zustand"
            export const useAppStore = create(() => ({
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
    const shortcut = page.getByRole("button", { name: "开发项目模式插件" })
    const copy = page.getByRole("button", { name: "复制导航配置" })
    await copy.waitFor()
    await shortcut.waitFor({ state: "hidden" })
    await copy.click()
    assert.deepEqual(
      JSON.parse(await page.evaluate(() => window.shortcutFixture.readClipboard())),
      {
        conversationShortcuts: {
          projectPluginCreation: { itemId: "fixture-item", marketName: "fixture-market-name" }
        }
      }
    )
    await shortcut.waitFor({ state: "hidden" })
    await page.evaluate(() => window.shortcutFixture.publish(true))
    await shortcut.waitFor()
    await page.getByText("当前会话导航", { exact: true }).waitFor()
    await page.evaluate(() => window.shortcutFixture.setAdministrator(false))
    await copy.waitFor({ state: "hidden" })
    await shortcut.waitFor()
    await page.evaluate(() => window.shortcutFixture.selectThread("history"))
    await page.getByText("历史消息").waitFor()
    await shortcut.waitFor()

    const textarea = page.getByRole("textbox", { name: "消息草稿" })
    const draft = "继续这个会话的草稿 @spec.md"
    await textarea.fill(draft)
    const attachment = page.getByLabel("草稿附件")
    await attachment.setInputFiles({
      name: "spec.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# spec")
    })
    await shortcut.click()
    const install = page.getByRole("dialog").getByRole("button", { name: "安装并使用" })
    await install.click()
    await page.waitForFunction(() => window.shortcutFixture.hasPendingInstall())
    await page.evaluate(() => window.shortcutFixture.finishInstall())
    await page.getByText("project-plugin-author", { exact: true }).waitFor()
    assert.equal(await textarea.inputValue(), draft)
    assert.equal(
      await attachment.evaluate((element: HTMLInputElement) => element.files?.[0]?.name),
      "spec.md"
    )
    assert.equal(await page.getByLabel("发送次数").textContent(), "0")

    await page.evaluate(() => {
      window.shortcutFixture.clearInstalled()
      window.shortcutFixture.selectThread("another")
    })
    await shortcut.click()
    await install.click()
    await page.waitForFunction(() => window.shortcutFixture.hasPendingInstall())
    await page.evaluate(() => {
      window.shortcutFixture.selectThread("different")
      window.shortcutFixture.finishInstall()
    })
    await page.getByRole("dialog").waitFor({ state: "hidden" })
    assert.equal(await page.getByLabel("技能").textContent(), "")

    await page.evaluate(() => window.shortcutFixture.publish(false))
    await shortcut.waitFor({ state: "hidden" })
    await page.getByText("当前会话导航", { exact: true }).waitFor({ state: "hidden" })
    await copy.waitFor({ state: "hidden" })
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
