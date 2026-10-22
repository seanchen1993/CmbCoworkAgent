import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

const root = process.cwd()
const renderer = resolve("src/renderer/src")
const receipts = JSON.stringify(
  join(renderer, "components/customize/development-reuse-receipts.ts")
)
const output = resolve("output/sparks-ux-20261011", `workbench-${Date.now()}`)
mkdirSync(output, { recursive: true })
const source = readFileSync(join(renderer, "components/sidebar/ThreadSidebar.tsx"), "utf8")
assert.match(source, /setShowCustomizeView\(true, "assistant"\)/)
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import{CustomizeView}from${JSON.stringify(join(renderer, "components/customize/CustomizeView.tsx"))};
import{rememberReuseSelection}from${receipts};window.saveReuse=(thread='one',workspace='C:/fixture')=>rememberReuseSelection(JSON.stringify([thread,workspace]),{document:{name:'聊天保存的灵件',workspace},origin:{id:'draft',revision:1,digest:'a'}});
window.calls=[];window.creatorCalls=[];let global=false,enabled=false;window.api={featureGates:{isEnabled:async()=>({enabled:false})},plugins:{list:async()=>[]},mods:{globalEnabled:async()=>{if(window.holdCreator)await new Promise(resolve=>window.finishCreator=resolve);return global},configureGlobal:async value=>{window.creatorCalls.push(['global',value]);global=value;return value},configure:async(...args)=>{window.creatorCalls.push(['configure',...args]);enabled=args[1]},status:async()=>({workspace:'C:/fixture',enabled,outputPolicy:true,mods:[],functionMods:[],diagnostics:[]}),development:{setMode:async input=>{window.creatorCalls.push(['mode',input]);return{threadId:input.threadId,workspace:window.wrongCreatorWorkspace?'C:/wrong':input.expectedWorkspace,enabled:true,mode:'creator',drafts:[],trials:[]}}},onConfigurationChanged:()=>()=>{}}};
createRoot(document.getElementById('root')).render(<CustomizeView/>);`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "workbench-fixture",
      setup(b) {
        b.onResolve({ filter: /^@\/lib\/builtin-navigation$/ }, () => ({
          path: "navigation",
          namespace: "fixture"
        }))
        b.onLoad({ filter: /^navigation$/, namespace: "fixture" }, () => ({
          loader: "js",
          contents:
            "export const openBuiltinNavigation=(target,scope)=>window.calls.push(['builtin',target,scope])"
        }))
        b.onResolve({ filter: /^@\/lib\/store$/ }, () => ({ path: "store", namespace: "fixture" }))
        b.onLoad({ filter: /^store$/, namespace: "fixture" }, () => ({
          loader: "js",
          resolveDir: root,
          contents: `import{useSyncExternalStore}from'react';const subscribers=new Set();let state={showCustomizeView:true,currentThreadId:'one',customizeInitialTab:window.initialTab||'assistant',customizeInitialSection:window.initialSection,threads:[{thread_id:'one',metadata:window.noCreatorWorkspace?{}:{workspacePath:'C:/fixture'}}],loadThreads:()=>new Promise(resolve=>window.finishLoad=()=>{state={...state,threads:[...state.threads.filter(row=>row.thread_id!=='new-reuse-thread'),{thread_id:'new-reuse-thread',title:'复用聊天',metadata:{workspacePath:'C:/other'}}]};subscribers.forEach(fn=>fn());resolve()}),selectThread:async id=>{window.calls.push(['select',id]);state={...state,currentThreadId:id,showCustomizeView:false};subscribers.forEach(fn=>fn())},setShowCustomizeView:(_show,tab)=>{window.calls.push(['navigate',tab])}};window.changeScope=()=>{state={...state,currentThreadId:'two',threads:[{thread_id:'two',title:'另一个配置目标',metadata:{workspacePath:'C:/other'}}]};subscribers.forEach(fn=>fn())};export const useAppStore=(select)=>{const value=useSyncExternalStore(fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},()=>state);return select?select(value):value};useAppStore.getState=()=>state;`
        }))
        b.onResolve({ filter: /^\.\// }, (a) => {
          if (
            a.importer.endsWith("CustomizeView.tsx") &&
            ![
              "./AssistantWorkbench",
              "./creator-mode-entry",
              "./SparksTour",
              "./ModsPanel",
              "./ConfigurationTargetPicker",
              "./settings-return-focus"
            ].includes(a.path)
          )
            return { path: a.path, namespace: "panel" }
          if (a.importer.endsWith("ModsPanel.tsx") && a.path !== "./development-reuse-receipts")
            return { path: a.path, namespace: "mods-child" }
          if (a.path === "./SparksDocumentationLink") return { path: a.path, namespace: "panel" }
        })
        b.onLoad({ filter: /.*/, namespace: "panel" }, (a) => ({
          loader: "tsx",
          resolveDir: root,
          contents: `export const ${a.path.slice(2)}=()=> <p>${a.path.slice(2)}</p>`
        }))
        b.onLoad({ filter: /.*/, namespace: "mods-child" }, (a) => ({
          loader: "tsx",
          resolveDir: root,
          contents:
            a.path === "./ModCreator"
              ? `import{useState,useEffect}from'react';import{readReuseSelection,subscribeReuseSelection}from${receipts};export function ModCreator({section,threadId,workspaceHint,onOpenReuseThread}){const[value,setValue]=useState('');const scope=JSON.stringify([threadId,workspaceHint]);const[reuse,setReuse]=useState(()=>readReuseSelection(scope));useEffect(()=>subscribeReuseSelection(scope,()=>setReuse(readReuseSelection(scope))),[scope]);return <><div hidden={section==='advanced'} inert={section==='advanced'}><span>创建试用区域</span><button onClick={()=>onOpenReuseThread("new-reuse-thread")}>打开复用聊天</button>{reuse&&<p>{reuse.document.name}</p>}</div><div hidden={section!=='advanced'} inert={section!=='advanced'}><input aria-label="未保存源码" value={value} onChange={e=>setValue(e.target.value)}/></div></>}`
              : a.path === "./ModsGuide"
                ? "export const ModsGuide=()=>null;export const ModsSetupProgress=()=>null"
                : `export const ${a.path.slice(2)}=()=>null`
        }))
      }
    }
  ]
})
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
})
let page
try {
  page = await browser.newPage({ viewport: { width: 1180, height: 850 } })
  const errors = []
  page.on("pageerror", (e) => {
    errors.push(e.message)
    console.error("page error", e.message)
  })
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="root" style="height:100vh"></div>'
    })
  )
  await page.goto("http://127.0.0.1/fixture")
  await page.evaluate(() =>
    localStorage.setItem("cmbdevclaw.customize.presentation-mode.v1", "ordinary")
  )
  const cssEntry = join(renderer, "index.css")
  const compiler = await compile(readFileSync(cssEntry, "utf8"), {
    base: dirname(cssEntry),
    from: cssEntry,
    onDependency: () => undefined
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "CustomizeView",
      "AssistantWorkbench",
      "SparksTour",
      "SparksTourExamples",
      "ModsPanel",
      "ConfigurationTargetPicker"
    ].map((name) => ({
      content: readFileSync(join(renderer, `components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const css = compiler.build(candidates)
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
  const tour = page.getByRole("region", { name: "任务示例演练", exact: true })
  assert.equal(await tour.count(), 0, "Creator landing must not be blocked by a tour")
  await page.getByRole("button", { name: "进入创造者模式", exact: true }).waitFor()
  assert.equal(
    await page.getByRole("button", { name: "高级特性", exact: true }).getAttribute("aria-expanded"),
    "false"
  )
  assert.equal(await page.getByRole("button", { name: "高级自定义", exact: true }).count(), 0)
  assert.equal(await page.getByRole("button", { name: "高级特性", exact: true }).count(), 1)
  assert.equal(await page.getByRole("button", { name: "管理常用搭配", exact: true }).count(), 0)
  await page.setViewportSize({ width: 375, height: 740 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  await page.screenshot({ path: join(output, "creator-first-375.png") })
  await page.getByRole("button", { name: "浏览灵件示例", exact: true }).click()
  assert.equal(await tour.count(), 0, "Browsing examples must leave the real page visible")
  assert.equal(
    await page.getByRole("button", { name: "任务示例演练", exact: true }).count(),
    0,
    "Browsing installed examples in ordinary mode must not expose creator guidance"
  )
  assert.deepEqual(await page.evaluate(() => window.calls), [])
  assert.equal(await tour.count(), 0)
  assert.equal(await page.evaluate(() => localStorage.getItem("devclaw.sparks-tour.v1")), null)
  await page.reload()
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.getByRole("button", { name: "返回应用", exact: true }).waitFor()
  assert.equal(await tour.count(), 0, "Completed or skipped tour must not reopen after reload")
  await page.setViewportSize({ width: 1180, height: 850 })
  assert.equal(await page.getByRole("button", { name: "进入创造者模式", exact: true }).count(), 1)
  for (const name of ["用一句话定制助手", "想让助手怎么做，直接说", "找一点灵感"])
    assert.equal(await page.getByRole("heading", { name, exact: true }).count(), 1)
  for (const name of ["高级特性"]) {
    assert.equal(
      await page.getByRole("button", { name, exact: true }).getAttribute("aria-expanded"),
      "false"
    )
  }
  assert.equal(
    await page.getByRole("button", { name: "基础功能", exact: true }).getAttribute("aria-expanded"),
    "true"
  )
  await page.getByRole("button", { name: "通用", exact: true }).click()
  await page.getByText("GeneralPanel", { exact: true }).waitFor()
  await page.getByRole("button", { name: "对话创作", exact: true }).first().click()
  await page.getByRole("button", { name: "基础功能", exact: true }).click()
  await page.screenshot({ path: join(output, "overview.png") })
  await page.setViewportSize({ width: 600, height: 900 })
  const nav = await page.locator("nav").boundingBox()
  const main = await page.getByRole("main", { name: "自定义助手总览" }).boundingBox()
  assert(nav && main && nav.y < main.y)
  assert(nav.height <= 315)
  await page.screenshot({ path: join(output, "overview-600.png") })
  await page.setViewportSize({ width: 1100, height: 900 })
  const createTab = () => page.getByRole("button", { name: "对话创作", exact: true }).last().click()
  const manual = async () => {
    const open = page.getByRole("button", { name: "高级：手动组装、源码与历史版本", exact: true })
    if (await open.count()) await open.click()
  }
  const advanced = async () => {
    await createTab()
    await manual()
    const open = page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true })
    if (await open.count()) await open.click()
  }
  const creation = async () => {
    await createTab()
    await manual()
    const back = page.getByRole("button", { name: "返回需求制作", exact: true })
    if (await back.count()) await back.click()
  }
  await page.getByRole("button", { name: "浏览灵件示例", exact: true }).click()
  assert.equal(
    await page.getByRole("button", { name: "挑选使用", exact: true }).getAttribute("aria-pressed"),
    "true"
  )
  await createTab()
  assert.equal(await page.getByRole("button", { name: "从 Mods 组装", exact: true }).count(), 0)
  await manual()
  await page.getByText("创建试用区域", { exact: true }).waitFor()
  await advanced()
  await page.getByLabel("未保存源码").fill("preserve my unsaved source")
  assert.equal(await page.getByRole("button", { name: "任务示例演练", exact: true }).count(), 0)
  await page.getByRole("button", { name: "挑选使用", exact: true }).click()
  assert.equal(await page.getByLabel("未保存源码").isVisible(), false)
  await advanced()
  assert.equal(
    await page.getByLabel("未保存源码").inputValue(),
    "preserve my unsaved source",
    "Installed-example subpage navigation must retain the authoring draft"
  )
  await page.getByRole("button", { name: "我已添加", exact: true }).click()
  assert.equal(await page.getByLabel("未保存源码").isVisible(), false)
  assert.equal(await page.getByLabel("未保存源码").evaluate((el) => !!el.closest("[inert]")), true)
  await page.getByRole("button", { name: "对话创作", exact: true }).first().click()
  await page.getByRole("button", { name: "浏览灵件示例", exact: true }).click()
  await advanced()
  assert.equal(await page.getByLabel("未保存源码").inputValue(), "preserve my unsaved source")
  for (const section of ["advanced", "installed"]) {
    if (section === "advanced") await advanced()
    else await page.getByRole("button", { name: "我已添加", exact: true }).click()
    await page.getByRole("button", { name: "对话创作", exact: true }).first().click()
    await page.evaluate(() => window.saveReuse())
    await page
      .getByRole("navigation")
      .filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) })
      .getByRole("button", { name: "灵件与使用设置", exact: true })
      .click()
    await page.getByText("聊天保存的灵件", { exact: true }).waitFor()
    assert.equal(
      await page
        .getByRole("button", { name: "对话创作", exact: true })
        .last()
        .getAttribute("aria-pressed"),
      "true"
    )
    await advanced()
    assert.equal(await page.getByLabel("未保存源码").inputValue(), "preserve my unsaved source")
  }
  await page.evaluate(() => window.saveReuse("other-thread", "C:/other"))
  assert.equal(
    await page
      .getByRole("button", { name: "返回需求制作", exact: true })
      .getAttribute("aria-expanded"),
    "true"
  )
  await creation()
  await page.getByRole("button", { name: "打开复用聊天", exact: true }).click()
  await page.waitForFunction(() => typeof window.finishLoad === "function")
  await page.evaluate(() => window.changeScope())
  await page.evaluate(() => window.finishLoad())
  await page.getByRole("combobox", { name: "配置目标聊天", exact: true }).click()
  await page.getByRole("option", { name: /另一个配置目标.*C:\/other/ }).click()
  await advanced()
  assert.equal(await page.getByLabel("未保存源码").inputValue(), "")
  assert.deepEqual(await page.evaluate(() => window.calls), [])
  await creation()
  await page.getByRole("button", { name: "打开复用聊天", exact: true }).click()
  await page.evaluate(() => window.finishLoad())
  await page.waitForFunction(() => window.calls.length === 1)
  assert.deepEqual(await page.evaluate(() => window.calls), [["select", "new-reuse-thread"]])
  assert.deepEqual(errors, [])
  for (const [tab, label, panel] of [
    ["lsp", "Java 代码诊断", "LspPanel"],
    ["claw", "搭配管理", "ClawPanel"],
    ["flows", "聊天任务模板", "FlowsPanel"]
  ]) {
    const linkedPage = await browser.newPage()
    await linkedPage.route("http://127.0.0.1/fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root" style="height:100vh"></div>'
      })
    )
    await linkedPage.goto("http://127.0.0.1/fixture")
    await linkedPage.evaluate((tab) => {
      window.initialTab = tab
    }, tab)
    await linkedPage.addScriptTag({ content: bundle.outputFiles[0].text })
    await linkedPage.getByRole("button", { name: label, exact: true }).waitFor()
    await linkedPage.getByText(panel, { exact: true }).waitFor()
    assert.equal(
      await linkedPage
        .getByRole("button", { name: label, exact: true })
        .getAttribute("aria-current"),
      "page"
    )
    assert.equal(
      await linkedPage.getByRole("button", { name: "高级自定义", exact: true }).count(),
      0
    )
    assert.equal(
      await linkedPage
        .getByRole("button", { name: "高级特性", exact: true })
        .getAttribute("aria-expanded"),
      "true"
    )
    await linkedPage.close()
  }
  const createPage = await browser.newPage()
  await createPage.route("http://127.0.0.1/fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: '<div id="root" style="height:100vh"></div>' })
  )
  await createPage.goto("http://127.0.0.1/fixture")
  await createPage.evaluate(() => {
    window.initialTab = "mods"
    window.initialSection = "create"
  })
  await createPage.addScriptTag({ content: bundle.outputFiles[0].text })
  await createPage.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) =>
        button.textContent === "对话创作" && button.getAttribute("aria-pressed") === "true"
    )
  )
  assert.equal(
    await createPage.getByRole("region", { name: "任务示例演练", exact: true }).count(),
    0
  )
  await createPage.getByRole("button", { name: "挑选使用", exact: true }).click()
  await createPage.evaluate(() => window.changeScope())
  assert.equal(
    await createPage
      .getByRole("button", { name: "挑选使用", exact: true })
      .getAttribute("aria-pressed"),
    "true",
    "Consumed create intent must not replay into a different scope"
  )
  await createPage.close()
  for (const scenario of ["enter", "scope-changed", "wrong-result", "no-workspace"]) {
    const creatorPage = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    const creatorErrors = []
    creatorPage.on("pageerror", (error) => creatorErrors.push(error.message))
    await creatorPage.route("http://127.0.0.1/fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root" style="height:100vh"></div>'
      })
    )
    await creatorPage.goto("http://127.0.0.1/fixture")
    await creatorPage.evaluate((scenario) => {
      window.holdCreator = scenario === "scope-changed"
      window.wrongCreatorWorkspace = scenario === "wrong-result"
      window.noCreatorWorkspace = scenario === "no-workspace"
    }, scenario)
    await creatorPage.addStyleTag({ content: css })
    await creatorPage.addScriptTag({ content: bundle.outputFiles[0].text })
    const entry = creatorPage.getByRole("button", { name: "进入创造者模式", exact: true })
    await entry.waitFor()
    assert.equal(await creatorPage.getByRole("region", { name: "任务示例演练" }).count(), 0)
    if (scenario === "no-workspace") {
      assert.equal(await entry.isDisabled(), true)
      await creatorPage
        .getByText("请先在上方选择一段具有本地项目目录的聊天。", { exact: true })
        .waitFor()
      assert.deepEqual(await creatorPage.evaluate(() => window.creatorCalls), [])
    } else {
      await entry.click()
      if (scenario === "scope-changed") {
        await creatorPage.waitForFunction(() => typeof window.finishCreator === "function")
        await creatorPage.evaluate(() => {
          window.changeScope()
          window.finishCreator()
        })
      }
      if (scenario === "enter") {
        await creatorPage.waitForFunction(() => window.calls.length === 1)
        assert.deepEqual(await creatorPage.evaluate(() => window.creatorCalls), [
          ["global", true],
          ["configure", "one", true, true, "C:/fixture"],
          ["mode", { threadId: "one", expectedWorkspace: "C:/fixture", mode: "creator" }]
        ])
        assert.deepEqual(await creatorPage.evaluate(() => window.calls), [["navigate", undefined]])
        await creatorPage.screenshot({ path: join(output, "creator-entered.png") })
      } else {
        await creatorPage.getByRole("alert").filter({ hasText: "聊天或项目已变化" }).waitFor()
        assert.deepEqual(await creatorPage.evaluate(() => window.calls), [])
        if (scenario === "scope-changed")
          assert.deepEqual(await creatorPage.evaluate(() => window.creatorCalls), [])
      }
    }
    assert.deepEqual(creatorErrors, [])
    await creatorPage.close()
  }
  const focusBundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
