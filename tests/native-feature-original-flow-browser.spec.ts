/** Production feature detail in real React/browser; controlled runtime/API fixtures only. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const renderer = resolve("src/renderer/src")
const entry = resolve(renderer, "components/harness-board/HarnessBoardView.tsx")

async function main() {
  const output = resolve("output", `native-feature-original-flow-browser-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const bundled = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
      import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import{FeatureDetailPage}from${JSON.stringify(entry)};
      const root=createRoot(document.getElementById('root')),calls=[];
      const nodes=[{id:'collect',label:'整理资料',nodeStatus:'not_started',status:{label:'未开始',uiKind:'unknown'},artifacts:[],hooks:[]}];
      let current={project:{projectId:'container',name:'原项目',projectRootPath:'C:/container'},
        nativeBinding:{engine:'host',hostRunId:'run-a',projectId:'container',featureId:'request-a',workspace:'C:/isolated',repositoryWorkspace:'C:/source',installedPluginId:'plugin',packageDigest:'a'.repeat(64)},
        workflow:{display:{mode:'ordered_nodes'},nodes:nodes.map(n=>({...n,states:[]}))},
        run:{slug:'request-a',title:'需求A',currentNodeId:'collect',nodes,featureStatus:'pending',skipNodeAvailable:false,selectedDeployUnits:[],resolvedSessionWorkspacePath:'C:/source'},
        adapterSnapshot:{mock:false},sessions:[]};
      let settle,holdContinue=false,continuation;
      const nativeView=()=>({project:{projectId:'run-a',name:'需求A',goal:'整理供应商资料并核对缺项',workspace:'C:/isolated',pluginDigest:'a'.repeat(64),version:1,stageIndex:0,status:'active',
        manifest:{stages:[{id:'collect',title:'整理资料',approval:'human',resultApproval:'none'}]}},operations:[{operationId:'op-a',stageId:'collect',expectedVersion:1,inputFingerprint:'fingerprint-a',status:'started'}]});
      window.api={builtinRobot:{getStatus:async()=>({settings:{enabled:false},connectionState:'offline',identityState:'unknown'}),onStatus:()=>()=>{},getRemoteAccess:async()=>({featureGrants:[],threadGrants:[]}),onRemoteAccessChanged:()=>()=>{}},
        workspace:{cancelGitPanelReads:async()=>{}},appNotifications:{list:async()=>[],onChanged:()=>()=>{}},mods:{onConfigurationChanged:()=>()=>{}},
        harnessBoard:{getManagedRunEvents:async()=>({events:[],hasMore:false}),
          startManagedRun:async()=>{throw Error('LEGACY_DRIVER_FORBIDDEN')},validateManagedRunStart:async()=>{throw Error('LEGACY_DRIVER_FORBIDDEN')},
          nativeFeatureMods:{read:async()=>{
            if(current.nativeProject?.operations.some(operation=>operation.status==='started')) throw Error('PROJECT_OPERATION_UNSETTLED');
            return {projectId:'run-a',projectVersion:current.nativeProject?.project.version??0,packageDigest:'a'.repeat(64),workspace:'C:/isolated',dependencies:[],globallyEnabled:true,workspaceEnabled:true}
          }},
          nativeFeatureCommand:async(projectId,featureId,command)=>{
            calls.push({projectId,featureId,command});
            if(command.kind==='start-feature') {current={...current,nativeProject:nativeView()};await new Promise(resolve=>settle=resolve)}
            if(command.kind==='continue'&&holdContinue) {current={...current,nativeProject:nativeView()};await new Promise(resolve=>settle=resolve)}
            if(command.kind==='cancel') {current={...current,nativeProject:{...current.nativeProject,operations:[{...current.nativeProject.operations[0],status:'cancelled'}]}};settle()}
            return structuredClone({...current.nativeProject,...(command.kind==='continue'&&continuation?{continuation}: {})});
          },getRunDetail:async()=>structuredClone(current)}};
      function Fixture(){const[detail,setDetail]=useState(current);window.stageFixture={calls,setContinuation:value=>continuation=value,setHoldContinue:value=>holdContinue=value,refresh:()=>setDetail(structuredClone(current)),
        setOperation:operation=>{const view=nativeView();current={...current,nativeProject:{...view,operations:[{...view.operations[0],...operation}]}};calls.length=0;setDetail(structuredClone(current))}};
        return <div style={{height:'100vh'}}><FeatureDetailPage detail={detail} loading={false} isViewingSession={false}
          onBackToList={()=>{}} onBackToProject={()=>{}} onEditDeployUnits={()=>{}}
          onRefresh={()=>setDetail(structuredClone(current))} onFeatureImManagementSaved={()=>{}}/></div>}
      root.render(<Fixture/>);
    `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".png": "dataurl", ".md": "text" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined"
    },
    plugins: [
      {
        name: "feature-detail-test-entry",
        setup(builder) {
          builder.onLoad({ filter: /HarnessBoardView\.tsx$/ }, () => ({
            loader: "tsx",
            resolveDir: dirname(entry),
            contents: readFileSync(entry, "utf8") + "\nexport { FeatureDetailPage }\n"
          }))
          builder.onResolve({ filter: /(?:^|\/)thread-context$/ }, () => ({
            path: "thread-context",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            contents:
              args.path === "thread-context"
                ? `
            const empty={};export const useThreadContext=()=>({getAllStreamLoadingStates:()=>empty,getThreadStateSummaries:()=>empty});
            export const useThreadStateSummaries=()=>empty,useAllStreamLoadingStates=()=>empty,useAllThreadStates=()=>empty;
            export const useThreadStateSelector=()=>null,useThreadState=()=>null,useThreadActions=()=>null,useCurrentThread=()=>empty,useThreadStream=()=>empty;
            export const ThreadProvider=({children})=>children,THREAD_MESSAGE_RESIDENT_LIMIT=1500,THREAD_MESSAGE_PROTECTED_TAIL=320;
          `
                : `
            const state={accountRevision:0,threads:[],models:[],installedPlugins:[],createThread:async()=>({thread_id:'unused'}),selectThread:async()=>{}};
            export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state;useAppStore.subscribe=()=>()=>{};
            export const isThreadDeletionPending=()=>false,isThreadRetired=()=>false;
          `
          }))
        }
      },
      browserWorkerPlugin()
    ]
  })
  const cssEntry = resolve(renderer, "index.css")
  const compiler = await compile(readFileSync(cssEntry, "utf8"), {
    base: renderer,
    from: cssEntry,
    onDependency() {
      return undefined
    }
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "components/harness-board/HarnessBoardView.tsx",
      "components/harness-board/NativeFeatureReview.tsx",
      "components/harness-board/ProjectFunctionConsent.tsx",
      ...readdirSync(resolve(renderer, "components/ui"))
        .filter((name) => name.endsWith(".tsx"))
        .map((name) => `components/ui/${name}`)
    ].map((name) => ({ content: readFileSync(resolve(renderer, name), "utf8"), extension: "tsx" }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const errors: string[] = [],
    checks: string[] = []
  let failure = ""
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  page.setDefaultTimeout(10000)
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (message: string) => {
    checks.push(message)
    console.log("PASS " + message)
  }
  try {
    await page.route("https://harness.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>'
      })
    )
    await page.goto("https://harness.test/")
    await page.addStyleTag({ content: compiler.build(candidates) })
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole("button", { name: "托管运行当前特性", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "开启托管运行", exact: true })
    await dialog.waitFor()
    await dialog
      .getByRole("textbox", { name: "启动会话的初始用户消息" })
      .fill("整理供应商资料并核对缺项")
    await dialog.getByRole("button", { name: "确认并开启托管", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "停止托管运行", exact: true }).waitFor()
    assert(
      await page.getByRole("button", { name: "停止托管运行", exact: true }).isEnabled(),
      "stop remains usable while continue IPC is pending"
    )
    await page.screenshot({ path: resolve(output, "original-feature-running.png"), fullPage: true })
    await page.getByRole("button", { name: "停止托管运行", exact: true }).click()
    await page.getByRole("button", { name: "托管运行当前特性", exact: true }).waitFor()
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "托管运行当前特性" && !button.disabled
      )
    )
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), [
      {
        projectId: "container",
        featureId: "request-a",
        command: { kind: "start-feature", initialUserMessage: "整理供应商资料并核对缺项" }
      },
      {
        projectId: "container",
        featureId: "request-a",
        command: { kind: "cancel", operationId: "op-a" }
      }
    ])
    assert.equal(await page.getByRole("button", { name: "开始当前阶段", exact: true }).count(), 0)
    assert.equal(await page.locator('[data-stage-node="collect"]').count(), 1)
    assert.deepEqual(errors, [])
    pass(
      "original feature controls start real bound engine and can cancel during pending execution; no legacy or standalone driver"
    )
    await page.evaluate(
      "window.stageFixture.setHoldContinue(true);window.stageFixture.setOperation({status:'prepared'})"
    )
    await page.getByRole("button", { name: "批准并执行", exact: true }).click()
    await page.waitForFunction("window.stageFixture.calls.length === 2")
    assert.deepEqual(
      await page.evaluate("window.stageFixture.calls.map(item=>item.command.kind)"),
      ["approve", "continue"]
    )
    const stopAfterApproval = page.getByRole("button", { name: "停止托管运行", exact: true })
    await stopAfterApproval.waitFor()
    assert(await stopAfterApproval.isEnabled(), "stage approval continuation remains stoppable")
    await stopAfterApproval.click()
    await page.waitForFunction("window.stageFixture.calls.length === 3")
    assert.equal(await page.evaluate("window.stageFixture.calls[2].command.kind"), "cancel")
    await page.evaluate("window.stageFixture.setHoldContinue(false)")
    await page.evaluate(
      "window.stageFixture.setContinuation({reason:'blocked',error:'验收配置缺失'})"
    )
    await page.evaluate(
      "window.stageFixture.setOperation({status:'succeeded',resultApproval:{decision:'rejected',feedback:'补充证据'}})"
    )
    await page.getByRole("button", { name: "重新执行当前步骤", exact: true }).click()
    await page.waitForFunction("window.stageFixture.calls.length === 3")
    assert.deepEqual(
      await page.evaluate("window.stageFixture.calls.map(item=>item.command.kind)"),
      ["cancel", "prepare", "continue"]
    )
    assert.equal(
      await page.evaluate("window.stageFixture.calls[1].command.stageInstructions"),
      "补充证据"
    )
    await page.getByRole("status").filter({ hasText: "验收配置缺失" }).waitFor()
    await page.evaluate("window.stageFixture.refresh()")
    await page.getByRole("status").filter({ hasText: "验收配置缺失" }).waitFor()
    assert.deepEqual(errors, [])
    pass(
      "stage consent resumes continuous execution; rejected result retries retain feedback and settle old operation"
    )
  } catch (error) {
    failure = String(error)
    console.error({ errors, body: await page.locator("body").innerText() })
    throw error
  } finally {
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          scope:
            "Production FeatureDetailPage and real browser interactions with controlled runtime/API fixtures",
          checks,
          errors,
          failure,
          complete: !failure && !errors.length
        },
        null,
        2
      )
    )
    console.log("Evidence: " + output)
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
