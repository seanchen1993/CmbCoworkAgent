/** Real task tour, keyboard/navigation handoff and narrow-screen draft preservation. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { build as bundle } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

async function main() {
  const output = resolve("output/plain-language-20261013", `sparks-tour-preview-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const cssPath = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const candidates = new Scanner({}).scanFiles(
    ["SparksTour", "SparksTourExamples"].map((name) => ({
      content: readFileSync(resolve(`src/renderer/src/components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const css = compiler.build([...candidates, "h-screen", "flex", "flex-col", "relative", "min-w-0"])
  const script = await bundle({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {SparksTour} from './src/renderer/src/components/customize/SparksTour';
    import {SettingsOverlay} from './src/renderer/src/components/customize/SettingsOverlay';
    window.calls=[]; window.api=new Proxy({}, {get(){throw Error('Tour called IPC')}});
    function App(){const [open,setOpen]=useState(false);return <SettingsOverlay onClose={()=>window.calls.push(['outer-settings-closed'])}><main className="relative flex h-screen min-w-0 flex-col">
      <SparksTour visible activePage="mods" activeSection="create" onOpenChange={setOpen}
        onNavigate={(...args)=>window.calls.push(args)} onPractice={(...args)=>window.calls.push(args)}/>
      <div inert={open} aria-hidden={open||undefined} data-real-controls><textarea aria-label="原草稿" defaultValue="保留原内容"/></div>
    </main></SettingsOverlay>} createRoot(document.getElementById('root')).render(<App/>);
  `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://tour.local/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://tour.local/")
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    const tour = page.getByRole("region", { name: "新功能导览", exact: true })
    await tour.waitFor()
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab")
      assert(await page.evaluate(() => !document.activeElement?.closest("[data-real-controls]")))
    }
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 720 })
      for (let task = 0; task < 3; task++) {
        await tour.getByLabel("选择任务", { exact: true }).selectOption(String(task))
        const primary = tour.locator("button.bg-primary")
        await primary.click()
        if (task === 0) await tour.getByLabel("新插件名称").fill("我的订单助手")
        await primary.click()
        assert.equal(
          await tour.getByLabel("示例界面预览").getAttribute("data-tour-preview-stage"),
          "2"
        )
        if (task === 1) {
          assert.equal(await tour.getByRole("checkbox").count(), 0)
          await tour.getByText("示例：组合已应用 · 尚未开始任务", { exact: true }).waitFor()
          assert.match(await tour.innerText(), /不会自动运行已保存的任务方案/)
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        await page.screenshot({ path: resolve(output, `${width}-task-${task}.png`) })
        assert.deepEqual(
          await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls),
          [],
          "Examples must not navigate real pages"
        )
      }
      await tour.getByLabel("选择任务", { exact: true }).selectOption("0")
    }
    await tour.locator("button.bg-primary").click()
    await tour.getByLabel("新插件名称").fill("我的订单助手")
    await tour.locator("button.bg-primary").click()
    await tour.getByRole("button", { name: "去描述我的功能", exact: true }).focus()
    await page.keyboard.press("Enter")
    await tour.waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls), [
      ["create", "我的订单助手"]
    ])
    assert.equal(await page.getByLabel("原草稿").inputValue(), "保留原内容")
    assert.equal(await page.evaluate(() => localStorage.getItem("devclaw.sparks-tour.v1")), "seen")
    await page.getByRole("button", { name: "新功能导览", exact: true }).click()
    await page.keyboard.press("Escape")
    await tour.waitFor({ state: "detached" })
    assert.deepEqual(
      await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls),
      [["create", "我的订单助手"]],
      "Escape must only close the inner tour, not the real Radix settings overlay"
    )
    assert.equal(await page.getByLabel("原草稿").inputValue(), "保留原内容")
    assert.equal(
      await page
        .getByRole("button", { name: "看看这页怎么用" })
        .evaluate((node) => node === document.activeElement),
      true
    )
    await page.reload()
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByRole("button", { name: "新功能导览", exact: true }).waitFor()
    assert.equal(await tour.count(), 0, "Existing seen state must prevent upgrade popup")
    assert.deepEqual(errors, [])
    console.log(
      "PASS three real task previews, keyboard handoff, 375px, original draft and seen state"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
