/** Real renderer goal switching keeps drafts/scope; business modules never become chat actions. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { mount } from "./mods-flow-browser.spec"

async function main() {
  const workspaceA = "C:\\Work\\Project"
  const workspaceB = "C:\\Work\\Other"
  const output = resolve("output/mods-entry-navigation", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 900 } })
  page.setDefaultTimeout(15000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await mount(page, `
      // mount() uses about:blank; the packaged Electron origin provides native randomUUID.
      if(!crypto.randomUUID){let uuid=0;crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0')}
      window.electron={process:{platform:'win32'}};
      profileView.workspace='c:/work/project';
      window.assemblyCalls=[];
      window.api.plugins={list:async()=>[{id:'autobiz',name:'AutoBiz业务来源',version:'1.0',enabled:true,
        hasProjectMode:true,skillCount:8,businessModCount:8,businessExtensionCount:1}]};
      window.api.skills={listPlugins:async()=>[]};
      window.api.businessModAssembly={
        sources:async(scope)=>{window.assemblyCalls.push(['sources',scope]);return [{pluginId:'autobiz',name:'AutoBiz业务来源'}]},
        list:async()=>[],
        inspect:async(input)=>{window.assemblyCalls.push(['inspect',input]);return {id:'source',sourceName:'AutoBiz',sourceDigest:'a'.repeat(64),
          mods:[{id:'prd',title:'需求分析',nodeId:'prd',dependsOn:[],advisory:[]},{id:'specs',title:'规格设计',nodeId:'specs',dependsOn:[],advisory:[]}],warnings:[],excluded:[]}},
        create:async()=>{throw Error('Navigation must not create')},install:async()=>{throw Error('Navigation must not install')}
      };
      window.changeEntryScope=()=>{profileView.workspace='c:/work/other';host.render(<ClawPanel threadId='b' workspaceHint={${JSON.stringify(workspaceB)}}/>)};
      window.changeToMismatchedEntryScope=()=>{host.render(<ClawPanel threadId='c' workspaceHint='C:/ActuallyDifferent'/>)};
      host.render(<ClawPanel threadId='a' workspaceHint={${JSON.stringify(workspaceA)}}/>);
    `)
    const renderer = resolve("src/renderer/src")
    const cssPath = join(renderer, "index.css")
    const compiler = await compile(readFileSync(cssPath, "utf8"), {
      base: dirname(cssPath), from: cssPath, onDependency() { /* No dependency watcher in this fixture. */ }
    })
    const candidates = new Scanner({}).scanFiles([
      "ClawPanel", "SimpleClawBuilder", "NativePluginCapabilities", "BusinessModAssemblyPanel"
    ].map((name) => ({
      content: readFileSync(join(renderer, `components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    })))
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.getByRole("heading", { name: "配置常用搭配", exact: true }).waitFor()
    await page.getByLabel("组合名称", { exact: true }).fill("保留未保存的聊天搭配")
    assert.equal(await page.getByRole("checkbox", { name: "选择 Mod 需求分析", exact: true }).count(), 0)
    await page.getByRole("button", { name: "从 Mods 组装新插件", exact: true }).click()
    await page.getByRole("heading", { name: "从业务 Mods 组装新插件", exact: true }).waitFor()
    await page.getByLabel("已安装的 Mods 来源").selectOption("autobiz")
    const first = await page.evaluate(() => (window as unknown as { assemblyCalls: unknown[][] }).assemblyCalls)
    assert.deepEqual(first, [["sources", { threadId: "a", expectedWorkspace: workspaceA }]])
    await page.getByRole("button", { name: "配置聊天搭配", exact: true }).click()
    assert.equal(await page.getByLabel("组合名称", { exact: true }).inputValue(), "保留未保存的聊天搭配")
    const card = page.getByRole("article", { name: "AutoBiz业务来源", exact: true })
    await card.getByRole("button", { name: "用这些 Mods 组装新插件", exact: true }).click()
    await page.getByRole("heading", { name: "从业务 Mods 组装新插件", exact: true }).waitFor()
    assert.equal(await page.getByLabel("已安装的 Mods 来源").inputValue(), "autobiz")
    await page.getByRole("button", { name: "读取插件 Mods", exact: true }).click()
    await page.getByRole("checkbox", { name: "选择 Mod 需求分析", exact: true }).check()
    await page.getByRole("checkbox", { name: "选择 Mod 规格设计", exact: true }).check()
    await page.getByRole("button", { name: "配置聊天搭配", exact: true }).click()
    assert.equal(await page.getByLabel("组合名称", { exact: true }).inputValue(), "保留未保存的聊天搭配")
    assert.equal(await page.getByRole("checkbox", { name: "需求分析", exact: true }).count(), 0)
    await page.getByRole("button", { name: "从 Mods 组装新插件", exact: true }).click()
    assert(await page.getByRole("checkbox", { name: "选择 Mod 需求分析", exact: true }).isChecked())
    assert(await page.getByRole("checkbox", { name: "选择 Mod 规格设计", exact: true }).isChecked())
    await page.setViewportSize({ width: 375, height: 850 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: join(output, "real-assembly-from-chat-mobile.png"), fullPage: true })
    await page.evaluate(() => (window as unknown as { changeEntryScope(): void }).changeEntryScope())
    await page.getByRole("heading", { name: "配置常用搭配", exact: true }).waitFor()
    assert.notEqual(await page.getByLabel("组合名称", { exact: true }).inputValue(), "保留未保存的聊天搭配")
    await page.getByRole("button", { name: "从 Mods 组装新插件", exact: true }).click()
    await page.getByRole("heading", { name: "从业务 Mods 组装新插件", exact: true }).waitFor()
    assert.equal(await page.getByRole("checkbox", { name: "选择 Mod 需求分析", exact: true }).count(), 0)
    const calls = await page.evaluate(() => (window as unknown as { assemblyCalls: unknown[][] }).assemblyCalls)
    assert(calls.some(([kind, scope]) => kind === "sources" && (scope as { threadId: string }).threadId === "b"))
    assert.deepEqual(calls.filter(([kind]) => kind === "inspect"), [
      ["inspect", { threadId: "a", expectedWorkspace: workspaceA, pluginId: "autobiz" }]
    ])
    assert(calls.some(([kind, scope]) => kind === "sources" &&
      (scope as { expectedWorkspace: string }).expectedWorkspace === workspaceB))
    await page.evaluate(() =>
      (window as unknown as { changeToMismatchedEntryScope(): void }).changeToMismatchedEntryScope())
    await page.getByRole("alert").filter({
      hasText: "项目范围已变化，已暂停组合操作。请回到对应项目后重新读取配置。"
    }).waitFor()
    assert(await page.getByRole("button", { name: "从 Mods 组装新插件", exact: true }).isDisabled())
    assert.deepEqual(await page.evaluate(() =>
      (window as unknown as { assemblyCalls: unknown[][] }).assemblyCalls), calls)
    assert.deepEqual(errors, [])
    writeFileSync(join(output, "evidence.json"), JSON.stringify({ passed: true, calls, errors }, null, 2))
    console.log("PASS real assembly navigation, source preselection, both drafts retained, chat/business boundary and scope reset")
  } catch (error) {
    writeFileSync(join(output, "failure.json"), JSON.stringify({ errors, error: String(error), body: await page.locator("body").innerText() }, null, 2))
    throw error
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
