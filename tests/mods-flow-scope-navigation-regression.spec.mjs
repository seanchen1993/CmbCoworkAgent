import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { resolve, join } from "node:path"
import { existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
const root = process.cwd(),
  output = resolve("output/sparks-remediation-20261010/product/navigation"),
  renderer = resolve("src/renderer/src")
mkdirSync(output, { recursive: true })
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{CustomizeView}from${JSON.stringify(join(renderer, "components/customize/CustomizeView.tsx"))};
window.electron={process:{platform:'win32'}};let workspace=window.startForeign?'C:/isolated/B':'C:/isolated/A',listeners=[],race=false;const calls=[];
const view=()=>({workspace,revision:workspace.endsWith('A')?1:2,bindingRevision:0,profiles:[],active:{id:'claw-a',name:workspace.endsWith('A')?'A private draft':'B private draft',capabilities:[]},enabled:true,applicable:true,issues:[],capabilities:[]});
window.api={plugins:{list:async()=>[]},mods:{authoring:{list:async()=>({workspace,drafts:[]})},globalEnabled:async()=>false,status:async()=>({workspace,mods:[],functionMods:[],diagnostics:[]}),clawView:async()=>{window.clawReads=(window.clawReads??0)+1;return view()},clawChange:async(t,m)=>{calls.push(['clawChange',m]);return view()},flowCatalog:async()=>{const value={available:true,hostAvailable:true,workspace,plugins:[],actions:[],agents:[],models:[],features:[]};if(race){race=false;workspace='C:/isolated/B'}return value},flowSave:async(...args)=>{calls.push(['flowSave',args,workspace]);if(args[3]!==workspace)throw Error('FLOW_SCOPE_CHANGED');return{definition:args[1],revision:1,digest:'a'.repeat(64)}},flowStart:async(...args)=>{calls.push(['flowStart',args,workspace]);if(args[4]!==workspace)throw Error('FLOW_SCOPE_CHANGED');throw Error('test never starts a real flow')},flowActive:async()=>null,flowRuns:async()=>[],flowList:async()=>[{revision:1,digest:'f'.repeat(64),definition:{id:'fixture',name:'B fixture',schemaVersion:2,maxExecutions:1,execution:{profile:'prompt-only-v1'},steps:[{id:'agent',name:'Agent',kind:'agent',enabled:true}]}}],clawSources:async()=>({skills:[],mcp:[]}),onConfigurationChanged:cb=>{listeners.push(cb);return()=>{}},evaluation:{list:async()=>({ok:true,value:{workspace,evaluations:[]}})},skillEvaluation:{list:async()=>({ok:true,value:{workspace,candidates:[{candidateId:'candidate-b',name:'B candidate',skillId:'skill-b'}],records:[]}}),prepare:async input=>{calls.push(['skillPrepare',input]);return{ok:false,code:'INVALID'}}}}};
window.fixture={calls,race:()=>race=true,restore:()=>{workspace='C:/isolated/A';listeners.forEach(fn=>fn())},change:()=>{workspace='C:/isolated/B';listeners.forEach(fn=>fn())},readB:()=>{workspace='C:/isolated/B'}};
createRoot(document.getElementById('root')).render(<CustomizeView/>);`
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  alias: { "@": renderer },
  loader: { ".md": "text", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [
    {
      name: "fixture",
      setup(b) {
        // Full chat rendering is unrelated to Settings retention; the real panel remains under test.
        b.onResolve({filter:/(?:ChatContainer|TabbedPanel)$/},()=>({path:"ChatContainer",namespace:"chat-empty"}))
        b.onLoad({filter:/.*/,namespace:"chat-empty"},()=>({contents:"export const ChatContainer=()=>null;export const TabbedPanel=()=>null"}))
        b.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
          path: "thread-context",
          namespace: "thread-fixture"
        }))
        b.onLoad({ filter: /.*/, namespace: "thread-fixture" }, () => ({
          contents: "export const useThreadStateSelector=(_id,select)=>select({})",
          loader: "js"
        }))
        b.onResolve({ filter: /^@\/lib\/chat-flow-choice$/ }, () => ({
          path: "chat-flow-choice",
          namespace: "flow-fixture"
        }))
        b.onLoad({ filter: /.*/, namespace: "flow-fixture" }, () => ({
          contents: "export const selectChatFlow=()=>{}",
          loader: "js"
        }))
        b.onResolve({ filter: /^(?:@\/lib\/store|\.\.\/\.\.\/lib\/store)$/ }, () => ({
          path: "store",
          namespace: "fixture"
        }))
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          resolveDir: root,
          loader: "js",
          contents: `import{useSyncExternalStore}from'react';let state={accountRevision:0,currentThreadId:'t',showCustomizeView:true,customizeInitialTab:location.hash.slice(1),threads:[{thread_id:'t',metadata:{workspacePath:window.nativeHint||'C:/isolated/A'}}],setShowCustomizeView:(_open,tab)=>{const previous=state;state={...state,customizeInitialTab:tab};subscribers.forEach(fn=>fn(state,previous))}};window.moveWorkspace=workspace=>{const previous=state;state={...state,threads:[{thread_id:'t',metadata:{workspacePath:workspace}}]};subscribers.forEach(fn=>fn(state,previous))};const subscribers=new Set();export const useAppStore=(select)=>{const value=useSyncExternalStore(fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},()=>state);return select?select(value):value};useAppStore.getState=()=>state;useAppStore.subscribe=fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)};export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
        }))
        b.onResolve({ filter: /^\.\// }, (a) => {
          if (
            a.importer.endsWith("CustomizeView.tsx") &&
            /^\.\/[A-Z]/.test(a.path) &&
            ![
              "./ClawPanel",
              "./ModsPanel",
              "./FlowsPanel",
              "./EvaluationPanel",
              "./ConfigurationTargetPicker",
              "./customize-mode"
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

async function open(tab = "claw", presentation = "creator", foreign = false, native = false) {
  const page = await browser.newPage({ viewport: { width: 900, height: 650 } }),
    errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  await page.route("**/*", (r) =>
    r.fulfill({ contentType: "text/html", body: '<div id="root" style="height:100vh"></div>' })
  )
  await page.goto("http://127.0.0.1/probe#" + tab)
  await page.evaluate(
    (mode) => localStorage.setItem("cmbdevclaw.customize.presentation-mode.v1", mode),
    presentation
  )
  const assets=resolve("out/renderer/assets");
  const css=readdirSync(assets).find(name=>/^index-.*\.css$/.test(name));
  assert(css,"Build production CSS before visual navigation checks");
  await page.addStyleTag({path:join(assets,css)})
  await page.evaluate((value) => (window.startForeign = value), foreign)
  if (native)
    await page.evaluate(
      () => (window.nativeHint = ["c:", "isolated", "a", ""].join(String.fromCharCode(92)))
    )
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const advancedNav=page.getByRole("button", {name:"高级自定义",exact:true});
  if(await advancedNav.getAttribute("aria-expanded")==="false") await advancedNav.click()
  return { page, errors }
}
async function assertInert(page, locator) {
  assert.equal(await locator.isVisible(), false)
  assert.equal(await locator.evaluate((el) => !!el.closest("[inert]")), true)
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab")
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest("[inert]")), false)
  }
}

async function draft(page) {
  const advanced=page.getByText("高级：编辑模板与执行记录",{exact:true});
  if(!await advanced.locator("..").evaluate(el=>el.open)) await advanced.click()
  await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
  const name = page.getByLabel("流程名称")
  await name.fill("Unsaved flow sidebar draft")
  return name
}
try {
  for (const path of ["sidebar", "internal"]) {
    const { page, errors } = await open("flows"),
      dialogs = []
    page.on("dialog", (d) => {
      dialogs.push(d.message())
      void d.accept()
    })
    const name = await draft(page)
    if (path === "internal")
      await page.getByRole("button", { name: "添加 / 授权灵件", exact: true }).click()
    else if (path === "ordinary")
      await page.getByRole("button", { name: "普通模式", exact: true }).click()
    else await page.getByRole("navigation").filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) }).getByRole("button", { name: "灵件与使用设置", exact: true }).click()
    await assertInert(page, name)
    if (path === "ordinary")
      await page.getByRole("button", { name: "创作者模式", exact: true }).click()
    await page.getByRole("button", { name: "聊天任务模板", exact: true }).click()
    assert.equal(await name.inputValue(), "Unsaved flow sidebar draft")
    assert.deepEqual(dialogs, [])
    assert.deepEqual(errors, [])
    result[path] = { name: await name.inputValue(), errors }
    await page.close()
  }
  // The editor no longer starts tasks; native send/selection races live in mods-flow-browser.
  for (const operation of ["save"]) {
    const { page, errors } = await open("flows")
    const name = await draft(page)
    if (operation === "start") {
      await page.getByRole("button", { name: "保存流程", exact: true }).click()
      await page.getByText("已保存修订 1，可开始运行。", { exact: true }).waitFor()
    }
    await page.evaluate(() => window.fixture.race())
    await page
      .getByRole("button", {
        name: operation === "save" ? "保存流程" : "运行已保存版本",
        exact: true
      })
      .click()
    await page.getByText("FLOW_SCOPE_CHANGED", { exact: true }).waitFor()
    const calls = await page.evaluate(() => window.fixture.calls),
      last = calls.at(-1)
    assert.equal(last[0], operation === "save" ? "flowSave" : "flowStart")
    assert.equal(last[1][operation === "save" ? 3 : 4], "C:/isolated/A")
    assert.equal(last[2], "C:/isolated/B")
    assert.equal(await name.inputValue(), "Unsaved flow sidebar draft")
    assert.deepEqual(errors, [])
    result[operation] = { calls, errors }
    await page.close()
  }
  {
    const { page, errors } = await open("flows")
    const name = await draft(page)
    await page.evaluate(() => window.fixture.change())
    await page.getByRole("alert").filter({ hasText: "项目范围已变化" }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "保存流程", exact: true }).isDisabled(),
      true
    )
    assert.equal(await name.inputValue(), "Unsaved flow sidebar draft")
    await page.evaluate(() => window.fixture.restore())
    await page.getByRole("button", { name: "保存流程", exact: true }).waitFor()
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    await page.getByText("已保存修订 1，可开始运行。", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    result.refresh = { calls: await page.evaluate(() => window.fixture.calls), errors }
    await page.close()
  }
  {
    const { page, errors } = await open("flows", "creator", true)
    await page.getByRole("alert").filter({ hasText: "项目范围已变化" }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "新建代码检视流程", exact: true }).count(),
      0
    )
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [])
    assert.deepEqual(errors, [])
    result.firstForeign = { errors }
    await page.close()
  }
  {
    const { page, errors } = await open("flows")
    await draft(page)
    await page.getByRole("navigation").filter({ has: page.getByRole("button", { name: "基础功能", exact: true }) }).getByRole("button", { name: "灵件与使用设置", exact: true }).click()
    await page.evaluate(() => {
      window.fixture.change()
      window.moveWorkspace("C:/isolated/B")
    })
    await page.getByRole("button", { name: "聊天任务模板", exact: true }).click()
    // A directory mutation invalidates the captured configuration target; explicitly reselect B.
    assert(await page.locator("[data-diy-flows]").evaluate(el=>!!el.closest("[inert]")))
    page.once("dialog",dialog=>dialog.accept())
    await page.getByRole("combobox", {name:"配置目标聊天",exact:true}).click()
    await page.getByRole("option", {name:"未命名聊天 · C:/isolated/B",exact:true}).click()
    await page.getByText("高级：编辑模板与执行记录", { exact: true }).click()
    await page.getByRole("button", { name: "新建代码检视流程", exact: true }).waitFor()
    assert.equal(await page.getByLabel("流程名称").count(), 0)
    assert.deepEqual(errors, [])
    result.workspaceReset = { errors }
    await page.close()
  }
  {
    const { page, errors } = await open("flows", "creator", false, true)
    await draft(page)
    await page.getByRole("button", { name: "保存流程", exact: true }).click()
    await page.getByText("已保存修订 1，可开始运行。", { exact: true }).waitFor()
    const calls = await page.evaluate(() => window.fixture.calls)
    assert.equal(calls[0][1][3], "C:/isolated/A")
    assert.deepEqual(errors, [])
    result.canonicalHint = { calls, errors }
    await page.close()
  }
  writeFileSync(join(output, "flow-scope-navigation-result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close()
}
