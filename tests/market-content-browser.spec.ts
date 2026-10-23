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
  const isolated = mkdtempSync(join(tmpdir(), "cmb-market-content-browser-"))
  const artifacts = join(root, "output/market-content-protection")
  mkdirSync(artifacts, { recursive: true })
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets)
    .filter((name) => name.startsWith("index-") && name.endsWith(".css"))
    .sort((a, b) => statSync(join(assets, b)).size - statSync(join(assets, a)).size)[0]
  assert(css, "Run npm run build before the browser regression")
  const bundle = await build({
    entryPoints: [join(root, "tests/support/market-content-fixture.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    alias: { "@": join(root, "src/renderer/src") }
  })
  const html = join(isolated, "index.html")
  writeFileSync(
    html,
    `<html><head><link rel="stylesheet" href="${pathToFileURL(join(assets, css)).href}"></head><body><div id="root"></div></body></html>`
  )
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `const {app,BrowserWindow}=require("electron");app.disableHardwareAcceleration();app.commandLine.appendSwitch("disable-features","CalculateNativeWinOcclusion");app.whenReady().then(()=>new BrowserWindow({show:true,width:1100,height:760,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(html)}));`
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
    await page.getByText("内容受保护", { exact: false }).waitFor()
    assert.equal(await page.getByRole("button", { name: "编辑", exact: true }).count(), 0)
    assert.equal(await page.getByText("原始技能内容", { exact: true }).count(), 0)
    await page.screenshot({ animations: "disabled", path: join(artifacts, "market-protected.png") })
    await page.evaluate(() =>
      (
        window as unknown as { renderMarketContentFixture: (value: boolean) => void }
      ).renderMarketContentFixture(false)
    )
    await page.getByText("原始技能内容", { exact: true }).waitFor()
    await page.getByRole("button", { name: "编辑", exact: true }).click()
    await page.locator("textarea").waitFor()
    assert((await page.locator("textarea").inputValue()).includes("原始技能内容"))
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "original-editable.png")
    })
    await page.evaluate(() =>
      (
        window as unknown as { renderMarketPluginFixture: (value: boolean) => void }
      ).renderMarketPluginFixture(true)
    )
    await page.getByText("具体 Hooks、Skills、MCP 配置详情已隐藏", { exact: false }).waitFor()
    assert.equal(await page.getByText("private-mcp-server", { exact: true }).count(), 0)
    await page.screenshot({
      animations: "disabled",
      path: join(artifacts, "market-plugin-protected.png")
    })
    await page.evaluate(() =>
      (
        window as unknown as { renderMarketPluginFixture: (value: boolean) => void }
      ).renderMarketPluginFixture(false)
    )
    await page.getByText("private-mcp-server", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log(
      "Market content browser regression passed: protected skills/plugins hidden; originals viewable and editable"
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
