import assert from "node:assert/strict"
import { build } from "esbuild"
import { chromium } from "playwright"
import { resolve, join } from "node:path"
import { existsSync, writeFileSync, mkdirSync } from "node:fs"
const root = process.cwd(),
  output = resolve("output/sparks-ux-redesign-20261010/navigation-test"),
  renderer = resolve("src/renderer/src")
mkdirSync(output, { recursive: true })
const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';import{CustomizeView}from${JSON.stringify(join(renderer, "components/customize/CustomizeView.tsx"))};
let workspace='C:/isolated/A',listeners=[];const calls=[];
const view=()=>({workspace,revision:workspace.endsWith('A')?1:2,bindingRevision:0,profiles:[],active:{id:'claw-a',name:workspace.endsWith('A')?'A private draft':'B private draft',capabilities:[]},enabled:true,applicable:true,issues:[],capabilities:[]});
window.api={plugins:{list:async()=>[]},mods:{communityExamples:{list:async()=>({examples:[]})},authoring:{list:async()=>({workspace,drafts:[]})},globalEnabled:async()=>false,status:async()=>({workspace,mods:[],functionMods:[],diagnostics:[]}),clawView:async()=>{window.clawReads=(window.clawReads??0)+1;return view()},clawChange:async(t,m)=>{calls.push(['clawChange',m]);return view()},flowCatalog:async()=>({available:true,hostAvailable:true,workspace,plugins:[],actions:[],agents:[],models:[],features:[]}),flowList:async()=>[{revision:1,digest:'f'.repeat(64),definition:{id:'fixture',name:'B fixture',schemaVersion:2,maxExecutions:1,execution:{profile:'prompt-only-v1'},steps:[{id:'agent',name:'Agent',kind:'agent',enabled:true}]}}],clawSources:async()=>({skills:[],mcp:[]}),onConfigurationChanged:cb=>{listeners.push(cb);return()=>{}},evaluation:{list:async()=>({ok:true,value:{workspace,evaluations:[]}})},skillEvaluation:{list:async()=>({ok:true,value:{workspace,candidates:[{candidateId:'candidate-b',name:'B candidate',skillId:'skill-b'}],records:[]}}),prepare:async input=>{calls.push(['skillPrepare',input]);return{ok:false,code:'INVALID'}}}}};
window.fixture={calls,change:()=>{workspace='C:/isolated/B';listeners.forEach(fn=>fn())},readB:()=>{workspace='C:/isolated/B'}};
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
        b.onResolve({ filter: /^(?:@\/lib\/store|\.\.\/\.\.\/lib\/store)$/ }, () => ({
          path: "store",
          namespace: "fixture"
        }))
        b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          resolveDir: root,
          loader: "js",
          contents: `import{useSyncExternalStore}from'react';let state={currentThreadId:'t',customizeInitialTab:location.hash.slice(1),threads:[{thread_id:'t',metadata:{workspacePath:'C:/isolated/A'}}],setShowCustomizeView:(_open,tab)=>{state={...state,customizeInitialTab:tab};subscribers.forEach(fn=>fn())}};window.moveWorkspace=workspace=>{state={...state,threads:[{thread_id:'t',metadata:{workspacePath:workspace}}]};subscribers.forEach(fn=>fn())};const subscribers=new Set();export const useAppStore=(select)=>{const value=useSyncExternalStore(fn=>{subscribers.add(fn);return()=>subscribers.delete(fn)},()=>state);return select?select(value):value};useAppStore.getState=()=>state;`
        }))
        b.onResolve({ filter: /^\.\// }, (a) => {
          if (
            a.importer.endsWith("CustomizeView.tsx") &&
            !["./ClawPanel", "./ModsPanel", "./EvaluationPanel", "./customize-mode", "./settings-return-focus"].includes(
              a.path
            )
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

async function open(tab = "claw", presentation = "creator") {
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
  await page.addStyleTag({
    path: resolve("output/sparks-remediation-20261010/review-product-round2/current.css")
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
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
try {
  for (const mode of ["internal-flow-button", "sidebar-tab", "overview"]) {
    const { page, errors } = await open()
    const name = page.getByLabel("Claw 组合名称")
    await name.waitFor()
    await name.fill("Unsaved reviewer configuration")
    if (mode === "internal-flow-button") {
      await page.getByLabel("Claw 组合设置", { exact: true }).focus()
      await page.keyboard.press("Control+End")
      await page.waitForTimeout(250)
      const control = page.getByRole("button", { name: "编辑跨插件执行步骤", exact: true }),
        box = await control.boundingBox()
      assert(box.y >= 0 && box.y + box.height <= 650)
      await control.click()
    } else if (mode === "overview")
      await page.getByRole("button", { name: "总览", exact: true }).click()
    else await page.getByRole("button", { name: "自动流程", exact: true }).click()
    await assertInert(page, name)
    await page.getByRole("button", { name: "我的助手", exact: true }).click()
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
    await page.getByRole("button", { name: "我的助手", exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.clawReads ?? 0), 0)
    assert.equal(await page.getByLabel("Claw 组合名称").count(), 0)
    await page.getByRole("button", { name: "我的助手", exact: true }).click()
    const name = page.getByLabel("Claw 组合名称")
    await name.waitFor()
    await name.fill("A draft must not enter B")
    await page.getByRole("button", { name: "自动流程", exact: true }).click()
    await page.evaluate(() => {
      window.fixture.change()
      window.moveWorkspace("C:/isolated/B")
    })
    assert.equal(await name.count(), 0)
    await page.getByRole("button", { name: "我的助手", exact: true }).click()
    await name.waitFor()
    assert.equal(await name.inputValue(), "B private draft")
    assert.deepEqual(errors, [])
    result.scope = { errors, name: await name.inputValue() }
    await page.close()
  }
  {
    const { page, errors } = await open("claw", "ordinary")
    await page.getByLabel("Claw 组合名称").waitFor()
    assert((await page.evaluate(() => window.clawReads ?? 0)) > 0)
    assert.equal(await page.getByRole("button", { name: "创作者模式", exact: true }).count(), 0)
    await page.close()
    result.initialOrdinary = { errors }
  }
  {
    const { page, errors } = await open("mods")
    await page.getByRole("button", { name: "自己制作", exact: true }).click()
    if (await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).count()) await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).click()
    await page.getByRole("button", { name: "打开草稿库", exact: true }).click()
    await page.getByRole("button", { name: "新建草稿", exact: true }).click()
    const name = page.getByLabel("草稿名称")
    await name.fill("Unsaved authoring title")
    await page.getByRole("button", { name: "自动流程", exact: true }).click()
    await assertInert(page, name)
    await page.getByRole("button", { name: "灵件", exact: true }).click()
    assert.equal(await name.inputValue(), "Unsaved authoring title")
    await page.getByRole("button", { name: "总览", exact: true }).click()
    await assertInert(page, name)
    await page.getByRole("button", { name: "灵件", exact: true }).click()
    assert.equal(await name.inputValue(), "Unsaved authoring title")
    await page.getByRole("button", { name: "自动流程", exact: true }).click()
    await page.evaluate(() => {
      window.fixture.change()
      window.moveWorkspace("C:/isolated/B")
    })
    await page.getByRole("button", { name: "灵件", exact: true }).click()
    await page.getByRole("button", { name: "自己制作", exact: true }).click()
    if (await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).count()) await page.getByRole("button", { name: "高级：编辑源码与历史版本", exact: true }).click()
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
