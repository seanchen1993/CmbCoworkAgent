import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { COMMUNITY_EXAMPLES } from "../src/main/mods/community-examples"

interface SparksWorkspaceFixtureWindow extends Window {
  fixture: {
    active(value: boolean): void
    fail(): void
  }
}

async function main() {
  const output = resolve("output/sparks-ux-20261011", `browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const folder = resolve("src/renderer/src/components/customize")
  const cssEntry = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssEntry, "utf8"), {
    base: dirname(cssEntry),
    from: cssEntry,
    onDependency: () => undefined
  })
  const candidates = new Scanner({}).scanFiles(
    [folder, resolve("src/renderer/src/components/ui")].flatMap((directory) =>
      readdirSync(directory)
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => ({
          content: readFileSync(resolve(directory, file), "utf8"),
          extension: "tsx"
        }))
    )
  )
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{ModsPanel}from'./src/renderer/src/components/customize/ModsPanel';
const calls=[];let failExamples=false,active=true;const status={workspace:'C:/demo',enabled:false,outputPolicy:true,mods:[],functionMods:[],diagnostics:[]};
const examples=${JSON.stringify(COMMUNITY_EXAMPLES)};
window.api={plugins:{list:async()=>[{id:'test',name:'测试灵件',modCount:1}]},mods:{
communityExamples:{list:async()=>{if(failExamples)throw Error('MODS_EXAMPLE_UNAVAILABLE');return{examples}}},status:async()=>status,globalEnabled:async()=>false,onConfigurationChanged:()=>()=>{},
development:{status:async()=>({workspace:'C:/demo',enabled:false,drafts:[],trials:[]}),onChanged:()=>()=>{}},
authoring:{list:async()=>{calls.push('list');return{workspace:'C:/demo',drafts:[]}}},audit:async()=>({rows:[],nextCursor:null})}};
window.electron={openExternal:async()=>{}};
const root=createRoot(document.getElementById('root'));let revision=0;const mount=()=>root.render(<div data-active={active}><div hidden={!active} inert={!active}><ModsPanel key={revision} active={active} threadId='chat-demo' workspaceHint='C:/demo'/></div></div>);
window.fixture={calls,active:value=>{active=value;mount()},fail:()=>{failExamples=true;revision++;mount()}};mount();
`
    },
    bundle: true,
    write: false,
    jsx: "automatic",
    platform: "browser",
    format: "iife",
    alias: { "@": resolve("src/renderer/src") },
    loader: { ".md": "text", ".png": "dataurl" },
    logLevel: "warning"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 950 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.route("http://localhost/workspace", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<div id='root'></div>"
      })
    )
    await page.goto("http://localhost/workspace")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const click = (name: string) => page.getByRole("button", { name, exact: true }).click()
    await page.getByRole("heading", { name: "挑一个小帮手" }).waitFor()
    assert.equal(await page.getByRole("article").count(), 3)
    assert.equal(await page.getByRole("button", { name: "打开草稿库" }).count(), 0)
    assert.equal(await page.getByRole("button", { name: "开启灵件并开始制作" }).count(), 0)
    const style = await page
      .getByRole("button", { name: "添加并使用" })
      .first()
      .evaluate((node) => {
        const s = getComputedStyle(node)
        const grid = getComputedStyle(node.closest("article")!.parentElement!)
        return {
          padding: s.paddingLeft,
          background: s.backgroundColor,
          columns: grid.gridTemplateColumns
        }
      })
    assert(parseFloat(style.padding) > 0)
    assert.notEqual(style.background, "rgba(0, 0, 0, 0)")
    assert.equal(style.columns.split(" ").length, 3)
    await page.screenshot({ path: resolve(output, "desktop.png"), fullPage: true })
    await click("自己制作")
    await click("高级：编辑源码与历史版本")
    await click("打开草稿库")
    await click("新建草稿")
    await page.getByLabel("草稿名称", { exact: true }).fill("我的草稿")
    await page.getByLabel("用途说明", { exact: true }).fill("保留这段尚未保存的需求")
    await click("挑选使用")
    assert.equal(await page.getByRole("textbox", { name: "用途说明" }).count(), 0)
    assert(
      await page
        .locator('textarea[aria-label="用途说明"]')
        .evaluate((node) => Boolean(node.closest("[inert]")))
    )
    await click("我已添加")
    await page.getByText("添加后还需项目授权", { exact: false }).waitFor()
    await click("卸载")
    await page.getByRole("dialog").waitFor()
    await page.evaluate(() => (window as SparksWorkspaceFixtureWindow).fixture.active(false))
    await page.locator('[data-active="false"]').waitFor({ state: "attached" })
    assert.equal(await page.getByRole("dialog").count(), 0)
    await page.evaluate(() => (window as SparksWorkspaceFixtureWindow).fixture.active(true))
    await page.locator('[data-active="true"]').waitFor({ state: "attached" })
    assert.equal(await page.getByRole("dialog").count(), 0)
    await click("自己制作")
    assert.equal(await page.getByLabel("草稿名称", { exact: true }).inputValue(), "我的草稿")
    assert.equal(
      await page.getByLabel("用途说明", { exact: true }).inputValue(),
      "保留这段尚未保存的需求"
    )
    await click("返回需求制作")
    assert.equal(await page.getByRole("textbox", { name: "用途说明" }).count(), 0)
    await click("高级：编辑源码与历史版本")
    assert.equal(
      await page.getByLabel("用途说明", { exact: true }).inputValue(),
      "保留这段尚未保存的需求"
    )
    await click("挑选使用")
    await page.setViewportSize({ width: 375, height: 850 })
    const columns = await page
      .getByRole("article")
      .first()
      .evaluate((node) => getComputedStyle(node.parentElement!).gridTemplateColumns)
    assert.equal(columns.split(" ").length, 1)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: resolve(output, "narrow.png"), fullPage: true })
    await page.evaluate(() => (window as SparksWorkspaceFixtureWindow).fixture.fail())
    await page.getByRole("alert").waitFor()
    assert.equal(
      await page.getByText("MODS_EXAMPLE_UNAVAILABLE", { exact: true }).isVisible(),
      false
    )
    await page.getByText("技术详情", { exact: true }).click()
    assert.equal(
      await page.getByText("MODS_EXAMPLE_UNAVAILABLE", { exact: true }).isVisible(),
      true
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify(
        {
          passed: true,
          style,
          checks: [
            "default example selection with one main action per card",
            "desktop styled three columns and 375px single column",
            "unsaved draft survives all workspace tabs and advanced switch",
            "hidden editor is inert",
            "installed scope and authorization distinction visible",
            "hidden settings closes uninstall confirmation without restoring it",
            "technical error details stay collapsed but remain inspectable",
            "no page errors"
          ]
        },
        null,
        2
      )
    )
    console.log(`PASS sparks workspace UX: ${output}`)
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