import{useState}from'react';import{createRoot}from'react-dom/client';
import{SettingsOverlay}from${JSON.stringify(join(renderer, "components/customize/SettingsOverlay.tsx"))};
import{useSettingsComposerReturn}from${JSON.stringify(join(renderer, "components/customize/settings-return-focus.ts"))};
function Actions({close}){const request=useSettingsComposerReturn();return <><button onClick={close}>一般关闭</button><button onClick={()=>{request();close()}}>返回聊天输入</button></>}
function App(){const[open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>打开设置</button><textarea className="composer-textarea" aria-label="原聊天草稿" defaultValue="保留输入"/>{open&&<SettingsOverlay onClose={()=>setOpen(false)}><Actions close={()=>setOpen(false)}/></SettingsOverlay>}</>}
createRoot(document.getElementById('root')).render(<App/>);`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const focusPage = await browser.newPage()
  await focusPage.setContent('<div id="root"></div>')
  await focusPage.addScriptTag({ content: focusBundle.outputFiles[0].text })
  for (const action of ["一般关闭", "返回聊天输入", "Escape", "一般关闭"]) {
    await focusPage.getByRole("button", { name: "打开设置", exact: true }).click()
    if (action === "Escape") await focusPage.keyboard.press("Escape")
    else await focusPage.getByRole("button", { name: action, exact: true }).click()
    await focusPage.getByRole("dialog").waitFor({ state: "detached" })
    const target = action === "返回聊天输入" ? "textarea.composer-textarea" : "button"
    await focusPage.waitForFunction((selector) => document.activeElement?.matches(selector), target)
    assert.equal(await focusPage.getByLabel("原聊天草稿").inputValue(), "保留输入")
  }
  await focusPage.close()
  console.log(
    "PASS conversation-first creator entry, setup/mode scope guards, no-workspace fallback, optional tours, mobile layout, advanced drafts, reuse and deep links"
  )
} catch (error) {
  writeFileSync(join(output, `failure-${Date.now()}.txt`), String(error.stack ?? error))
  await page?.screenshot({ path: join(output, `failure-${Date.now()}.png`), fullPage: true })
  throw error
} finally {
  await browser.close()
}
