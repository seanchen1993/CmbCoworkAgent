import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"

interface FixtureWindow extends Window {
  calls: Array<[string, ...unknown[]]>
  fail: boolean
  defer: boolean
  finish(): void
  selectedThread: string | null
  invalidSource: boolean
  renderScope(thread?: string, workspace?: string, initial?: boolean): void
}

async function main() {
  const output = resolve("output/plain-language-20261013", `native-node-composition-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const script = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {NativeNodeComposer} from './src/renderer/src/components/customize/NativeNodeComposer';
        import {useNativeNodeIntent,dismissNativeNodePlan} from './src/renderer/src/lib/node-composition-intent';
        window.calls=[];
        const project={projectId:'project',name:'我的 AutoBiz',rootPath:'C:/fixture'};
        const nodes=[{id:'init',label:'准备',description:'读取需求',inputs:[],outputs:['requirements.md']},
          {id:'build',label:'开发',description:'完成实现',inputs:['requirements.md'],outputs:['changes']},
          {id:'review',label:'检查',description:'验证结果',inputs:['changes'],outputs:['report']}].map(n=>({...n,optionalInputs:n.id==='review'?['DETAIL_DESIGN.md']:[]}));
        const config={nodes:nodes.map(n=>({id:n.id,label:n.label,description:n.description})),templates:[{id:'custom',templateType:'custom',requiredNodes:['init'],nodes:[],name:'自选'}]};
        const catalog={project,config,nodes};
        window.api={nodeComposition:{
          projects:async(scope)=>{window.calls.push(['projects',scope]);return [project,{...project,projectId:'unsupported',name:'不支持的项目'}]},
          catalog:async(input)=>{window.calls.push(['catalog',input]);if(input.projectId==='unsupported')throw Error('这个插件未提供自选节点');return catalog},
          preview:async(input)=>{window.calls.push(['preview',input]);if(window.fail)throw Error('必需资料缺失');
            const plan={...catalog,planId:'plan',templateId:'custom',selected:input.selected,added:['build'],ordered:['init','build','review'],optionalOmissions:[{nodeId:'review',path:'DETAIL_DESIGN.md'}],expiresAt:Date.now()+100000};
            if(window.defer)return new Promise(resolve=>window.finish=()=>resolve(plan));return plan;},
          create:async()=>{throw Error('Preview must never create a feature')}}};
        function Intent(){const value=useNativeNodeIntent();return value?<div aria-label='收到节点交接'><pre>{JSON.stringify(value)}</pre><button onClick={()=>dismissNativeNodePlan(value.id)}>接收交接</button></div>:null}
        const root=createRoot(document.getElementById('root'));
        window.renderScope=(threadId='thread',workspace='C:/fixture',initial=false)=>root.render(<><NativeNodeComposer key={threadId+initial} threadId={threadId} workspace={workspace} initialOpen={initial} initialProjectId={initial?'project':undefined}/><Intent/></>);
        window.renderScope();
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
        name: "host-boundary",
        setup(builder) {
          builder.onResolve(
            { filter: /^(?:@\/lib\/(?:store|feature-gates)|\.\/store)$/ },
            (args) => ({
              path: args.path,
              namespace: "fixture"
            })
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents: args.path.endsWith("store")
              ? "window.selectedThread='thread';export const useAppStore={getState:()=>({currentThreadId:window.selectedThread,threads:[{thread_id:'thread',metadata:{workspacePath:window.invalidSource?'C:/changed':'C:/fixture'}},{thread_id:'other',metadata:{workspacePath:'C:/other'}}],async selectThread(id,options){window.selectedThread=id;window.calls.push(['selectThread',id,options])},setShowCustomizeView(value){window.calls.push(['customize',value])},setShowHarnessBoardView(value){if(value)window.selectedThread=null;window.calls.push(['board',value])}})}"
              : "export const useFeatureGate=()=>({enabled:true,loading:false})"
          }))
        }
      }
    ]
  })
  const cssPath = resolve("src/renderer/src/index.css")
  const compiler = await compile(readFileSync(cssPath, "utf8"), {
    base: dirname(cssPath),
    from: cssPath,
    onDependency() {
      /* Isolated UI fixture has no dependency watcher. */
    }
  })
  const candidates = new Scanner({}).scanFiles([
    {
      content: readFileSync(
        resolve("src/renderer/src/components/customize/NativeNodeComposer.tsx"),
        "utf8"
      ),
      extension: "tsx"
    }
  ])
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 375, height: 850 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("http://localhost/nodes", (route) =>
      route.fulfill({ contentType: "text/html", body: "<div id='root'></div>" })
    )
    await page.goto("http://localhost/nodes")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: script.outputFiles[0].text })
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).renderScope("thread", "C:/fixture", true)
    })
    await page.getByRole("checkbox", { name: /准备/ }).waitFor()
    assert.equal(await page.getByLabel("选择节点所属项目").inputValue(), "project")
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).renderScope()
    })
    await page.getByRole("button", { name: "选择项目步骤", exact: true }).click()
    await page.getByLabel("选择节点所属项目").selectOption("unsupported")
    await page.getByRole("alert").filter({ hasText: "未提供自选节点" }).waitFor()
    await page.getByLabel("选择节点所属项目").selectOption("project")
    assert(await page.getByRole("checkbox", { name: /准备/ }).isDisabled())
    await page.getByRole("checkbox", { name: /检查/ }).check()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).fail = true
    })
    await page.getByRole("button", { name: "检查并预览步骤", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "必需资料缺失" }).waitFor()
    assert(await page.getByRole("checkbox", { name: /检查/ }).isChecked())
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).fail = false
    })
    await page.getByRole("button", { name: "检查并预览步骤", exact: true }).focus()
    await page.keyboard.press("Enter")
    const preview = page.getByLabel("节点组合预览")
    await preview.waitFor()
    assert((await preview.innerText()).includes("开发（为保留输入和检查自动补齐）"))
    assert((await preview.innerText()).includes("DETAIL_DESIGN.md"))
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    )
    await page.screenshot({
      path: resolve(output, "native-node-preview-mobile.png"),
      fullPage: true
    })
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).invalidSource = true
    })
    await page.getByRole("button", { name: "在项目里创建需求", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "原聊天或项目目录已改变" }).waitFor()
    assert.equal(await page.getByLabel("收到节点交接").count(), 0)
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).invalidSource = false
    })
    await page.getByRole("button", { name: "在项目里创建需求", exact: true }).click()
    const intent = JSON.parse(await page.getByLabel("收到节点交接").locator("pre").innerText())
    assert.deepEqual(intent.scope, { threadId: "thread", expectedWorkspace: "C:/fixture" })
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).selectedThread),
      "thread"
    )
    const navigation = await page.evaluate(() =>
      (window as unknown as FixtureWindow).calls.filter(
        ([kind]) => kind === "board" || kind === "selectThread"
      )
    )
    assert.deepEqual(navigation, [
      ["board", true],
      ["selectThread", "thread", { preserveView: true }]
    ])

    assert.deepEqual(intent.plan.ordered, ["init", "build", "review"])
    await page.getByRole("button", { name: "接收交接", exact: true }).click()
    await page.getByRole("checkbox", { name: /检查/ }).uncheck()
    assert.equal(await preview.count(), 0)
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).defer = true
    })
    await page.getByRole("button", { name: "检查并预览步骤", exact: true }).click()
    await page.getByRole("button", { name: "收起项目步骤", exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).finish()
      ;(window as unknown as FixtureWindow).defer = false
    })
    await page.getByRole("button", { name: "选择项目步骤", exact: true }).click()
    assert.equal(await preview.count(), 0)
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).renderScope("other", "C:/other", true)
    )
    await page.getByLabel("选择节点所属项目").selectOption("project")
    const calls = await page.evaluate(() => (window as unknown as FixtureWindow).calls)
    assert(
      calls.some(
        ([kind, scope]) =>
          kind === "projects" && (scope as { threadId: string }).threadId === "other"
      )
    )
    assert.deepEqual(
      calls.find(([kind]) => kind === "board"),
      ["board", true]
    )
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify(
        { passed: true, host: "controlled API fixture with real intent", calls, intent },
        null,
        2
      )
    )
    console.log(
      "PASS native node selection, required lock, failure retry, closure preview, optional omission, scoped handoff, late cancellation and mobile"
    )
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
