import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface BindingWindow extends Window {
  calls: Array<[string, ...unknown[]]>
  enabled: boolean
  installed: boolean
  version: string
  pluginPath: string
  updatedAt: string
  account: number
  incompatible: boolean
  inventoryFailed: boolean
  defer: boolean
  available: boolean
  finish(): void
}

async function main() {
  const output = resolve("output/native-node-project-binding-browser")
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {NativeNodeComposer} from './src/renderer/src/components/customize/NativeNodeComposer';
      import {useDerivedProjectIntent,dismissDerivedProject} from './src/renderer/src/lib/derived-project-intent';
      window.calls=[];window.enabled=true;window.installed=true;window.version='1';window.account=1;window.pluginPath='C:/plugins/original';window.updatedAt='one';
      const project={projectId:'bound',name:'已绑定项目',workspacePath:'C:/projects',projectDir:'review',
        lifecycle:{status:'active'},harnessAdapter:{type:'plugin',id:'plugin',name:'Review',boundVersion:'0.8'},
        boardCompatibility:{compatible:true,label:'可用'}};
      window.api={plugins:{list:async()=>{window.calls.push(['plugins']);const rows=window.installed?[{id:'plugin',name:'Review',version:window.version,enabled:window.enabled,path:window.pluginPath,updatedAt:window.updatedAt}]:[];
        if(window.defer){window.defer=false;return new Promise(done=>window.finish=()=>done(rows))}return rows}},
        harnessBoard:{listProjects:async()=>{if(window.inventoryFailed)throw Error('注册目录不可读');return[{...project,boardCompatibility:window.incompatible?{compatible:false,label:'协议不兼容',message:'请核对项目使用的协议版本'}:project.boardCompatibility}]}},
        nodeComposition:{projects:async(scope)=>{window.calls.push(['projects',scope]);return window.available?[{...project,workspacePath:'C:/unbound',projectDir:''}]:[]},catalog:async(input)=>{window.calls.push(['catalog',input]);if(!window.available||input.expectedWorkspace!=='C:/unbound')throw Error('Foreign catalog must never be requested');return{project,nodes:[],config:{nodes:[],templates:[]}}}}};
      function Intent(){const value=useDerivedProjectIntent();return value?<section aria-label='原生项目入口'><pre>{JSON.stringify(value)}</pre><button onClick={()=>dismissDerivedProject(value.id)}>关闭入口记录</button></section>:null}
      function App(){const[visible,setVisible]=useState(true);return<><button onClick={()=>setVisible(!visible)}>切换项目流程</button>{visible&&<NativeNodeComposer threadId='thread' workspace='C:/unbound' pluginId='plugin' initialOpen/>}<Intent/></>}
      createRoot(document.getElementById('root')).render(<App/>);
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    plugins: [
      {
        name: "controlled-host",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:@\/lib\/(?:store|feature-gates)|\.\/store)$/ },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("store")
              ? "export const useAppStore={getState:()=>({accountRevision:window.account,currentThreadId:'thread',showCustomizeView:true,threads:[{thread_id:'thread',metadata:{workspacePath:'C:/unbound'}}],setShowCustomizeView(...v){window.calls.push(['customize',...v])},setShowHarnessBoardView(v){window.calls.push(['board',v])}})}"
              : "export const useFeatureGate=()=>({enabled:true,loading:false})"
          }))
        }
      }
    ]
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/project-binding", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/project-binding")
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByText("项目绑定在其他目录，请打开已绑定项目使用。", { exact: true }).waitFor()
    assert((await page.locator("body").innerText()).includes("项目记录版本 0.8"))
    assert(!(await page.locator("body").innerText()).includes("这个工作区没有绑定此插件版本"))
    await page.getByRole("button", { name: "打开已绑定项目：已绑定项目", exact: true }).click()
    const readIntent = async () =>
      JSON.parse(await page.getByLabel("原生项目入口").locator("pre").innerText())
    assert.equal((await readIntent()).projectId, "bound")
    assert.deepEqual((await readIntent()).scope, {
      threadId: "thread",
      expectedWorkspace: "C:/unbound"
    })
    await page.getByRole("button", { name: "关闭入口记录" }).click()
    await page.getByRole("button", { name: "新建此插件项目", exact: true }).click()
    assert.equal((await readIntent()).pluginId, "plugin")
    assert.equal((await readIntent()).projectId, undefined)
    await page.getByRole("button", { name: "关闭入口记录" }).click()
    const refresh = () =>
      page.getByRole("button", { name: "重新读取项目绑定", exact: true }).click()
    await page.evaluate(() => {
      ;(window as BindingWindow).enabled = false
    })
    await refresh()
    await page
      .getByText("所选插件已停用。管理并明确启用后，再重新读取项目绑定。", { exact: true })
      .waitFor()
    assert(
      await page
        .getByRole("button", { name: "打开已绑定项目：已绑定项目", exact: true })
        .isDisabled()
    )
    assert.equal(await page.getByRole("button", { name: "新建此插件项目", exact: true }).count(), 0)
    await page.evaluate(() => {
      ;(window as BindingWindow).installed = false
    })
    await refresh()
    await page.getByText("所选插件已移除，请先重新安装并核对来源。", { exact: true }).waitFor()
    await page.evaluate(() => {
      Object.assign(window, { enabled: true, installed: true, incompatible: true })
    })
    await refresh()
    await page.getByText("请核对项目使用的协议版本", { exact: true }).waitFor()
    await page.evaluate(() => {
      Object.assign(window, { incompatible: false, inventoryFailed: true })
    })
    await refresh()
    await page.getByRole("alert").filter({ hasText: "注册目录不可读" }).waitFor()
    await page.evaluate(() => {
      ;(window as BindingWindow).inventoryFailed = false
    })
    await refresh()
    await page.getByRole("button", { name: "新建此插件项目", exact: true }).waitFor()
    await page.evaluate(() => {
      ;(window as BindingWindow).version = "2"
    })
    await page.getByRole("button", { name: "新建此插件项目", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "插件已停用、移除或版本已变化" }).waitFor()
    assert.equal(await page.getByLabel("原生项目入口").count(), 0)
    await page.evaluate(() => {
      ;(window as BindingWindow).version = "1"
    })
    await refresh()
    await page.evaluate(() => {
      ;(window as BindingWindow).pluginPath = "C:/plugins/reinstalled"
    })
    await page.getByRole("button", { name: "新建此插件项目", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "插件已停用、移除或版本已变化" }).waitFor()
    assert.equal(await page.getByLabel("原生项目入口").count(), 0)
    await page.evaluate(() => {
      ;(window as BindingWindow).pluginPath = "C:/plugins/original"
    })
    await refresh()
    await page.evaluate(() => {
      ;(window as BindingWindow).defer = true
    })
    await page.getByRole("button", { name: "新建此插件项目", exact: true }).click()
    await page.getByRole("button", { name: "切换项目流程", exact: true }).click()
    await page.evaluate(() => (window as BindingWindow).finish())
    assert.equal(await page.getByLabel("原生项目入口").count(), 0)
    await page.getByRole("button", { name: "切换项目流程", exact: true }).click()
    await page.getByRole("button", { name: "新建此插件项目", exact: true }).waitFor()
    assert.equal(
      await page.evaluate(
        () => (window as BindingWindow).calls.filter(([name]) => name === "catalog").length
      ),
      0
    )
    await page.evaluate(() => {
      ;(window as BindingWindow).available = true
    })
    await refresh()
    await page.getByLabel("选择节点所属项目").selectOption("bound")
    await page.getByRole("status").filter({ hasText: "项目记录版本 0.8" }).waitFor()
    const activeCatalog = await page.evaluate(() =>
      (window as BindingWindow).calls.filter(([name]) => name === "catalog")
    )
    assert.equal(activeCatalog.length, 1)
    assert.deepEqual(activeCatalog[0][1], {
      threadId: "thread",
      expectedWorkspace: "C:/unbound",
      projectId: "bound"
    })
    await page.evaluate(() => {
      ;(window as BindingWindow).defer = true
    })
    await page.getByRole("button", { name: "在原项目中使用", exact: true }).click()
    await page.evaluate(() => {
      ;(window as BindingWindow).account = 2
      ;(window as BindingWindow).finish()
    })
    await page.getByRole("alert").filter({ hasText: "聊天、目录或账号已变化" }).waitFor()
    assert.equal(await page.getByLabel("原生项目入口").count(), 0)
    const calls = await page.evaluate(() => (window as BindingWindow).calls)
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify(
        {
          passed: true,
          calls,
          errors,
          checks: [
            "other workspace opens exact native project",
            "explicit new project",
            "disabled",
            "removed",
            "incompatible",
            "inventory failure",
            "version changed",
            "same-version source replacement rejected",
            "unmounted pending navigation rejected",
            "late account rejected",
            "available project retains version diagnostic"
          ]
        },
        null,
        2
      )
    )
    await page.screenshot({ path: resolve(output, "project-binding.png"), fullPage: true })
    console.log(
      "PASS real project binding component + native intents: 11 paths, no foreign catalog or implicit enable"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
