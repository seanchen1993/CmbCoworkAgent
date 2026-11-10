import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const require = createRequire(import.meta.url)
  const isolated = mkdtempSync(join(tmpdir(), "cmb-project-plugin-browser-"))
  const artifacts = join(root, "output/project-plugin-fix")
  mkdirSync(artifacts, { recursive: true })
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets)
    .filter((name) => name.startsWith("index-") && name.endsWith(".css"))
    .sort((a, b) => statSync(join(assets, b)).size - statSync(join(assets, a)).size)[0]
  assert(css, "Run npm run build first")
  const highlightWorker = readdirSync(assets).find(
    (name) => name.startsWith("code-highlight-worker-") && name.endsWith(".js")
  )
  assert(highlightWorker, "Expected built code highlight worker")
  const bundle = await build({
    entryPoints: [join(root, "tests/support/project-plugin-fixture.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    alias: { "@": join(root, "src/renderer/src") },
    plugins: [
      {
        name: "built-highlight-worker",
        setup(builder) {
          builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight",
            namespace: "built-worker"
          }))
          builder.onLoad({ filter: /.*/, namespace: "built-worker" }, () => ({
            contents: `export default class extends Worker { constructor(options) { super(${JSON.stringify(pathToFileURL(join(assets, highlightWorker)).href)}, options) } }`,
            loader: "js"
          }))
        }
      }
    ]
  })
  const html = join(isolated, "index.html")
  writeFileSync(
    html,
    `<html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css)).href}"></head><body><div id="root"></div></body></html>`
  )
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `const {app,BrowserWindow}=require("electron");app.disableHardwareAcceleration();app.whenReady().then(()=>new BrowserWindow({show:false,width:1100,height:850,webPreferences:{offscreen:true,backgroundThrottling:false}}).loadFile(${JSON.stringify(html)}));`
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  )
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [entry, `--user-data-dir=${join(isolated, "profile")}`],
    env
  })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "安装", exact: true }).click()
    await page.getByRole("button", { name: "重装", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).count(), 0)
    await page.getByText("约束正文可以正常预览。", { exact: false }).waitFor()
    assert.equal(await page.getByText("文件预览需要授权").count(), 0)
    await page.getByRole("button", { name: "重装", exact: true }).click()
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "installed-and-knowledge-preview.png")
    })
    await page.getByRole("button", { name: "卸载", exact: true }).click()
    await page.getByRole("button", { name: "安装", exact: true }).waitFor()
    const counters = await page.evaluate(
      () =>
        (
          window as unknown as {
            projectPluginCounters: { refresh: number; reads: number; reinstall: number }
          }
        ).projectPluginCounters
    )
    assert.equal(counters.refresh, 1)
    assert.equal(counters.reinstall, 1)
    assert(counters.reads > 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: installed/reinstall/uninstall actions, shared-IP ownership, renewed knowledge preview"
    )
  } finally {
    await app.close()
    rmSync(isolated, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
