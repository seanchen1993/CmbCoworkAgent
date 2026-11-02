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
      let current={project:{projectId:'container',name:'原项目',projectRootPath:'C:/container',lifecycle:{status:'active'}},
        nativeBinding:{engine:'host',hostRunId:'run-a',projectId:'container',featureId:'request-a',workspace:'C:/source',repositoryWorkspace:'C:/source',workspaceMode:'selected-directory',workspaceIdentity:'initial',repositoryWorkspaceIdentity:'initial',installedPluginId:'plugin'},
        workflow:{display:{mode:'ordered_nodes'},nodes:nodes.map(n=>({...n,states:[]}))},
        run:{slug:'request-a',title:'需求A',currentNodeId:'collect',nodes,featureStatus:'pending',skipNodeAvailable:false,selectedDeployUnits:[],resolvedSessionWorkspacePath:'C:/source'},
        adapterSnapshot:{mock:false},sessions:[]};
      let settle,holdContinue=false,continuation;
      const readiness={'C:/source':false,'C:/isolated':true},sourceReads=[],directorySelections=[],reviewScopes=[],configReads=[],configSaves=[],navigation=[],editRequests=[],selectedHistoryThreads=[],historySurfaces=[];
      const configValues={},configRevisions={};let configurationEnabled=false,holdNextReview=false,releaseReview,releasedReviews=0,applicationEnabled=true,configurationReady=true,holdApproval=false,releaseApproval,approvalReleases=0;
      const configuration=workspace=>({pluginId:'provider',plugin:'受控执行能力',digest:'b'.repeat(64),workspace,
        savedRevision:configRevisions[workspace]??0,state:'inactive',fields:[{key:'note',label:'目录备注',description:'受控测试参数',type:'string',supported:true,required:false,value:configValues[workspace]??'stored:'+workspace}]});
      const nativeView=()=>({project:{projectId:'run-a',name:'需求A',goal:'整理供应商资料并核对缺项',workspace:'C:/isolated',pluginDigest:'a'.repeat(64),version:1,stageIndex:0,status:'active',
        manifest:{stages:[{id:'collect',title:'整理资料',approval:'human',resultApproval:'none'}]}},operations:[{operationId:'op-a',stageId:'collect',expectedVersion:1,inputFingerprint:'fingerprint-a',status:'started'}]});
      window.api={builtinRobot:{getStatus:async()=>({settings:{enabled:false},connectionState:'offline',identityState:'unknown'}),onStatus:()=>()=>{},getRemoteAccess:async()=>({featureGrants:[],threadGrants:[]}),onRemoteAccessChanged:()=>()=>{}},
        workspace:{cancelGitPanelReads:async()=>{},onFilesChanged:()=>()=>{},getGitChangedFilesSummary:async()=>({success:true,isWorktree:false,isGitRepo:false,taskId:'history-thread',files:[],changedFilesTotal:0,omittedFileCount:0,hasPendingDiff:false}),select:async()=>{directorySelections.push('C:/isolated');return 'C:/isolated'}},appNotifications:{list:async()=>[],onChanged:()=>()=>{}},mods:{onConfigurationChanged:()=>()=>{}},
        harnessBoard:{getManagedRunEvents:async()=>({events:[],hasMore:false}),
          startManagedRun:async()=>{throw Error('LEGACY_DRIVER_FORBIDDEN')},validateManagedRunStart:async()=>{throw Error('LEGACY_DRIVER_FORBIDDEN')},
          nativeFeatureMods:{config:{
            userConfig:async(threadId,pluginId,expectedWorkspace)=>{configReads.push({threadId,pluginId,expectedWorkspace,identity:current.nativeBinding.workspaceIdentity});
              if(expectedWorkspace!==current.nativeBinding.workspace)throw Error('WRONG_CONFIG_SCOPE');return configuration(expectedWorkspace)},
            saveUserConfig:async(threadId,view,key,value)=>{if(view.workspace!==current.nativeBinding.workspace||view.digest!=='b'.repeat(64)||view.savedRevision!==(configRevisions[view.workspace]??0))throw Error('STALE_CONFIG_TARGET');
              configValues[view.workspace]=value;configRevisions[view.workspace]=(configRevisions[view.workspace]??0)+1;configSaves.push({threadId,workspace:view.workspace,key,value});return configuration(view.workspace)}
          },read:async()=>{
            const active=current.nativeProject;
            if(active?.operations.some(operation=>operation.stageId===active.project.manifest.stages[active.project.stageIndex]?.id&&operation.expectedVersion===active.project.version&&operation.status==='started')) throw Error('PROJECT_OPERATION_UNSETTLED');
            const workspace=current.nativeBinding.workspace,workspaceEnabled=readiness[workspace];
            sourceReads.push({workspace,workspaceEnabled});
            const held=holdNextReview;holdNextReview=false;reviewScopes.push({workspace,identity:current.nativeBinding.workspaceIdentity,held});
            const captured={projectId:'run-a',projectVersion:current.nativeProject?.project.version??0,packageDigest:'a'.repeat(64),workspace,dependencies:[],globallyEnabled:applicationEnabled,workspaceEnabled,approvalAtProject:true,
              source:{pluginId:'provider',name:'受控执行能力',digest:'b'.repeat(64),state:'ready',capabilities:['fs.read'],scannedMethods:[],scanIncomplete:false,configurationReady,hasConfiguration:configurationEnabled||!configurationReady}};
            if(held)return new Promise(resolve=>releaseReview=()=>{releasedReviews++;resolve(captured)});
            return captured
          }},
          nativeFeatureCommand:async(projectId,featureId,command)=>{
            calls.push({projectId,featureId,command});
            if(command.kind==='approve'&&holdApproval)await new Promise(resolve=>releaseApproval=()=>{holdApproval=false;approvalReleases++;resolve()});
            if(command.kind==='start-feature') {current={...current,nativeBinding:{...current.nativeBinding,workspace:command.workspacePath,initialUserMessage:command.initialUserMessage},nativeProject:nativeView()};await new Promise(resolve=>settle=resolve)}
            if(command.kind==='continue'&&holdContinue) {current={...current,nativeProject:nativeView()};await new Promise(resolve=>settle=resolve)}
            if(command.kind==='cancel') {const operation=current.nativeProject.operations.find(item=>item.operationId===command.operationId);
              if(!operation||operation.status==='unknown')throw Error('INVALID_CANCELLATION_TARGET');
              current={...current,nativeProject:{...current.nativeProject,operations:current.nativeProject.operations.map(item=>item.operationId===command.operationId?{...item,status:'cancelled'}:item)}};settle?.()}
            return structuredClone({...current.nativeProject,...(command.kind==='continue'&&continuation?{continuation}: {})});
          },getRunDetail:async()=>structuredClone(current)}};
      function Fixture(){const[detail,setDetail]=useState(current),[epoch,setEpoch]=useState(0);window.stageFixture={calls,sourceReads,directorySelections,reviewScopes,configReads,configSaves,navigation,editRequests,selectedHistoryThreads,historySurfaces,binding:()=>structuredClone(current.nativeBinding),operations:()=>structuredClone(current.nativeProject?.operations??[]),
        holdReview:()=>holdNextReview=true,releaseReview:()=>releaseReview(),releasedReviews:()=>releasedReviews,
        holdApproval:()=>holdApproval=true,releaseApproval:()=>releaseApproval(),releasedApprovals:()=>approvalReleases,
        setUnstartedScope:(workspace,identity,enabled)=>{configurationEnabled=true;readiness[workspace]=enabled;const{nativeProject,...unstarted}=current;
          current={...unstarted,nativeBinding:{...unstarted.nativeBinding,workspace,repositoryWorkspace:workspace,workspaceMode:'selected-directory',workspaceIdentity:identity,repositoryWorkspaceIdentity:identity,worktree:undefined,initialUserMessage:undefined},run:{...unstarted.run,resolvedSessionWorkspacePath:workspace}};setDetail(structuredClone(current))},
        pinReadinessScope:()=>{current={...current,nativeBinding:{...current.nativeBinding,initialUserMessage:'固定当前目录以观察就绪门禁'}};setDetail(structuredClone(current))},
        setSourceReady:value=>{readiness[current.nativeBinding.workspace]=value;setEpoch(value=>value+1)},
        setHistoricalWorktree:()=>{const{nativeProject,...historical}=current;current={...historical,nativeBinding:{...historical.nativeBinding,workspaceMode:undefined,initialUserMessage:undefined,worktree:{root:'C:/isolated'}}};setDetail(structuredClone(current));setEpoch(value=>value+1)},
        setHistoricalUnstarted:()=>{const{nativeProject,...historical}=current;applicationEnabled=true;configurationReady=true;readiness['C:/isolated']=true;current={...historical,nativeBinding:{...historical.nativeBinding,workspaceMode:undefined,initialUserMessage:undefined,worktree:undefined}};setDetail(structuredClone(current));setEpoch(value=>value+1)},
        setStopState:(status,history=true,notReady=true)=>{applicationEnabled=!notReady;configurationReady=!notReady;readiness['C:/isolated']=!notReady;
          const view=nativeView(),operation={...view.operations[0],operationId:'current-'+status,status};
          const historical=history?[{...operation,operationId:'old-stage',stageId:'previous',status:'started'},{...operation,operationId:'old-version',expectedVersion:0,status:'succeeded'}]:[];
          current={...current,project:{...current.project,lifecycle:{status:'active'}},nativeBinding:{...current.nativeBinding,workspace:'C:/isolated',workspaceMode:'selected-directory',initialUserMessage:view.project.goal},nativeProject:{...view,operations:[...historical,operation]}};calls.length=0;setDetail(structuredClone(current));setEpoch(value=>value+1)},
        setArchivedHistory:(cancelled=false)=>{const view=nativeView();current={...current,project:{...current.project,lifecycle:{status:'archived'}},
          nativeBinding:{...current.nativeBinding,initialUserMessage:view.project.goal},nativeProject:{...view,operations:[{...(cancelled?current.nativeProject.operations.at(-1):view.operations[0]),status:cancelled?'cancelled':'prepared'}],inputWait:{operationId:'op-a',requestId:'past-request',threadId:'history-thread',status:'waiting',resumable:true}},
          sessions:[{projectId:'container',slug:'request-a',threadId:'history-thread',source:'host',createdAt:'2026-11-01T00:00:00Z',lastActiveAt:'2026-11-01T00:00:00Z'}]};if(!cancelled)calls.length=0;setDetail(structuredClone(current))},
        setContinuation:value=>continuation=value,setHoldContinue:value=>holdContinue=value,refresh:()=>setDetail(structuredClone(current)),
        setOperation:operation=>{const view=nativeView();current={...current,nativeProject:{...view,operations:[{...view.operations[0],...operation}]}};calls.length=0;setDetail(structuredClone(current))}};
        return <div style={{height:'100vh'}}><FeatureDetailPage key={epoch} detail={detail} loading={false} isViewingSession={false}
          onBackToList={()=>{}} onBackToProject={()=>navigation.push('project')} onEditDeployUnits={()=>editRequests.push(current.nativeBinding.workspace)}
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
          builder.onResolve({ filter: /^@\/components\/tabs$/ }, () => ({
            path: "history-chat",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              args.path === "history-chat"
                ? `import React from 'react';export function TabbedPanel({threadId,readOnlyReason}){
                  window.stageFixture.historySurfaces.push({threadId,readOnlyReason});
                  return React.createElement('section',{'aria-label':'历史会话边界'},
                    React.createElement('p',null,'历史会话 '+threadId),
                    React.createElement('p',{role:'status'},readOnlyReason),
                    React.createElement('textarea',{'aria-label':'历史聊天只读边界',readOnly:!!readOnlyReason,defaultValue:'原会话内容'}))}`
                : args.path === "thread-context"
                  ? `
            const empty={};export const useThreadContext=()=>({getAllStreamLoadingStates:()=>empty,getThreadStateSummaries:()=>empty});
            export const useThreadStateSummaries=()=>empty,useAllStreamLoadingStates=()=>empty,useAllThreadStates=()=>empty;
            export const useThreadStateSelector=()=>null,useThreadState=()=>null,useThreadActions=()=>null,useCurrentThread=()=>empty,useThreadStream=()=>empty;
            export const ThreadProvider=({children})=>children,THREAD_MESSAGE_RESIDENT_LIMIT=1500,THREAD_MESSAGE_PROTECTED_TAIL=320;
          `
                  : `
            const state={accountRevision:0,threads:[{thread_id:'history-thread',title:'归档历史会话',metadata:{workspacePath:'C:/isolated',harnessFeature:{projectId:'container',slug:'request-a'}}}],models:[],installedPlugins:[],createThread:async()=>{throw Error('UNEXPECTED_NEW_THREAD')},selectThread:async id=>{window.stageFixture.selectedHistoryThreads.push(id)}};
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
    await page
      .getByText("当前目录的插件功能已关闭，请在插件设置中恢复后重新核对。", { exact: true })
      .waitFor()
    assert.equal(
      await page.getByRole("button", { name: "项目能力", exact: true }).count(),
      0,
      "A mature project uses its original controls without a second composition entry"
    )
    assert.deepEqual(await page.evaluate("window.stageFixture.sourceReads[0]"), {
      workspace: "C:/source",
      workspaceEnabled: false
    })
    assert(
      await page.getByRole("button", { name: "托管运行当前特性", exact: true }).isEnabled(),
      "The first selected-directory run can open its original picker before default-scope readiness"
    )
    await page.getByRole("button", { name: "托管运行当前特性", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "开启托管运行", exact: true })
    await dialog.waitFor()
    assert.equal(
      await dialog.getByRole("textbox", { name: "会话工作区", exact: true }).inputValue(),
      "C:/source"
    )
    assert(await dialog.getByRole("textbox", { name: "会话工作区", exact: true }).isEnabled())
    await dialog.getByRole("textbox", { name: "会话工作区", exact: true }).click()
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('[aria-label="会话工作区"]')?.value ===
        "C:/isolated"
    )
    await page.screenshot({
      path: resolve(output, "first-run-selected-directory.png"),
      fullPage: true
    })
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.deepEqual(
      await page.evaluate("window.stageFixture.calls"),
      [],
      "Selecting a different directory then canceling must not call any execution command"
    )
    assert.equal(
      await page.evaluate("window.stageFixture.binding().workspace"),
      "C:/source",
      "A canceled UI selection does not replace the registered default directory"
    )
    pass(
      "first-run directory selection remains available when default-scope execution is off; cancel sends no command"
    )

    await page.getByRole("button", { name: "托管运行当前特性", exact: true }).click()
    await dialog.waitFor()
    assert.equal(
      await dialog.getByRole("textbox", { name: "会话工作区", exact: true }).inputValue(),
      "C:/source",
      "Reopening after cancellation restores the original default directory"
    )
    await dialog.getByRole("textbox", { name: "会话工作区", exact: true }).click()
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>('[aria-label="会话工作区"]')?.value ===
        "C:/isolated"
    )
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
        command: {
          kind: "start-feature",
          initialUserMessage: "整理供应商资料并核对缺项",
          workspacePath: "C:/isolated"
        }
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

    const fixedCalls = await page.evaluate("window.stageFixture.calls")
    const selections = await page.evaluate("window.stageFixture.directorySelections")
    await page.getByRole("button", { name: "托管运行当前特性", exact: true }).click()
    await dialog.waitFor()
    const fixedDirectory = dialog.getByRole("textbox", { name: "会话工作区", exact: true })
    assert.equal(await fixedDirectory.inputValue(), "C:/isolated")
    assert(
      await fixedDirectory.isDisabled(),
      "An existing run keeps its confirmed execution directory"
    )
    await dialog.getByRole("button", { name: "取消", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert(await page.getByRole("button", { name: "编辑特性配置", exact: true }).isDisabled())
    await page.getByLabel("特性配置修改限制", { exact: true }).hover()
    await page.getByRole("tooltip").filter({ hasText: "默认会话目录已固定" }).waitFor()
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), fixedCalls)
    assert.deepEqual(await page.evaluate("window.stageFixture.directorySelections"), selections)
    await page.evaluate("window.stageFixture.setSourceReady(false)")
    await page
      .getByText("当前目录的插件功能已关闭，请在插件设置中恢复后重新核对。", { exact: true })
      .waitFor()
    assert(
      await page.getByRole("button", { name: "托管运行当前特性", exact: true }).isDisabled(),
      "A fixed run must still pass its current execution-scope readiness gate"
    )
    assert.equal(await dialog.count(), 0)
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), fixedCalls)
    assert.deepEqual(await page.evaluate("window.stageFixture.directorySelections"), selections)
    assert.equal(await page.evaluate("window.stageFixture.binding().workspace"), "C:/isolated")
    await page.screenshot({ path: resolve(output, "fixed-run-not-ready.png"), fullPage: true })
    pass(
      "fixed runs retain the execution directory and remain blocked when that scope is not ready"
    )

    await page.evaluate("window.stageFixture.setHistoricalWorktree()")
    await page
      .getByText("当前目录的插件功能已关闭，请在插件设置中恢复后重新核对。", { exact: true })
      .waitFor()
    assert(
      await page.getByRole("button", { name: "托管运行当前特性", exact: true }).isDisabled(),
      "Historical worktree bindings must not acquire the first selected-directory picker exception"
    )
    assert.equal(await dialog.count(), 0)
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), fixedCalls)
    assert.deepEqual(await page.evaluate("window.stageFixture.directorySelections"), selections)
    assert.deepEqual(errors, [])
    pass(
      "historical worktree fixtures keep their existing readiness gate without changing directories"
    )

    const permission = page.getByRole("region", { name: "本包功能权限", exact: true })
    const settings = permission.locator(":scope > details")
    const openConfiguration = async () => {
      await settings.locator(":scope > summary").waitFor()
      if (!(await settings.evaluate((element) => (element as HTMLDetailsElement).open)))
        await settings.locator(":scope > summary").click()
      const editor = permission.locator('[data-function-user-config="provider"]')
      if (!(await editor.evaluate((element) => (element as HTMLDetailsElement).open)))
        await editor.locator(":scope > summary").click()
      await editor.getByRole("textbox", { name: "目录备注", exact: true }).waitFor()
      return editor
    }
    await page.evaluate("window.stageFixture.setUnstartedScope('C:/review-a','scope-a1',true)")
    await page.waitForFunction(
      "window.stageFixture.reviewScopes.some(scope=>scope.workspace==='C:/review-a'&&scope.identity==='scope-a1')"
    )
    const firstEditor = await openConfiguration()
    await firstEditor.getByRole("textbox", { name: "目录备注", exact: true }).fill("A的未保存草稿")
    await page.evaluate("window.stageFixture.setUnstartedScope('C:/review-b','scope-b1',true)")
    await page.waitForFunction(
      "window.stageFixture.reviewScopes.some(scope=>scope.workspace==='C:/review-b'&&scope.identity==='scope-b1')"
    )
    const secondEditor = await openConfiguration()
    const note = secondEditor.getByRole("textbox", { name: "目录备注", exact: true })
    assert.equal(
      await note.inputValue(),
      "stored:C:/review-b",
      "Changing an unstarted Feature directory must not retain another directory's parameter draft"
    )
    assert.match(
      await secondEditor.getByLabel("参数配置目标", { exact: true }).innerText(),
      /C:\/review-b/
    )
    await note.fill("B目录的新参数")
    await note.locator("xpath=../..").getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction("window.stageFixture.configSaves.length===1")
    assert.deepEqual(await page.evaluate("window.stageFixture.configSaves[0]"), {
      threadId: "run-a",
      workspace: "C:/review-b",
      key: "note",
      value: "B目录的新参数"
    })
    assert.equal(
      await page.evaluate("window.stageFixture.configReads.at(-1).expectedWorkspace"),
      "C:/review-b"
    )
    pass(
      "unstarted directory edits re-read scope and the real parameter editor loads and saves only the new directory"
    )

    const readsBeforeIdentityChange = await page.evaluate("window.stageFixture.reviewScopes.length")
    await page.evaluate("window.stageFixture.setUnstartedScope('C:/review-b','scope-b2',true)")
    await page.waitForFunction((previous) => {
      const fixture = (
        window as unknown as { stageFixture: { reviewScopes: Array<{ identity: string }> } }
      ).stageFixture
      return (
        fixture.reviewScopes.length > previous &&
        fixture.reviewScopes.at(-1)?.identity === "scope-b2"
      )
    }, readsBeforeIdentityChange)
    await openConfiguration()
    assert.equal(await page.evaluate("window.stageFixture.configReads.at(-1).identity"), "scope-b2")
    assert.equal(
      await page.evaluate("window.stageFixture.configReads.at(-1).expectedWorkspace"),
      "C:/review-b"
    )
    await page.screenshot({
      path: resolve(output, "edited-directory-parameter-target.png"),
      fullPage: true
    })
    pass(
      "a physical identity change at the same unstarted path re-reads consent and parameter scope"
    )

    for (const oldReady of [false, true]) {
      const nextReady = !oldReady
      const releasedBefore = await page.evaluate("window.stageFixture.releasedReviews()")
      await page.evaluate(
        ({ oldReady }) => {
          const fixture = (
            window as unknown as {
              stageFixture: {
                holdReview(): void
                setUnstartedScope(workspace: string, identity: string, enabled: boolean): void
              }
            }
          ).stageFixture
          fixture.holdReview()
          fixture.setUnstartedScope("C:/review-a", `late-a-${oldReady}`, oldReady)
        },
        { oldReady }
      )
      await page.waitForFunction((identity) => {
        const fixture = (
          window as unknown as {
            stageFixture: { reviewScopes: Array<{ identity: string; held: boolean }> }
          }
        ).stageFixture
        return fixture.reviewScopes.some((scope) => scope.identity === identity && scope.held)
      }, `late-a-${oldReady}`)
      await page.evaluate(
        ({ nextReady }) => {
          const fixture = (
            window as unknown as {
              stageFixture: {
                setUnstartedScope(workspace: string, identity: string, enabled: boolean): void
              }
            }
          ).stageFixture
          fixture.setUnstartedScope("C:/review-b", `settled-b-${nextReady}`, nextReady)
        },
        { nextReady }
      )
      await page.waitForFunction((ready) => {
        const summary = document.querySelector(
          'section[aria-label="本包功能权限"] > details > summary'
        )
        return summary?.textContent?.includes(ready ? "已就绪" : "待完成") === true
      }, nextReady)
      await page.evaluate("window.stageFixture.pinReadinessScope()")
      const manage = page.getByRole("button", { name: "托管运行当前特性", exact: true })
      assert.equal(
        await manage.isEnabled(),
        nextReady,
        "The fixed readiness gate must reflect the newer completed B review"
      )
      await page.evaluate("window.stageFixture.releaseReview()")
      await page.waitForFunction(
        (previous) =>
          (
            window as unknown as { stageFixture: { releasedReviews(): number } }
          ).stageFixture.releasedReviews() > previous,
        releasedBefore
      )
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      assert.equal(
        await manage.isEnabled(),
        nextReady,
        "A late A result may neither clear a ready B scope nor enable a blocked B scope"
      )
      assert.match(
        await settings.locator(":scope > summary").innerText(),
        nextReady ? /已就绪/ : /待完成/
      )
      assert.equal(await page.evaluate("window.stageFixture.binding().workspace"), "C:/review-b")
    }
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), fixedCalls)
    assert.deepEqual(errors, [])
    pass(
      "late reviews from the previous directory cannot clear or enable the newer completed scope"
    )

    for (const status of ["prepared", "succeeded"]) {
      await page.evaluate((status) => {
        ;(
          window as unknown as { stageFixture: { setStopState(status: string): void } }
        ).stageFixture.setStopState(status)
      }, status)
      await page.getByRole("alert").filter({ hasText: "应用插件功能已关闭" }).waitFor()
      await page.getByRole("alert").filter({ hasText: "请先补齐上方必填参数" }).waitFor()
      const stop = page.getByRole("button", { name: "停止托管运行", exact: true })
      assert(
        await stop.isEnabled(),
        "Approval states remain stoppable with invalid configuration and disabled switches"
      )
      await stop.click()
      await page.waitForFunction("window.stageFixture.calls.length===1")
      assert.deepEqual(await page.evaluate("window.stageFixture.calls[0].command"), {
        kind: "cancel",
        operationId: `current-${status}`
      })
      const operations = (await page.evaluate("window.stageFixture.operations()")) as Array<{
        operationId: string
        status: string
      }>
      assert.equal(
        operations.find((operation) => operation.operationId === `current-${status}`)?.status,
        "cancelled"
      )
      assert.equal(
        operations.find((operation) => operation.operationId === "old-stage")?.status,
        "started"
      )
      assert.equal(
        operations.find((operation) => operation.operationId === "old-version")?.status,
        "succeeded"
      )
      assert.equal(
        await stop.count(),
        0,
        "Historical stage/version operations must not keep the current stop action active"
      )
    }
    pass(
      "prepared and succeeded current operations stop with invalid config and disabled switches without cancelling historical operations"
    )

    await page.evaluate("window.stageFixture.setStopState('unknown',true,false)")
    await page.getByRole("button", { name: "核对执行结果", exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "停止托管运行", exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), [])
    pass(
      "unknown results retain reconciliation and do not select a historical operation for cancellation"
    )

    await page.evaluate("window.stageFixture.setStopState('prepared',false,false)")
    await page.getByRole("button", { name: "停止托管运行", exact: true }).click()
    await page.waitForFunction(
      "window.stageFixture.operations().every(operation=>operation.status==='cancelled')"
    )
    await page.locator("nav").getByRole("button", { name: "原项目", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.stageFixture.navigation"), ["project"])
    pass(
      "stopping a pending operation preserves original project navigation; backend lifecycle mutation is verified separately"
    )

    await page.evaluate("window.stageFixture.setHistoricalUnstarted()")
    const edit = page.getByRole("button", { name: "编辑特性配置", exact: true })
    assert(
      await edit.isEnabled(),
      "An unstarted historical binding without a worktree keeps its original edit entry"
    )
    await edit.click()
    assert.deepEqual(await page.evaluate("window.stageFixture.editRequests"), ["C:/isolated"])
    assert.deepEqual(errors, [])
    pass(
      "historical non-worktree unstarted bindings remain editable without requiring mode metadata"
    )

    await page.waitForFunction(() => {
      const summary = document.querySelector(
        'section[aria-label="本包功能权限"] > details > summary'
      )
      return summary?.textContent?.includes("已就绪") === true
    })
    const readsBeforeArchive = await page.evaluate("window.stageFixture.sourceReads.length")
    const configReadsBeforeArchive = await page.evaluate("window.stageFixture.configReads.length")
    await page.evaluate("window.stageFixture.setArchivedHistory()")
    await page.getByText("项目已归档，仅可查看历史记录。", { exact: true }).waitFor()
    assert(await page.getByRole("button", { name: "停止托管运行", exact: true }).isDisabled())
    assert(await page.getByRole("button", { name: "编辑特性配置", exact: true }).isDisabled())
    assert(await page.getByRole("button", { name: "新增会话", exact: true }).isDisabled())
    assert(await page.getByRole("button", { name: "继续执行", exact: true }).isDisabled())
    assert(await page.getByRole("button", { name: "批准并执行", exact: true }).isDisabled())
    assert.equal(
      await permission.count(),
      0,
      "Archived history must unmount active permission and parameter controls"
    )
    await page.getByRole("button", { name: "查看待答复的会话", exact: true }).click()
    const historicalChat = page.getByRole("region", { name: "历史会话边界", exact: true })
    await historicalChat.waitFor()
    assert.equal(
      await historicalChat
        .getByRole("textbox", { name: "历史聊天只读边界", exact: true })
        .isEditable(),
      false
    )
    await historicalChat.getByText("项目已归档，仅可查看历史会话。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "项目能力", exact: true }).count(), 0)
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.equal(await page.evaluate("window.stageFixture.sourceReads.length"), readsBeforeArchive)
    assert.equal(
      await page.evaluate("window.stageFixture.configReads.length"),
      configReadsBeforeArchive
    )
    assert.deepEqual(await page.evaluate("window.stageFixture.calls"), [])
    assert(
      (await page.evaluate("window.stageFixture.selectedHistoryThreads")).includes("history-thread")
    )
    assert.deepEqual(errors, [])
    pass(
      "archived native history disables mutations without permission reads and opens the existing conversation read-only through the original history button"
    )

    await page.evaluate(
      "window.stageFixture.setStopState('prepared',false,false);window.stageFixture.holdApproval()"
    )
    const approve = page.getByRole("button", { name: "批准并执行", exact: true })
    await approve.click()
    await page.waitForFunction(
      "window.stageFixture.calls.length===1&&window.stageFixture.calls[0].command.kind==='approve'"
    )
    const readsAtPendingArchive = await page.evaluate("window.stageFixture.sourceReads.length")
    const configReadsAtPendingArchive = await page.evaluate(
      "window.stageFixture.configReads.length"
    )
    await page.evaluate("window.stageFixture.setArchivedHistory(true)")
    await page.getByText("项目已归档，仅可查看历史记录。", { exact: true }).waitFor()
    assert.equal(await permission.count(), 0)
    await page.evaluate("window.stageFixture.releaseApproval()")
    await page.waitForFunction("window.stageFixture.releasedApprovals()===1")
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    assert.deepEqual(
      await page.evaluate("window.stageFixture.calls.map(call=>call.command.kind)"),
      ["approve"],
      "A late approval response must not dispatch the next continue command after archival"
    )
    assert.equal(await page.evaluate("window.stageFixture.operations()[0].status"), "cancelled")
    assert.equal(await permission.count(), 0)
    assert.equal(
      await page.evaluate("window.stageFixture.sourceReads.length"),
      readsAtPendingArchive
    )
    assert.equal(
      await page.evaluate("window.stageFixture.configReads.length"),
      configReadsAtPendingArchive
    )
    assert(await page.getByRole("button", { name: "托管运行当前特性", exact: true }).isDisabled())
    assert.deepEqual(errors, [])
    pass(
      "archival during a pending approval keeps the canceled historical ledger and ignores the late response without continuing execution or remounting consent"
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
            "Production FeatureDetailPage/NativeFeatureReview/parameter editor with controlled runtime/API fixtures; historical TabbedPanel is a read-only boundary probe, not real Composer/provider/backend authorization acceptance",
          checks,
          errors,
          failure,
          controlledObservations: await page
            .evaluate(
              "({sourceReads:window.stageFixture.sourceReads,directorySelections:window.stageFixture.directorySelections,calls:window.stageFixture.calls,reviewScopes:window.stageFixture.reviewScopes,configReads:window.stageFixture.configReads,configSaves:window.stageFixture.configSaves,navigation:window.stageFixture.navigation,editRequests:window.stageFixture.editRequests,selectedHistoryThreads:window.stageFixture.selectedHistoryThreads,historySurfaces:window.stageFixture.historySurfaces})"
            )
            .catch(() => undefined),
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
