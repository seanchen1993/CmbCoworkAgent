import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/simple-authoring-20261013/combination-browser")
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {SimpleClawBuilder} from './src/renderer/src/components/customize/SimpleClawBuilder';
    import auto from './examples/autobiz-fullstack-mods/mods/manifest.json';
    import review from './examples/mods-review-agent/plugin.json';
    const actions=[auto.claw.actions[0],review.claw.actions[0]].map((action,i)=>({...action,actionId:action.id,
      pluginId:i?'review':'autobiz',plugin:i?'review':'autobiz',digest:'a'.repeat(64)}));
    window.current={currentThreadId:'one',threads:[{thread_id:'one',metadata:{workspacePath:'C:/fixture'}}]};
    window.calls=[];window.prepared=[];window.advanced=0;
    let state={revision:0,bindingRevision:0,workspace:'C:/fixture',enabled:true,applicable:true,active:null,profiles:[],issues:[],
      capabilities:actions.map(a=>({pluginId:a.pluginId,name:a.plugin,digest:a.digest,state:'ready',capabilities:[],actions:[a]}))};
    let failOnce=true;
    window.api={mods:{flowSave:async(t,definition,revision,workspace)=>{window.calls.push(['flow',definition,revision,workspace]);
      return {definition,revision:revision+1,digest:'saved',updatedAt:1}},
      clawChange:async(t,m)=>{window.calls.push([m.kind,m]);if(m.kind==='save'){
        if(failOnce){failOnce=false;throw Error('temporary save failure')};state={...state,revision:state.revision+1,profiles:[m.profile]};
      }else state={...state,bindingRevision:state.bindingRevision+1,active:state.profiles.find(p=>p.id===m.id)};return state;}}};
    function App(){const [view,setView]=useState(state);return <main className='mx-auto max-w-5xl p-3'>
      <SimpleClawBuilder threadId='one' view={view} catalog={{actions,models:[]}}
        initialProfile={{id:'mine',name:'我的组合',capabilities:[],models:{default:'configured-model',roles:{review:'review-model'}}}}
        onView={setView} onAdvanced={()=>window.advanced++} onSources={()=>{throw Error('unexpected source navigation')}}/>
    </main>};createRoot(document.getElementById('root')).render(<App/>);
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    plugins: [
      {
        name: "bounded-fixtures",
        setup(build) {
          build.onResolve(
            { filter: /^@\/lib\/(store|simple-authoring-composer|builtin-navigation)$/ },
            (args) => ({ path: args.path, namespace: "fixture" })
          )
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("store")
              ? "export const useAppStore={getState:()=>window.current}"
              : args.path.endsWith("simple-authoring-composer")
                ? "export const prepareSimpleAuthoringTask=(intent)=>window.prepared.push(intent)"
                : "export const openBuiltinNavigation=()=>{}"
          }))
        }
      }
    ]
  })
  const cssPath = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency: () => {}
  })
  const candidates = new Scanner({}).scanFiles(
    ["SimpleClawBuilder", "SimpleActionParameters", "ClawComponentSelector"].map((name) => ({
      content: readFileSync(resolve(renderer, `components/customize/${name}.tsx`), "utf8"),
      extension: "tsx"
    }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1120, height: 860 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://combination.local/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://combination.local/")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.getByRole("heading", { name: "把两个插件搭配起来" }).waitFor()
    await page.getByLabel("autobiz", { exact: true }).check()
    await page.getByLabel("review", { exact: true }).check()
    await page.getByRole("button", { name: /先后执行/ }).click()
    await page.getByLabel("步骤1动作").selectOption("autobiz:prepare-review")
    await page.getByLabel("步骤2动作").selectOption("review:review-input")
    await page.getByLabel(/真实 Feature ID/).fill("REAL-REQ-1")
    await page.getByLabel(/项目相对文件路径/).fill("src/cart.ts")
    assert.equal(await page.getByLabel("两步连接").inputValue(), "")
    await page.screenshot({ path: resolve(output, "two-plugins-1120.png") })
    await page.setViewportSize({ width: 375, height: 720 })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "temporary save failure" }).waitFor()
    assert.equal(await page.getByLabel(/真实 Feature ID/).inputValue(), "REAL-REQ-1")
    await page.getByRole("button", { name: "保存并核对应用", exact: true }).click()
    await page.getByRole("region", { name: "简单组合应用预览" }).waitFor()
    assert.equal(
      await page.evaluate(
        () => (window as any).calls.filter((entry: any[]) => entry[0] === "flow").length
      ),
      1
    )
    assert.equal(await page.evaluate(() => (window as any).prepared.length), 0)
    await page.getByRole("button", { name: "确认应用", exact: true }).focus()
    await page.keyboard.press("Enter")
    await page.getByRole("region", { name: "组合首次使用" }).waitFor()
    await page.screenshot({ path: resolve(output, "applied-375.png") })
    await page.getByRole("button", { name: "准备首次任务", exact: true }).click()
    const prepared = await page.evaluate(() => (window as any).prepared)
    assert.equal(prepared.length, 1)
    assert.equal(prepared[0].profileId, "mine")
    assert.equal(prepared[0].scope.workspace, "C:/fixture")
    assert.equal(prepared[0].flow.revision, 1)
    assert.equal(prepared[0].flow.definition.steps[1].inputFrom.stepId, "step-1")
    assert.equal(await page.evaluate(() => (window as any).advanced), 0)
    const saved = await page.evaluate(
      () => (window as any).calls.filter((entry: any[]) => entry[0] === "save").at(-1)[1].profile
    )
    assert.deepEqual(saved.models, {
      default: "configured-model",
      roles: { review: "review-model" }
    })
    assert.deepEqual(errors, [])
    console.log(
      "PASS two real declarations, no JSON/advanced editor, failed save resume, explicit apply, 375px, first-task handoff"
    )
  } catch (error) {
    console.error("page errors", errors)
    await page.screenshot({ path: resolve(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
