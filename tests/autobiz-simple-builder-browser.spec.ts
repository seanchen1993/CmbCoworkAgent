import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { FlowDefinition } from "../src/shared/mods/flows/types"
import type { ClawMutation } from "../src/shared/mods/claw"

type BuilderFixtureCall =
  | ["flow", FlowDefinition, number, string]
  | ["save", Extract<ClawMutation, { kind: "save" }>]
  | ["apply", Extract<ClawMutation, { kind: "apply" }>]
type BuilderFixtureWindow = Window & {
  calls: BuilderFixtureCall[]
  flowUses: unknown[]
  advanced: number
}

async function main() {
  const source = process.env.AUTOBIZ_DEMO_SOURCE
  if (!source) {
    console.log("SKIP AutoBiz browser: set AUTOBIZ_DEMO_SOURCE to the explicitly selected plugin source")
    return
  }
  const pluginRoot = resolve(source)
  const manifestPath = resolve(pluginRoot, "mods/manifest.json")
  const pluginPath = resolve(pluginRoot, "plugin.json")
  const native = JSON.parse(readFileSync(manifestPath, "utf8"))
  const plugin = JSON.parse(readFileSync(pluginPath, "utf8"))
  assert.equal(plugin.name, native.id)
  assert.equal(native.claw.actions.length, 2)
  assert.deepEqual(native.claw.actions.map((action: { id: string }) => action.id), ["collect-evidence", "generate-report"])
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/autobiz-simple-builder-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(), loader: "tsx",
      contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {SimpleClawBuilder} from './src/renderer/src/components/customize/SimpleClawBuilder';
const native=${JSON.stringify(native)},plugin=${JSON.stringify(plugin)};
const actions=native.claw.actions.map(action=>({...action,actionId:action.id,
 pluginId:'test-installed-autobiz',plugin:plugin.name,digest:'a'.repeat(64)}));
window.current={currentThreadId:'autobiz-chat',showCustomizeView:true,
 threads:[{thread_id:'autobiz-chat',metadata:{workspacePath:'C:/controlled-autobiz',agentMode:'normal'}}],
 selectThread:async id=>{window.current.currentThreadId=id;window.current.showCustomizeView=false},
 setShowCustomizeView:value=>window.current.showCustomizeView=value};
window.calls=[];window.flowUses=[];window.advanced=0;
window.addEventListener('devclaw:chat-flow-use',e=>window.flowUses.push(e.detail));
let state={revision:0,bindingRevision:0,workspace:'C:/controlled-autobiz',enabled:true,applicable:true,
 active:null,profiles:[],issues:[],capabilities:[{pluginId:'test-installed-autobiz',name:plugin.name,
 digest:'a'.repeat(64),state:'ready',capabilities:[],components:native.claw.components,actions}]};
window.api={mods:{flowSave:async(t,definition,revision,workspace)=>{
 window.calls.push(['flow',definition,revision,workspace]);return {definition,revision:revision+1,digest:'saved',updatedAt:1}},
 clawChange:async(t,m)=>{window.calls.push([m.kind,m]);if(m.kind==='save')
 state={...state,revision:state.revision+1,profiles:[m.profile]};else
 state={...state,bindingRevision:state.bindingRevision+1,active:state.profiles.find(p=>p.id===m.id)};return state;}}};
function App(){const[view,setView]=useState(state);return <main className='mx-auto max-w-5xl p-3'>
 <SimpleClawBuilder threadId='autobiz-chat' view={view} catalog={{actions,models:[]}}
 initialProfile={{id:'demo',name:'AutoBiz交付证据搭配',capabilities:[]}}
 onView={setView} onAdvanced={()=>window.advanced++} onSources={()=>{throw Error('Unexpected navigation')}}/>
 </main>};createRoot(document.getElementById('root')).render(<App/>);
`
    },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": renderer },
    plugins: [{ name: "controlled-store-only", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/(store|builtin-navigation)$/ }, args => ({ path: args.path, namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path.endsWith("store")
        ? "export const useAppStore={getState:()=>window.current}" : "export const openBuiltinNavigation=()=>{}" }))
    } }]
  })
  const cssPath = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), { base: dirname(cssPath), from: cssPath, onDependency: () => {} })
  const candidates = new Scanner({}).scanFiles(["SimpleClawBuilder", "SimpleActionParameters", "StringArrayParameter", "ClawComponentSelector"].map(name => ({
    content: readFileSync(resolve(renderer, `components/customize/${name}.tsx`), "utf8"), extension: "tsx"
  })))
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1120, height: 860 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  try {
    await page.route("http://autobiz-builder.local/", route => route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" }))
    await page.goto("http://autobiz-builder.local/")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByRole("heading", { name: "配置常用搭配" }).waitFor()
    await page.getByRole("checkbox", { name: plugin.name, exact: true }).check()
    await page.getByLabel(`选择组件 ${plugin.name} · 真实Feature状态看板`, { exact: true }).uncheck()
    await page.getByLabel(`选择组件 ${plugin.name} · 真实状态与来源`, { exact: true }).uncheck()
    assert.equal(await page.getByLabel(`选择组件 ${plugin.name} · 交付证据与报告`, { exact: true }).isChecked(), true)
    await page.getByRole("button", { name: /先后执行/ }).click()
    await page.getByLabel("步骤1动作", { exact: true }).selectOption("test-installed-autobiz:collect-evidence")
    await page.getByLabel("设置 步骤1输入 · Feature 标识", { exact: true }).check()
    await page.getByLabel("步骤1输入 · Feature 标识", { exact: true }).fill("actual-feature-slug")
    await page.getByLabel("设置 步骤1输入 · 源码文件", { exact: true }).check()
    await page.getByRole("button", { name: "添加 步骤1输入 · 源码文件", exact: true }).click()
    await page.getByLabel("步骤1输入 · 源码文件 · 第1项", { exact: true }).fill("src/export.ts")
    await page.getByRole("button", { name: "添加步骤", exact: true }).click()
    await page.getByLabel("步骤2动作", { exact: true }).selectOption("test-installed-autobiz:generate-report")
    await page.getByLabel("步骤2输入来源", { exact: true }).selectOption(JSON.stringify(["step-1", ""]))
    assert.equal(await page.getByLabel("步骤2输入来源", { exact: true }).inputValue(), JSON.stringify(["step-1", ""]))
    await page.screenshot({ path: resolve(output, "01-real-schema-configured.png"), fullPage: true })
    await page.setViewportSize({ width: 375, height: 720 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await page.getByRole("region", { name: "简单组合应用预览", exact: true }).waitFor()
    await page.getByRole("button", { name: "确认应用", exact: true }).click()
    await page.getByRole("region", { name: "组合首次使用", exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "02-applied-375.png"), fullPage: true })
    await page.getByRole("button", { name: "去这段聊天使用", exact: true }).click()
    const observed = await page.evaluate(() => {
      const fixture = window as BuilderFixtureWindow
      return { calls: fixture.calls, uses: fixture.flowUses, advanced: fixture.advanced }
    })
    const flowCall = observed.calls.find((call) => call[0] === "flow")
    assert(flowCall?.[0] === "flow")
    const flow = flowCall[1]
    const steps = flow.steps.map((step) => {
      assert(step.kind === "plugin-action")
      return step
    })
    assert.deepEqual(steps.map((step) => step.actionId), ["collect-evidence", "generate-report"])
    assert.deepEqual(steps[0].input, { feature: "actual-feature-slug", sourcePaths: ["src/export.ts"] })
    assert.deepEqual(steps[1].input, {})
    assert.deepEqual(steps[1].inputFrom, { stepId: "step-1", path: "" })
    assert.equal(new Set(steps.map((step) => step.pluginId)).size, 1)
    const saveCall = observed.calls.find((call) => call[0] === "save")
    assert(saveCall?.[0] === "save")
    const saved = saveCall[1].profile
    assert(saved.capabilities[0].components)
    assert.deepEqual(saved.capabilities[0].components.ids, ["delivery-report"])
    assert.equal(observed.uses.length, 1)
    assert.equal(observed.advanced, 0)
    assert.deepEqual(errors, [])
    const report = { status: "passed", plugin: plugin.name, version: plugin.version, source: pluginRoot,
      checks: 8, errors, savedFlow: flow, limits: ["Real declarations and real React browser UI; controlled save/apply API fixture, not native IPC execution"] }
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ status: report.status, checks: report.checks, output, errors }))
  } catch (error) {
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    console.error("AutoBiz UI errors", errors, "evidence", output)
    throw error
  } finally { await browser.close() }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
