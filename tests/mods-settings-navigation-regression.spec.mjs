import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { resolve, join } from "node:path"
import { existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
const root = process.cwd(),
  output = resolve("output/mods-settings-navigation", String(Date.now())),
  renderer = resolve("src/renderer/src")
mkdirSync(output, { recursive: true })
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{CustomizeView}from${JSON.stringify(join(renderer, "components/customize/CustomizeView.tsx"))};
import {useAppStore} from '@/lib/store';
let workspace='C:/isolated/A',listeners=[],installed=[];const calls=[];window.projectMounts=[];
const view=()=>({workspace,revision:workspace.endsWith('A')?1:2,bindingRevision:0,profiles:[],active:{id:'claw-a',name:workspace.endsWith('A')?'A private draft':'B private draft',capabilities:[]},enabled:true,applicable:true,issues:[],capabilities:[]});
window.api={plugins:{list:async()=>[]},mods:{communityExamples:{list:async()=>({examples:[]})},authoring:{list:async()=>({workspace,drafts:[]})},globalEnabled:async()=>false,status:async()=>({workspace,mods:[],functionMods:[],diagnostics:[]}),clawView:async()=>{window.clawReads=(window.clawReads??0)+1;return view()},clawChange:async(t,m)=>{calls.push(['clawChange',m]);return view()},flowCatalog:async()=>({available:true,hostAvailable:true,workspace,plugins:[],actions:[],agents:[],models:[],features:[]}),flowList:async()=>[{revision:1,digest:'f'.repeat(64),definition:{id:'fixture',name:'B fixture',schemaVersion:2,maxExecutions:1,execution:{profile:'prompt-only-v1'},steps:[{id:'agent',name:'Agent',kind:'agent',enabled:true}]}}],clawSources:async()=>({skills:[],mcp:[]}),onConfigurationChanged:cb=>{listeners.push(cb);return()=>{}},evaluation:{list:async()=>({ok:true,value:{workspace,evaluations:[]}})},skillEvaluation:{list:async()=>({ok:true,value:{workspace,candidates:[{candidateId:'candidate-b',name:'B candidate',skillId:'skill-b'}],records:[]}}),prepare:async input=>{calls.push(['skillPrepare',input]);return{ok:false,code:'INVALID'}}}}};
window.api.featureGates={isEnabled:async()=>({enabled:false,reason:'fixture-disabled'})};
window.api.plugins.list=async()=>installed;
window.fixture={calls,change:()=>{workspace='C:/isolated/B';listeners.forEach(fn=>fn())},readB:()=>{workspace='C:/isolated/B'}};
window.fixture.projectPlugins=()=>{installed=['project-a','project-b'].map(id=>({id,name:id,version:'1.0.0',enabled:true,hasProjectMode:true,skillCount:1,mcpServerCount:0}));listeners.forEach(fn=>fn())};
window.fixture.replaceSource=()=>{installed=installed.map(row=>({...row,path:'C:/replacement/'+row.id,updatedAt:'2026-10-21T10:00:00Z'}));listeners.forEach(fn=>fn())};
window.fixture.account=()=>{useAppStore.getState().accountRevision++;useAppStore.getState().setShowCustomizeView(true,'mods')};
createRoot(document.getElementById('root')).render(<CustomizeView/>);`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  loader: { ".md": "text", ".png": "dataurl" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": "{}",
    "import.meta.hot": "undefined"
  },
  plugins: [
    {
      name: "fixture",
      setup(b) {
        // The child has independent native/browser coverage; this verifies only parent selection/laziness/scope.
        b.onResolve({ filter: /^\.\/NativeNodeComposer$/ }, (a) =>
          a.importer.endsWith("ModsPanel.tsx")
            ? { path: "native-selection", namespace: "selection-probe" }
            : undefined
        )
        b.onLoad({ filter: /.*/, namespace: "selection-probe" }, () => ({
          loader: "tsx",
          resolveDir: root,
          contents: `import React,{useEffect}from'react';export function NativeNodeComposer({threadId,workspace,pluginId}){useEffect(()=>{window.projectMounts.push(['mount',threadId,workspace,pluginId]);return()=>window.projectMounts.push(['unmount',threadId,workspace,pluginId])},[threadId,workspace,pluginId]);return <section aria-label="selected-native-project">{pluginId} {workspace}</section>}`
        }))
        // Full chat rendering is unrelated to Settings retention; the real panel remains under test.
        b.onResolve({ filter: /(?:ChatContainer|TabbedPanel)$/ }, () => ({
          path: "ChatContainer",
          namespace: "chat-empty"
        }))
        b.onLoad({ filter: /.*/, namespace: "chat-empty" }, () => ({
          contents: "export const ChatContainer=()=>null;export const TabbedPanel=()=>null"
        }))
        b.onResolve({ filter: /^(?:@\/lib\/store|\.\.\/\.\.\/lib\/store)$/ }, () => ({
          path: "store",
          namespace: "fixture"
        }))
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          resolveDir: root,
          loader: "js",
          contents: `import{useSyncExternalStore}from'react';let state={accountRevision:0,currentThreadId:'t',showCustomizeView:true,customizeInitialTab:location.hash.slice(1),threads:[{thread_id:'t',title:'Workspace A',metadata:{workspacePath:'C:/isolated/A'}},{thread_id:'b',title:'Workspace B',metadata:{workspacePath:'C:/isolated/B'}}],setShowCustomizeView:(_open,tab)=>{const previous=state;state={...state,customizeInitialTab:tab};subscribers.forEach(fn=>fn(state,previous))}};window.moveWorkspace=workspace=>{const previous=state;state={...state,threads:[{thread_id:'t',metadata:{workspacePath:workspace}}]};subscribers.forEach(fn=>fn(state,previous))};const subscribers=new Set();export const useAppStore=(select)=>{const value=useSyncExternalStore(fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},()=>state);return select?select(value):value};useAppStore.getState=()=>state;useAppStore.subscribe=fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)};export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
        }))
        b.onResolve({ filter: /\?worker$/ }, () => ({ path: "worker", namespace: "worker" }))
        b.onLoad({ filter: /.*/, namespace: "worker" }, () => ({
          contents: "export default class Worker {}"
        }))
        b.onResolve({ filter: /^\.\// }, (a) => {
          if (
            a.importer.endsWith("CustomizeView.tsx") &&
            /^\.\/[A-Z]/.test(a.path) &&
            ![
              "./ClawPanel",
              "./ModsPanel",
              "./EvaluationPanel",
              "./SparksTour",
              "./ConfigurationTargetPicker",
              "./SettingsOverlay"
            ].includes(a.path)
          )
            return { path: a.path, namespace: "empty" }
        })
        b.onLoad({ filter: /.*/, namespace: "empty" }, (a) => ({
          loader: "js",
          contents: `export const ${a.path.slice(2)}=()=>null`
        }))
      }
    }
  ]
})
const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  }),
  result = {}

