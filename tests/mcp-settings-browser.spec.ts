/** Real connector panels with controlled IPC failures. Requires npm run build for CSS. */
import assert from "node:assert/strict"
import { mkdir, readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      contents: `import React,{StrictMode}from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{McpPanel}from'./src/renderer/src/components/customize/McpPanel';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
      window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');
      window.api={mcp:{list:window.fixtureList,setEnabled:window.fixtureEnabled,setLazyLoad:window.fixtureLazy,testConnection:window.fixtureTest}};
      createRoot(document.getElementById('root')).render(<StrictMode><Toaster/><div style={{display:'flex',height:'100vh'}}><aside style={{width:200,flexShrink:0,padding:24}}>设置</aside><McpPanel/></div></StrictMode>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env": "{}" },
    plugins: [
      {
        name: "no-market-network",
        setup(builder) {
          builder.onResolve({ filter: /api\/market$/ }, () => ({
            path: "market",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: "export const marketApi={getMcps:async()=>({success:true,data:[]})}",
            loader: "js"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 } })
  const output = resolve("output/mcp-settings")
  await mkdir(output, { recursive: true })
  const assets = resolve("out/renderer/assets")
  const css = (await readdir(assets)).find((name) => /^index-.*\.css$/.test(name))
  assert.ok(css, "Build the renderer before running the connector browser journey")
  page.setDefaultTimeout(5000)
  const connectors = ["Alpha", "Beta"].map((name) => ({
    id: name.toLowerCase(),
    name,
    kind: "remote",
    url: `https://${name.toLowerCase()}.invalid/mcp`,
    enabled: true,
    lazyLoad: false,
    createdAt: "2026-10-04",
    updatedAt: "2026-10-04"
  }))
  let failRead = true
  let rejectWrite = true
  let releaseWrite: (() => void) | undefined
  const testResponses = new Map<string, (value: unknown) => void>()
  const writes: string[] = []
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureList", async () => {
      if (failRead) throw new Error("fixture: read failed")
      return connectors
    })
    await page.exposeFunction("fixtureEnabled", async (id: string, enabled: boolean) => {
      writes.push("enabled")
      await new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
      if (rejectWrite) throw new Error("fixture: write failed")
      connectors.find((connector) => connector.id === id)!.enabled = enabled
    })
    await page.exposeFunction("fixtureLazy", async (id: string, lazyLoad: boolean) => {
      writes.push("lazy")
      connectors.find((connector) => connector.id === id)!.lazyLoad = lazyLoad
    })
    await page.exposeFunction(
      "fixtureTest",
      ({ id }: { id: string }) =>
        new Promise((resolve) => {
          testResponses.set(id, resolve)
        })
    )
    await page.setContent('<html><body><div id="root"></div></body></html>')
    await page.addStyleTag({ content: await readFile(join(assets, css), "utf8") })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("alert").getByText("读取连接器失败，请重试。").waitFor()
    assert.ok(await page.getByRole("button", { name: "添加连接器", exact: true }).isDisabled())
    failRead = false
    await page.getByRole("button", { name: "重试", exact: true }).click()
    await page.getByRole("button", { name: "Alpha", exact: true }).waitFor()
    await page.getByPlaceholder("搜索", { exact: true }).fill("Beta")
    await page.getByRole("button", { name: "清除", exact: true }).click()
    // Cross the original 200 ms debounce deadline; a cleared search must not
    // be replaced by the older queued query.
    await new Promise((resolve) => setTimeout(resolve, 250))
    await page.getByRole("button", { name: "Beta", exact: true }).waitFor()
    await page.getByRole("button", { name: "Alpha", exact: true }).click()
    const enabled = page.getByRole("button", { name: "已启用", exact: true })
    await enabled.click()
    assert.ok(
      await enabled.isDisabled(),
      "Pending state must not pretend the connector was disabled"
    )
    assert.ok(await page.getByRole("button", { name: "已关闭", exact: true }).isDisabled())
    assert.ok(releaseWrite)
    releaseWrite()
    await page.getByText("未能确认连接器设置已生效，请重试。", { exact: true }).waitFor()
    await enabled.waitFor()
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent === "已启用" && !button.disabled
      )
    )
    assert.deepEqual(writes, ["enabled"])
    rejectWrite = false
    releaseWrite = undefined
    await enabled.click()
    assert.ok(releaseWrite)
    releaseWrite()
    await page.getByRole("button", { name: "已禁用", exact: true }).waitFor()
    await page.getByRole("button", { name: "已关闭", exact: true }).click()
    await page.getByRole("button", { name: "已开启", exact: true }).waitFor()
    assert.deepEqual(
      writes,
      ["enabled", "enabled", "lazy"],
      "Strict Mode must not replay writes from a state updater"
    )

    await page.getByRole("button", { name: "测试连接", exact: true }).click()
    await page.getByRole("button", { name: "Beta", exact: true }).click()
    await page.getByRole("button", { name: "测试连接", exact: true }).click()
    testResponses.get("alpha")!({ success: true, tools: ["ALPHA_SHOULD_NOT_APPEAR"] })
    testResponses.get("beta")!({ success: true, tools: ["BETA_TOOL"] })
    await page.getByText("BETA_TOOL", { exact: true }).waitFor()
    assert.equal(await page.getByText("ALPHA_SHOULD_NOT_APPEAR", { exact: true }).count(), 0)
    await page.screenshot({ animations: "disabled", path: join(output, "connectors-light.png") })
    await page.setViewportSize({ width: 640, height: 620 })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
    )
    await page.getByRole("button", { name: "所有连接器", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "Alpha", exact: true }).isVisible(), false)
    const lazy = await page.getByRole("button", { name: "已关闭", exact: true }).boundingBox()
    assert.ok(lazy && lazy.x >= 0 && lazy.x + lazy.width <= 640)
    await page.screenshot({
      animations: "disabled",
      path: join(output, "connectors-dark-narrow.png")
    })
    await page.getByRole("button", { name: "所有连接器", exact: true }).click()
    await page.getByRole("button", { name: "Alpha", exact: true }).click()
    await page.getByRole("button", { name: "已禁用", exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log(
      "PASS connector read retry, confirmed toggles, serialized writes and scoped connection tests"
    )
  } catch (error) {
    console.error("Renderer errors:", errors)
    throw error
  } finally {
    releaseWrite?.()
    for (const resolve of testResponses.values())
      resolve({ success: false, error: "fixture closed" })
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
