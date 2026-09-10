/** Actual React effect/error boundaries and tool formatters in Electron's Chromium. */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { _electron } from "playwright"
import type { WhiteScreenFixture } from "./support/stream-white-screen-fixture"

type FixtureWindow = Window & { whiteScreenFixture: WhiteScreenFixture }

async function main() {
  const root = resolve(import.meta.dirname, "..")
  const require = createRequire(import.meta.url)
  const isolated = mkdtempSync(join(tmpdir(), "cmb-white-screen-browser-"))
  const artifacts = join(root, "output/stream-white-screen/browser")
  mkdirSync(artifacts, { recursive: true })
  const bundle = await build({
    entryPoints: [join(root, "tests/support/stream-white-screen-fixture.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": join(root, "src/renderer/src") }
  })
  const html = join(isolated, "index.html")
  writeFileSync(
    html,
    '<style>body{font:16px Arial;padding:24px}svg{width:20px;height:20px}button{margin:10px;padding:10px}</style><div id="root"></div>'
  )
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `const {app,BrowserWindow}=require("electron");app.whenReady().then(()=>new BrowserWindow({width:1000,height:700,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(html)}));`
  )
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [entry, `--user-data-dir=${join(isolated, "profile")}`],
    env,
    timeout: 30_000
  })
  const results: string[] = []
  try {
    const page = await app.firstWindow()
    await page.waitForURL(/index\.html$/)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const render = async (name: string, args: unknown, result: unknown) => {
      await page.evaluate(
        ({ name, args, result }) => {
          ;(window as unknown as FixtureWindow).whiteScreenFixture.tool(name, args, result)
        },
        { name, args, result }
      )
      await page.getByTestId("healthy-sibling").waitFor()
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
      )
      assert.equal(await page.getByText("页面出现异常", { exact: true }).count(), 0)
    }
    await render("read_file", { path: "sample.ts" }, "file contents\n".repeat(500))
    assert.ok((await page.locator("body").innerText()).includes("sample.ts"))
    results.push("read_file large result rendered")
    await render("execute", { command: { malformed: true } }, { stdout: "done", exitCode: 0 })
    results.push("non-string tool arguments remained local")
    await render("grep", { pattern: "match" }, [null])
    await page.getByText("工具渲染失败（grep）", { exact: true }).waitFor()
    results.push("malformed tool result caught by card boundary")
    await render("grep", { pattern: "match" }, [{ path: "file.ts", line: 1, content: "match" }])
    assert.equal(await page.getByText("工具渲染失败（grep）", { exact: true }).count(), 0)
    results.push("valid tool rendering recovers on next mount")
    await page.evaluate(() => (window as unknown as FixtureWindow).whiteScreenFixture.failApp())
    await page.getByText("页面出现异常", { exact: true }).waitFor()
    await page.waitForFunction(() =>
      (window as unknown as FixtureWindow).whiteScreenFixture.close()
    )
    await page.getByText("仍有任务正在运行", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as FixtureWindow).whiteScreenFixture.responses),
      [[1, "cancel", false]]
    )
    await page.screenshot({ path: join(artifacts, "app-error-fallback.png") })
    results.push("effect error shows fallback; close prompt still works")
    writeFileSync(join(artifacts, "result.json"), JSON.stringify({ results }, null, 2))
    console.log(JSON.stringify({ results, artifacts }))
  } finally {
    await app.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
