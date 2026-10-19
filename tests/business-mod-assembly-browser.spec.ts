import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { BusinessModAssemblyRequest } from "../src/shared/business-mods"

type FixtureWindow = typeof window & { calls: Array<[string, ...unknown[]]>; switchScope(): void;
  entryMode: string; deferProjectTemplates: boolean; finishProjectTemplates(): void }

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/business-mod-assembly-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{BusinessModAssemblyPanel}from'./src/renderer/src/components/customize/BusinessModAssemblyPanel';
window.calls=[];window.drafts=[];
const hostFixture=window.businessHostFixture===true;
window.scopeVersion=0;window.entryMode=hostFixture?'host':'legacy';window.pendingProjectIntent=hostFixture?{id:'old-intent'}:null;
const mod=(id,title)=>({id,title,nodeId:id,dependsOn:[],advisory:[]});
const source={id:'source',sourceName:hostFixture?'独立业务':'AutoBiz',sourceDigest:'a'.repeat(64),kernel:{id:'fixture',version:'1.0.0',runtimeAdapter:hostFixture?'host-linear-v1':'autobiz-v1'},mods:[mod('prd','需求分析'),mod('specs','规格设计'),mod('code','代码实现')],excluded:[],warnings:[]};
const custom={id:'custom',sourceName:'我的 Mods',sourceDigest:'b'.repeat(64),mods:[mod('quality','文档质量检查'),{id:'observer',title:'Worktree进度',kind:'function',dependsOn:[],advisory:[]}],excluded:[],warnings:[]};
let imported=0,installedEnabled=false;let saved={copyId:'copy',name:'my-autobiz',version:'1.0.0',digest:'c'.repeat(64),status:'created',fileCount:12};
window.api={plugins:{list:async()=>saved.pluginId?[{id:saved.pluginId,name:saved.name,version:saved.version,enabled:installedEnabled,hasProjectMode:window.entryMode==='legacy'}]:[],setEnabled:async(id)=>{installedEnabled=true;window.calls.push(['enable',id]);return{success:true}}},
harnessBoard:{localProjects:{templates:async()=>{const value=window.entryMode==='host'&&saved.pluginId?[{installedPluginId:saved.pluginId,name:'actual-host-package',version:saved.version,stages:['draft']}]:[];if(window.deferProjectTemplates)return new Promise(resolve=>window.finishProjectTemplates=()=>resolve(value));return value}}},businessModAssembly:{
 sources:async()=>[],list:async()=>[],inspect:async()=>imported++?custom:source,
 preview:async(input)=>{window.calls.push(['preview',input]);return{previewId:'preview',digest:'d'.repeat(64),name:input.request.name,version:input.request.version,runtime:hostFixture?{adapter:'host-linear-v1',mode:'host',stateOwner:'host'}:{adapter:'autobiz-v1',mode:'legacy',stateOwner:'plugin'},
 steps:input.request.order.map(id=>({id,title:id,sourceName:'source'})),extensions:[{id:'observer',title:'Worktree进度',sourceName:'我的 Mods'}],files:[{path:'plugin.json',digest:'d',bytes:42}],sources:[],diagnostics:hostFixture?[]:['来源包含动态阶段；请明确选择固定步骤。'],requiresFixedWorkflowAcknowledgement:!hostFixture,valid:hostFixture||input.request.acceptFixedWorkflow===true}},
 create:async(input)=>{window.calls.push(['create',input]);return saved},
 check:async(input)=>{window.calls.push(['check',input]);return saved={...saved,status:'checked'}},
 install:async(input)=>{window.calls.push(['install',input]);return saved={...saved,status:'installed',pluginId:'new-id'}},
 export:async(input)=>{window.calls.push(['export',input]);return{output:'C:/export/new.zip',digest:'e'.repeat(64),files:12}}
}};
function App(){const[workspace,setWorkspace]=useState('C:/demo');window.switchScope=()=>{window.scopeVersion++;setWorkspace('C:/other')};
return <main className='mx-auto max-w-5xl p-4'><BusinessModAssemblyPanel threadId='thread' workspace={workspace} active/></main>}
createRoot(document.getElementById('root')).render(<App/>);`
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    plugins: [
      {
        name: "controlled-boundaries",
        setup(builder) {
          builder.onResolve(
            {
              filter: /^(?:@\/lib\/(store|configuration-target|feature-gates|derived-project-intent)|sonner)$/
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents: args.path === "sonner"
              ? "export const toast={info:(text)=>window.calls.push(['notice',text])}"
              : args.path.endsWith("store")
              ? "import{useSyncExternalStore}from'react';const listeners=new Set();const state={pluginVersion:0,bumpPluginVersion(){state.pluginVersion++;for(const cb of listeners)cb()},setShowCustomizeView(value){window.calls.push(['customize',value])},setShowHarnessBoardView(value){window.calls.push(['host-projects',value])}};export function useAppStore(selector){return useSyncExternalStore(cb=>{listeners.add(cb);return()=>listeners.delete(cb)},()=>selector(state))};useAppStore.getState=()=>state;"
              : args.path.endsWith("configuration-target")
                ? "export const useConfigurationDraft=(...args)=>window.drafts.push(args);export const captureConfigurationScope=()=>{const version=window.scopeVersion;return()=>version===window.scopeVersion}"
                : args.path.endsWith("feature-gates")
                  ? "export const useFeatureGate=()=>({enabled:true,loading:false})"
                  : "export const openDerivedProject=(...args)=>window.calls.push(['project',...args]);export const useDerivedProjectIntent=()=>window.pendingProjectIntent;export const dismissDerivedProject=(id)=>{window.calls.push(['dismiss-project',id]);window.pendingProjectIntent=null}"
          }))
        }
      }
    ]
  })
  const cssPath = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      /* The fixture collects all stylesheet candidates explicitly. */
    }
  })
  const candidates = new Scanner({}).scanFiles([
    {
      content: readFileSync(
        resolve(renderer, "components/customize/BusinessModAssemblyPanel.tsx"),
        "utf8"
      ),
      extension: "tsx"
    },
    {
      content: readFileSync(resolve(renderer, "components/ui/button.tsx"), "utf8"),
      extension: "tsx"
    },
    {
      content: readFileSync(resolve(renderer, "components/customize/InstalledPluginProjectEntry.tsx"), "utf8"),
      extension: "tsx"
    }
  ])
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1120, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("pageerror", (error) => console.error("Browser error:", error.message))
  try {
    await page.route("http://localhost:4317/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost:4317/")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "导入 Mods 源码目录" }).click()
    await page.getByRole("checkbox", { name: "选择 Mod 需求分析" }).check()
    await page.getByRole("checkbox", { name: "选择 Mod 规格设计" }).check()
    await page.getByRole("button", { name: "导入 Mods 源码目录" }).click()
    await page.getByRole("checkbox", { name: "选择 Mod Worktree进度" }).check()
    await page.getByRole("checkbox", { name: "选择 Mod 文档质量检查" }).check()
    assert.equal(await page.getByRole("button", { name: "Worktree进度上移" }).count(), 0)
    await page.getByRole("button", { name: "文档质量检查上移" }).click()
    await page.getByRole("button", { name: "文档质量检查下移" }).click()
    await page.getByLabel("新插件名称", { exact: true }).fill("my-review-plugin")
    await page.getByRole("button", { name: "预览新插件", exact: true }).click()
    assert.match(await page.getByLabel("组装流程执行方式").innerText(), /插件原有流程/)
    await page.getByText("查看包含的技能与文件", { exact: true }).click()
    await page.getByText("plugin.json", { exact: true }).waitFor()
    const request = (await page.evaluate(
      () => (window as FixtureWindow).calls.find((entry) => entry[0] === "preview")![1]
    )) as { request: BusinessModAssemblyRequest }
    assert.deepEqual(request.request.order, ["prd", "specs", "quality"])
    assert.deepEqual(request.request.sources, [
      { inspectionId: "source", modIds: ["prd", "specs"] },
      { inspectionId: "custom", modIds: ["quality", "observer"] }
    ])
    await page.getByLabel("插件版本", { exact: true }).fill("1.0.1")
    assert.equal(await page.getByRole("button", { name: "生成独立插件" }).count(), 0)
    await page.getByRole("button", { name: "预览新插件", exact: true }).click()
    assert(await page.getByRole("button", { name: "生成独立插件" }).isDisabled())
    await page.getByRole("checkbox", { name: /我选择使用当前所选的固定步骤/ }).check()
    await page.waitForFunction(
      () =>
        (window as FixtureWindow).calls.filter(
          (entry) =>
            entry[0] === "preview" &&
            (entry[1] as { request: BusinessModAssemblyRequest }).request.acceptFixedWorkflow
        ).length === 1
    )
    await page.screenshot({ path: resolve(output, "01-compose.png"), fullPage: true })
    await page.getByRole("button", { name: "生成独立插件" }).click()
    assert.equal(
      await page.getByRole("button", { name: "安装新插件", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "检查插件包" }).click()
    await page.getByRole("button", { name: "安装新插件", exact: true }).click()
    await page.getByRole("button", { name: "启用新插件", exact: true }).click()
    await page.getByRole("button", { name: "导出 ZIP", exact: true }).click()
    await page.getByText("已导出 12 个文件：C:/export/new.zip", { exact: true }).waitFor()
    await page.getByRole("button", { name: "新建项目", exact: true }).click()
    await page.waitForFunction(() => (window as FixtureWindow).calls.some(([name]) => name === "project"))
    const calls = await page.evaluate(() => (window as FixtureWindow).calls)
    assert.deepEqual(calls.find((entry) => entry[0] === "project")!.slice(1), [
      "new-id",
      "my-autobiz",
      { threadId: "thread", expectedWorkspace: "C:/demo" }
    ])
    await page.setViewportSize({ width: 375, height: 720 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: resolve(output, "02-installed-mobile.png"), fullPage: true })
    await page.evaluate(() => (window as FixtureWindow).switchScope())
    await page.getByText("请先勾选需要的业务 Mods。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "导出 ZIP", exact: true }).count(), 0)
    await page.goto("http://localhost:4317/")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.evaluate(() => {
      ;(window as Window & { businessHostFixture?: boolean }).businessHostFixture = true
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "导入 Mods 源码目录" }).click()
    await page.getByRole("checkbox", { name: "选择 Mod 需求分析" }).check()
    await page.getByLabel("新插件名称", { exact: true }).fill("my-host-plugin")
    await page.getByRole("button", { name: "预览新插件", exact: true }).click()
    assert.match(await page.getByLabel("组装流程执行方式").innerText(), /平台阶段流程/)
    assert.equal(
      await page.getByRole("checkbox", { name: /我选择使用当前所选的固定步骤/ }).count(),
      0
    )
    assert.equal(await page.getByRole("button", { name: "生成独立插件" }).isEnabled(), true)
    await page.getByRole("button", { name: "生成独立插件" }).click()
    await page.getByRole("button", { name: "检查插件包" }).click()
    await page.getByRole("button", { name: "安装新插件", exact: true }).click()
    await page.getByRole("button", { name: "启用新插件", exact: true }).click()
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).waitFor()
    await page.getByText("进入后点击“新建本地任务”，选择“actual-host-package”。", { exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "03-host-project-entry-mobile.png"), fullPage: true })
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).click()
    await page.waitForFunction(() => (window as FixtureWindow).calls.some(([name]) => name === "host-projects"))
    let hostCalls = await page.evaluate(() => (window as FixtureWindow).calls)
    assert.equal(hostCalls.filter((entry) => entry[0] === "project").length, 0)
    assert.equal(hostCalls.filter((entry) => entry[0] === "host-projects").length, 1)
    assert.deepEqual(hostCalls.filter(([name]) => name === "customize"), [["customize", false]])
    assert(hostCalls.some((entry) => entry[0] === "notice" && String(entry[1]).includes("actual-host-package")))
    assert(hostCalls.some((entry) => entry[0] === "dismiss-project" && entry[1] === "old-intent"))
    // A stale copy cannot keep a legacy entrance after the actual installed mode changes.
    await page.evaluate(() => { (window as FixtureWindow).entryMode = "ordinary" })
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).click()
    await page.getByText("这个插件没有项目入口，可在聊天中使用它提供的功能。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "新建项目", exact: true }).count(), 0)
    await page.evaluate(() => { (window as FixtureWindow).entryMode = "host" })
    await page.getByRole("button", { name: "重新检查项目入口", exact: true }).click()
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).waitFor()
    await page.evaluate(() => { (window as FixtureWindow).deferProjectTemplates = true })
    await page.getByRole("button", { name: "打开本地项目任务", exact: true }).click()
    await page.waitForFunction(() => typeof (window as FixtureWindow).finishProjectTemplates === "function")
    await page.evaluate(() => (window as FixtureWindow).switchScope())
    await page.getByText("请先勾选需要的业务 Mods。", { exact: true }).waitFor()
    await page.evaluate(async () => { (window as FixtureWindow).finishProjectTemplates(); await Promise.resolve(); await Promise.resolve() })
    hostCalls = await page.evaluate(() => (window as FixtureWindow).calls)
    assert.equal(hostCalls.filter((entry) => entry[0] === "host-projects").length, 1)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({ path: resolve(output, "03-host-flow-mobile.png"), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(
      `PASS business Mods composition UI: source selection, custom Mod, ordering, invalidation, create/check/install/export, scope reset. ${output}`
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
