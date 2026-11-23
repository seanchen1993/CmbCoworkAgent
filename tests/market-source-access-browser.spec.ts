import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "esbuild"
import { _electron } from "playwright"

interface FixtureWindow {
  marketSourceUploads: Array<{ userId: string; extraJson: string }>
  marketSourceWrites: string[]
  marketSourceDownloads: boolean[]
  renderSourceForm(type: string, extraJson?: string): void
  renderSourceEditor(access?: string): void
  renderSourceDetail(access?: string): void
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..")
  const require = createRequire(import.meta.url)
  const isolated = mkdtempSync(join(tmpdir(), "cmb-market-source-browser-"))
  const artifacts = join(root, "output/market-source-access")
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
    entryPoints: [join(root, "tests/support/market-source-access-fixture.tsx")],
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
    const field = page.getByLabel("授权用户账号")
    await field.waitFor()
    assert.equal(await field.inputValue(), "12345678")
    await field.fill("22222222, 33333333\n22222222")
    await field.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: join(artifacts, "resource-source-whitelist.png"),
      animations: "disabled"
    })
    await page.getByRole("button", { name: "更新", exact: true }).click()
    await page.getByText("保存成功").waitFor()
    const saved = await page.evaluate(
      () => (window as unknown as FixtureWindow).marketSourceUploads[0]
    )
    assert.equal(saved.userId, "uploader / 上传者 / 技术部")
    assert.deepEqual(JSON.parse(saved.extraJson).sourceAccessUserIds, ["22222222", "33333333"])
    assert.deepEqual(JSON.parse(saved.extraJson).grayUserIds, ["87654321"])
    assert.equal(JSON.parse(saved.extraJson).custom, "keep")
    await page.evaluate(
      (extra) => (window as unknown as FixtureWindow).renderSourceForm("plugin", extra),
      saved.extraJson
    )
    await field.waitFor()
    assert.equal(await field.inputValue(), "22222222\n33333333")
    await field.fill("")
    await page.getByRole("button", { name: "更新", exact: true }).click()
    await page.getByText("保存成功").waitFor()
    const cleared = await page.evaluate(
      () => (window as unknown as FixtureWindow).marketSourceUploads[1]
    )
    assert.equal(JSON.parse(cleared.extraJson).sourceAccessUserIds, undefined)
    for (const access of ["owner", "whitelist"]) {
      await page.evaluate(
        (value) => (window as unknown as FixtureWindow).renderSourceEditor(value),
        access
      )
      const editor = page.locator("textarea")
      await editor.waitFor()
      await page.waitForFunction(() =>
        document.querySelector("textarea")?.value.includes("原始技能描述")
      )
      assert.equal(await editor.isEditable(), true)
      await editor.fill("# 已编辑的原始内容 " + access)
      await page.getByRole("button", { name: "保存", exact: true }).click()
      await page.waitForFunction(
        (value) =>
          (window as unknown as FixtureWindow).marketSourceWrites.includes(
            "# 已编辑的原始内容 " + value
          ),
        access
      )
    }
    await page.screenshot({
      path: join(artifacts, "authorized-plugin-editor.png"),
      animations: "disabled"
    })
    await page.evaluate(() => (window as unknown as FixtureWindow).renderSourceEditor(undefined))
    await page.getByText("整个插件只读", { exact: true }).waitFor()
    assert.equal(await page.locator("textarea").count(), 0)
    await page.evaluate(() => (window as unknown as FixtureWindow).renderSourceDetail("whitelist"))
    await page.getByRole("button", { name: "下载原始文件" }).click()
    assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).marketSourceDownloads), [true])
    assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).count(), 0)
    await page.evaluate(() => (window as unknown as FixtureWindow).renderSourceDetail(undefined))
    await page.getByRole("button", { name: "下载原始文件" }).waitFor({ state: "hidden" })
    assert.equal(await page.getByRole("button", { name: "下载原始文件" }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: resource allowlist save/clear, owner metadata, authorized source editing, ordinary user denial"
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
