import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { BusinessModAssemblyRequest } from "../src/shared/business-mods"

type FixtureWindow = Window & { calls: Array<[string, ...unknown[]]>; switchScope(): void }

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
const mod=(id,title)=>({id,title,nodeId:id,dependsOn:[],advisory:[]});
const source={id:'source',sourceName:'AutoBiz',sourceDigest:'a'.repeat(64),mods:[mod('prd','需求分析'),mod('specs','规格设计'),mod('code','代码实现')],excluded:[],warnings:[]};
const custom={id:'custom',sourceName:'我的 Mods',sourceDigest:'b'.repeat(64),mods:[mod('quality','文档质量检查'),{id:'observer',title:'Worktree进度',kind:'function',dependsOn:[],advisory:[]}],excluded:[],warnings:[]};
let imported=0;let saved={copyId:'copy',name:'my-autobiz',version:'1.0.0',digest:'c'.repeat(64),status:'created',fileCount:12};
window.api={plugins:{setEnabled:async(id)=>{window.calls.push(['enable',id]);return{success:true}}},businessModAssembly:{
 sources:async()=>[],list:async()=>[],inspect:async()=>imported++?custom:source,
 preview:async(input)=>{window.calls.push(['preview',input]);return{previewId:'preview',digest:'d'.repeat(64),name:input.request.name,version:input.request.version,
 steps:input.request.order.map(id=>({id,title:id,sourceName:'source'})),extensions:[{id:'observer',title:'Worktree进度',sourceName:'我的 Mods'}],files:[{path:'plugin.json',digest:'d',bytes:42}],sources:[],diagnostics:['来源包含动态阶段；请明确选择固定步骤。'],requiresFixedWorkflowAcknowledgement:true,valid:input.request.acceptFixedWorkflow===true}},
 create:async(input)=>{window.calls.push(['create',input]);return saved},
 check:async(input)=>{window.calls.push(['check',input]);return saved={...saved,status:'checked'}},
 install:async(input)=>{window.calls.push(['install',input]);return saved={...saved,status:'installed',pluginId:'new-id'}},
 export:async(input)=>{window.calls.push(['export',input]);return{output:'C:/export/new.zip',digest:'e'.repeat(64),files:12}}
}};
function App(){const[workspace,setWorkspace]=useState('C:/demo');window.switchScope=()=>setWorkspace('C:/other');
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
              filter: /^@\/lib\/(store|configuration-target|feature-gates|derived-project-intent)$/
            },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("store")
              ? "export const useAppStore={getState:()=>({bumpPluginVersion(){}})}"
              : args.path.endsWith("configuration-target")
                ? "export const useConfigurationDraft=(...args)=>window.drafts.push(args)"
                : args.path.endsWith("feature-gates")
                  ? "export const useFeatureGate=()=>({enabled:true,loading:false})"
                  : "export const openDerivedProject=(...args)=>window.calls.push(['project',...args])"
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
    await page.waitForFunction(() => (window as FixtureWindow).calls.filter(
      entry => entry[0] === "preview" && (entry[1] as {request:BusinessModAssemblyRequest}).request.acceptFixedWorkflow
    ).length === 1)
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
