/** Actual Work hook/panel; only the bounded metadata API is a fixture. No ChatContainer claim. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "m05-work-directory-")),
    binary = createRequire(import.meta.url)("electron") as string
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const bundle = await build({
      entryPoints: [resolve("tests/support/bots-work-directory-fixture.tsx")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      alias: { "@": resolve("src/renderer/src") },
      define: { "process.env.NODE_ENV": '"production"' }
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="utf-8"><div id="root"></div><script>' +
        bundle.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: binary, args: [join(dir, "main.cjs")], env })
    const page = await app.firstWindow()
    await page.waitForFunction(() => Boolean((window as any).m05Directory))
    await page.waitForFunction(() => document.querySelectorAll(".bot-work-row").length === 6)
    await page.getByRole("button", { name: "更多任务", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".bot-work-row").length === 40)
    await page.getByRole("button", { name: "更多任务", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".bot-work-row").length === 45)
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.rows[0].executionState = "waiting_user"
      s.refresh()
    })
    await page.locator('[data-work-id="w0"]').getByText("等待你处理", { exact: true }).waitFor()
    assert.ok(await page.evaluate(() => (window as any).m05Directory.maxBatch <= 40))
    // A fully loaded 7-result search has no cursor, yet its last result is reachable.
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.rows.slice(0, 7).forEach((r: any) => (r.title = "Seven " + r.id))
    })
    await page.getByRole("textbox", { name: "搜索任务", exact: true }).fill("Seven")
    await page.waitForFunction(() => document.querySelectorAll(".bot-work-row").length === 6)
    await page.getByRole("button", { name: "更多任务", exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll(".bot-work-row").length === 7)
    // Late selection responses cannot restore a previous work after switching Bot.
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.hold = "w0"
      s.select("w0")
    })
    await page.waitForFunction(() => Boolean((window as any).m05Directory.release))
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.switchBot("b")
      s.select(null)
      s.release()
    })
    await page.waitForFunction(() => {
      const s = (window as any).m05Directory
      return s.botId === "b" && !s.loading
    })
    assert.equal(await page.locator("output").getAttribute("data-selected"), "")
    assert.equal(await page.locator(".bot-work-row").count(), 0)
    // Read failure also clears the former selected detail, and a later refresh can recover it.
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.hold = null
      s.switchBot("a")
      s.select("w1")
    })
    await page.locator('output[data-selected="w1"]').waitFor()
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.hold = "w0"
      s.release = null
      s.select("w0")
    })
    await page.waitForFunction(() => Boolean((window as any).m05Directory.release))
    await page.evaluate(() =>
      (window as any).m05Directory.reject(new Error("fixture read unavailable"))
    )
    await page.getByRole("alert").getByText("fixture read unavailable", { exact: false }).waitFor()
    assert.equal(await page.locator("output").getAttribute("data-selected"), "")
    await page.evaluate(() => {
      const s = (window as any).m05Directory
      s.hold = null
      s.refresh()
    })
    await page.locator('output[data-selected="w0"]').waitFor()
    console.log(
      "PASS: 45 Work metadata pagination/expanded refresh; 7 without cursor; late/failing selection; batch<=40",
      await page.evaluate(() => ({
        calls: (window as any).m05Directory.calls,
        maxBatch: (window as any).m05Directory.maxBatch,
        maxInFlight: (window as any).m05Directory.maxInFlight
      }))
    )
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
    console.log("cleanup: owned metadata fixture Electron/profile removed")
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