async function open(tab = "claw") {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } }),
    errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.route("**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root" style="height:100vh"></div>' })
  )
  await page.goto("http://127.0.0.1/probe#" + tab)
  const assets = resolve("out/renderer/assets")
  const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
  assert(css, "Build current production CSS before navigation checks")
  await page.addStyleTag({ path: join(assets, css) })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await dismissTour(page)
  return { page, errors }
}
async function dismissTour(page) {
  const tour = page.getByRole("region", { name: "任务示例演练", exact: true })
  if (await tour.isVisible())
    await tour.getByRole("button", { name: "关闭示例演练", exact: true }).click()
}
async function navigate(page, name) {
  const group = page.getByRole("button", {
    name: name === "插件" ? "基础功能" : "高级特性",
    exact: true
  })
  if (
    ["搭配管理", "聊天任务模板", "插件"].includes(name) &&
    (await group.getAttribute("aria-expanded")) === "false"
  )
    await group.click()
  await page
    .locator("nav")
    .filter({ has: page.getByRole("button", { name: "高级特性", exact: true }) })
    .getByRole("button", { name, exact: true })
    .click()
  await dismissTour(page)
}
async function editor(page) {
  const summary = page.getByText("高级编辑与已保存组合", { exact: true })
  await summary.waitFor()
  if (!(await summary.evaluate((el) => el.parentElement.open))) await summary.click()
  return page.getByLabel("助手组合名称", { exact: true })
}
async function chooseB(page) {
  page.once("dialog", (dialog) => dialog.accept())
  await page.evaluate(() => window.fixture.change())
  await page.getByRole("combobox", { name: "配置目标聊天", exact: true }).click()
  await page.getByRole("combobox", { name: "搜索配置聊天", exact: true }).fill("Workspace B")
  await page.getByRole("option", { name: "Workspace B · C:/isolated/B", exact: true }).click()
}
async function assertInert(page, locator) {
  assert.equal(await locator.isVisible(), false)
  assert.equal(await locator.evaluate((el) => !!el.closest("[inert]")), true)
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab")
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("[inert]")), false)
  }
}
try {
  {
    const { page, errors } = await open("mods")
    const entry = page
      .locator("nav")
      .filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) })
      .getByRole("button", { name: "插件", exact: true })
    assert.equal(await entry.count(), 1, "Plugin management has one main menu entry")
    await page.getByRole("button", { name: "导入与发布", exact: true }).click()
    await page.getByRole("heading", { name: "导入与发布", exact: true }).waitFor()
    assert.equal(
      await entry.getAttribute("aria-current"),
      "page",
      "The plugin entry remains active on its source management subpage"
    )
    await page.getByRole("button", { name: "返回插件", exact: true }).click()
    await page.getByRole("heading", { name: "插件", exact: true }).waitFor()
    assert.equal(await entry.getAttribute("aria-current"), "page")
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    assert.deepEqual(errors, [])
    result.unifiedPluginEntry = { singleEntry: true, sourceSubpageHighlighted: true }
    await page.close()
  }
  {
    const { page, errors } = await open("mods")
    await page
      .getByRole("navigation", { name: "灵件工作区", exact: true })
      .getByRole("button", { name: "我已添加", exact: true })
      .waitFor()
    assert.equal(
      await page.getByRole("region", { name: "selected-native-project", exact: true }).count(),
      0
    )
    assert.deepEqual(await page.evaluate(() => window.projectMounts), [])
    await page.evaluate(() => window.fixture.projectPlugins())
    const first = page.getByRole("article", { name: "project-a", exact: true })
    await first.getByRole("button", { name: "管理", exact: true }).click()
    await first.getByRole("button", { name: "查看项目流程", exact: true }).click()
    await first.getByRole("region", { name: "selected-native-project", exact: true }).waitFor()
    const second = page.getByRole("article", { name: "project-b", exact: true })
    await second.getByRole("button", { name: "管理", exact: true }).click()
    await second.getByRole("button", { name: "查看项目流程", exact: true }).click()
    await second.getByRole("region", { name: "selected-native-project", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("region", { name: "selected-native-project", exact: true }).count(),
      1
    )
    assert.deepEqual(await page.evaluate(() => window.projectMounts), [
      ["mount", "t", "C:/isolated/A", "project-a"],
      ["unmount", "t", "C:/isolated/A", "project-a"],
      ["mount", "t", "C:/isolated/A", "project-b"]
    ])
    await page.evaluate(() => window.fixture.replaceSource())
    await page.waitForFunction(() => window.projectMounts.length === 5)
    assert.equal(await page.getByRole("region", { name: "selected-native-project", exact: true }).count(), 1)
    await page.evaluate(() => window.fixture.account())
    await page
      .getByRole("region", { name: "selected-native-project", exact: true })
      .waitFor({ state: "detached" })
    await page
      .getByRole("article", { name: "project-b", exact: true })
      .getByRole("button", { name: "管理", exact: true })
      .click()
    await page
      .getByRole("article", { name: "project-b", exact: true })
      .getByRole("button", { name: "查看项目流程", exact: true })
      .click()
    await page.getByRole("region", { name: "selected-native-project", exact: true }).waitFor()
    await chooseB(page)
    await page
      .getByRole("region", { name: "selected-native-project", exact: true })
      .waitFor({ state: "detached" })
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    result.projectEntry = {
      singleLazySelection: true,
      accountAndWorkspaceReset: true,
      noProjectCreated: true
    }
    await page.close()
  }
  for (const mode of ["internal-flow-button", "sidebar-tab", "overview"]) {
    const { page, errors } = await open()
    const name = await editor(page)
    await name.waitFor()
    await name.fill("Unsaved reviewer configuration")
    if (mode === "internal-flow-button") {
      const control = page.getByRole("button", { name: "管理聊天任务模板", exact: true })
      await control.scrollIntoViewIfNeeded()
      const box = await control.boundingBox()
      assert(box.y >= 0 && box.y + box.height <= 650)
      await control.click()
    } else if (mode === "overview") await navigate(page, "对话创作")
    else await navigate(page, "聊天任务模板")
    await assertInert(page, name)
    await navigate(page, "搭配管理")
    await name.waitFor()
    assert.equal(await name.inputValue(), "Unsaved reviewer configuration")
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    result[mode] = { name: await name.inputValue(), errors }
    await page.screenshot({ path: join(output, mode + "-preserved.png") })
    await page.close()
  }
  {
    const { page, errors } = await open("general")
    await page.getByRole("button", { name: "高级特性", exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.clawReads ?? 0), 0)
    assert.equal(await page.getByLabel("助手组合名称", { exact: true }).count(), 0)
    await navigate(page, "搭配管理")
    const name = await editor(page)
    await name.waitFor()
    await name.fill("A draft must not enter B")
    await navigate(page, "聊天任务模板")
    await chooseB(page)
    await name.waitFor({ state: "detached" })
    await navigate(page, "搭配管理")
    await editor(page)
    await name.waitFor()
    assert.equal(await name.inputValue(), "B private draft")
    assert.deepEqual(errors, [])
    result.scope = { errors, name: await name.inputValue() }
    await page.close()
  }
  {
    const { page, errors } = await open("claw")
    await editor(page)
    assert((await page.evaluate(() => window.clawReads ?? 0)) > 0)
    assert.equal(await page.getByRole("button", { name: "创造者模式", exact: true }).count(), 1)
    await page.close()
    result.initialOrdinary = { errors }
  }
  {
    const { page, errors } = await open("mods")
    await page.waitForTimeout(100)
    assert.deepEqual(errors, [])
    await page
      .getByRole("navigation", { name: "灵件工作区", exact: true })
      .getByRole("button", { name: "对话创作", exact: true })
      .click()
    await page.getByRole("button", { name: "高级：手动组装、源码与历史版本", exact: true }).click()
    if (await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).count())
      await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).click()
    await page.getByRole("button", { name: "打开草稿库", exact: true }).click()
    await page.getByRole("button", { name: "新建草稿", exact: true }).click()
    const name = page.getByLabel("草稿名称")
    await name.fill("Unsaved authoring title")
    await navigate(page, "聊天任务模板")
    await assertInert(page, name)
    await navigate(page, "插件")
    assert.equal(await name.inputValue(), "Unsaved authoring title")
    await navigate(page, "对话创作")
    await assertInert(page, name)
    await navigate(page, "插件")
    assert.equal(await name.inputValue(), "Unsaved authoring title")
    await navigate(page, "聊天任务模板")
    await chooseB(page)
    await navigate(page, "插件")
    await page
      .getByRole("navigation", { name: "灵件工作区", exact: true })
      .getByRole("button", { name: "对话创作", exact: true })
      .click()
    await page.getByRole("button", { name: "高级：手动组装、源码与历史版本", exact: true }).click()
    if (await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).count())
      await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).click()
    await page.getByRole("button", { name: "打开草稿库", exact: true }).waitFor()
    assert.equal(await name.count(), 0)
    assert.deepEqual(errors, [])
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    result.modCreator = { errors, preserved: true, scopeReset: true }
    await page.close()
  }
  writeFileSync(join(output, "navigation-regression-result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
