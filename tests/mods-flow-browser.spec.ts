/** Real React/browser interactions against a controllable IPC fixture; no user/model data. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import JSZip from "jszip"
import { MODS_STARTER_FILES } from "../src/shared/mods/v2/starter-template"
import { resolve, join, relative } from "node:path"
import { build, type Plugin } from "esbuild"
import { chromium, type Browser, type Page } from "playwright"
import type { ClawProfile } from "../src/shared/mods/claw"
import type { FlowChatTask, FlowDefinition, FlowStep } from "../src/shared/mods/flows/types"

type FlowSaveCall = ["save", string, FlowDefinition, number]
type FlowStartCall = ["start", string, string, number, FlowChatTask]
interface FlowReadCounts {
  binding: number
  runs: number
  catalog: number
  list: number
}

const root = resolve(__dirname, "..")
const renderer = join(root, "src/renderer/src")
const source = (path: string) => JSON.stringify(join(renderer, path))
const checks: string[] = []
let acceptanceArtifacts: string | undefined
const pass = (text: string) => {
  checks.push(text)
  console.log("PASS " + text)
}
function outputFolder(name: string): string {
  assert(acceptanceArtifacts, "The standalone runner must initialize a fresh artifact directory")
  const path = join(acceptanceArtifacts, name)
  mkdirSync(path, { recursive: true })
  return path
}
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )

export async function mount(
  page: Page,
  body = "host.render(<FlowsPanel threadId='a'/>);",
  plugins: Plugin[] = []
) {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
      import {useState,useEffect,useRef} from "react";
      import {usePromptComposer} from ${source("lib/use-prompt-composer.ts")};
      import {useFunctionDesktop} from ${source("lib/use-function-desktop.ts")};
      import {submitAfterPromptEdit} from ${source("lib/prompt-edit-submission.ts")};
      import {PromptDecorations} from ${source("components/chat/PromptDecorations.tsx")};
      import {ClawSidebar,ClawComposerBar} from ${source("components/chat/ClawSidebar.tsx")};
      import {ClawSidebarHost} from ${source("components/panels/ClawSidebarHost.tsx")};
      import {publishClawNotice,openClawSidebar} from ${source("lib/claw-sidebar.ts")};
      window.publishClawNotice=publishClawNotice;
      import {useAppStore} from "@/lib/store";
      import {ScrollArea} from ${source("components/ui/scroll-area.tsx")};
      import {selectChatFlow} from  ${source("lib/chat-flow-choice.ts")};
      import {useChatFlow} from ${source("lib/use-chat-flow.ts")};
      import {ClawPanel} from ${source("components/customize/ClawPanel.tsx")};
      import {ChatFlowControls} from ${source("components/chat/ChatFlowControls.tsx")};
      import {createRoot} from "react-dom/client";
      import {FlowsPanel} from ${source("components/customize/FlowsPanel.tsx")};
      import {FlowTaskEntry} from ${source("components/chat/FlowTaskEntry.tsx")};
      import {FlowEditor} from ${source("components/customize/FlowEditor.tsx")};
      import {FlowRunView} from ${source("components/customize/FlowRunView.tsx")};
      import {ModsImportGuide} from ${source("components/customize/ModsImportGuide.tsx")};
      import {applyThemePreference} from ${source("lib/theme-preference.ts")};
      window.applyTestTheme=applyThemePreference;
      const host=createRoot(document.getElementById("root"));
      const listeners=new Map(), calls=[], runs=new Map();
      let saveFinish, readFinish, catalogFinish, deferSave=false, deferRead=false, deferCatalog=false, sequence=0;
      let viewReads=0,capturedSubmit=null,submitSettled=false;
      const definition=id=>({schemaVersion:1,id:"flow_"+id,name:"Flow "+id,plugin:"demo",goal:"Implement the task",
        timeoutMs:60000,maxExecutions:64,steps:[
          {id:"build",name:"编码",enabled:true,kind:"agent",prompt:"实现代码"},
          {id:"review",name:"评审",enabled:true,kind:"agent",prompt:"独立评审"},
          {id:"test",name:"测试",enabled:true,kind:"check",check:"unit-test"},
          {id:"accept",name:"确认",enabled:true,kind:"approval",prompt:"确认成果"}]});
      const saved=id=>({definition:definition(id),revision:1,digest:"digest-1",updatedAt:1});
      const definitions=new Map([['a',[saved('a')]],['b',[saved('b')]]]);
      const catalog={available:true,hostAvailable:true,plugins:[{id:"demo",name:"Demo Mod",authorized:true}],
        actions:[{pluginId:'plugin-a',plugin:'provider-a',digest:'a'.repeat(64),actionId:'review',name:'独立检视',command:'review',inputSchema:{type:'object'}},{pluginId:'plugin-b',plugin:'provider-b',digest:'b'.repeat(64),actionId:'test',name:'独立测试',command:'test',inputSchema:{type:'object'}}],
        agents:[{id:"review",name:"只读评审",description:"只读，禁止修改"}],models:[{id:"m2",name:"Model Two"}],
        features:[{id:"orders",checkpoint:"requirements_eval_in_progress"}]};
      const emit=id=>{for(const fn of listeners.get(id)||[])fn()};
      const configurationListeners=new Set();
      let profileView={workspace:'a',revision:0,bindingRevision:0,profiles:[],active:null,enabled:true,applicable:true,issues:[],capabilities:[{pluginId:'demo',name:'Demo',digest:'a'.repeat(64),state:'ready',capabilities:[]}]};
      let deferProfile=false, finishProfile, startBlocked=false;
      let sourcesFail=false;
      let sources={skills:[{id:'skill-a',name:'Review',digest:'a'.repeat(64),owner:'个人技能'},{id:'skill-b',name:'Review',digest:'b'.repeat(64),owner:'团队插件'}],mcp:[{id:'mcp-a',name:'Repository',digest:'c'.repeat(64),owner:'全局服务'}]};
      catalog.skills=sources.skills;
      let deferMcp=false,finishMcp;
      const mcpTools=[{provider:sources.mcp[0],toolName:'lookup',schemaDigest:'d'.repeat(64),description:'Lookup records',inputSchema:{type:'object',properties:{query:{type:'string'}}}},{provider:{...sources.mcp[0],id:'other-service',name:'Other'},toolName:'lookup',schemaDigest:'e'.repeat(64),inputSchema:{type:'object'},unavailableReason:'高级 schema 暂不支持'}];
      window.api={featureGates:{isEnabled:async()=>({enabled:false,reason:'fixture'})},mods:{
        completionPolicy:async()=>({source:"default",policy:{mode:"off",scope:"project",checks:["code-review"],maxRepairs:0,timeoutMs:120000,modelTokenBudget:8192}}),
        flowMcpTools:async id=>{calls.push(['mcpTools',id]);if(deferMcp){deferMcp=false;await new Promise(r=>finishMcp=r)}return structuredClone(mcpTools)},
        clawSources:async()=>{calls.push(['sources']);if(sourcesFail)throw Error('directory unavailable');return structuredClone(sources)},
        clawView:async()=>{viewReads++;const captured=structuredClone(profileView);if(deferProfile){deferProfile=false;await new Promise(r=>finishProfile=r)}return captured},
        clawChange:async(id,mutation)=>{calls.push(['claw',mutation]);if(mutation.revision!==profileView.revision)throw Error('stale revision');if(mutation.kind==='save')profileView.profiles=[mutation.profile];else profileView.active=mutation.id===null?null:profileView.profiles.find(p=>p.id===mutation.id);profileView.revision++;return structuredClone(profileView)},
        onConfigurationChanged:fn=>{configurationListeners.add(fn);return()=>configurationListeners.delete(fn)},
        clawStart:async(id,revision,goal)=>{calls.push(['clawStart',id,revision,goal]);if(revision!==profileView.bindingRevision)throw Error('binding changed');const run={id:'bound'+(++sequence),threadId:id,workspace:id,flow:structuredClone(profileView.active.flow),taskGoal:goal,status:'complete',startedAt:Date.now(),epoch:0,attempts:[],failureCounts:{}};runs.set(run.id,run);emit(id);return run},
        flowCatalog:async id=>{calls.push(['catalog',id]);if(deferCatalog){deferCatalog=false;await new Promise(r=>catalogFinish=r)}return {...catalog,workspace:id}},
        flowList:async id=>{calls.push(['list',id]);return definitions.get(id)||[]},
        flowRuns:async id=>{calls.push(['runs',id]);return [...runs.values()].filter(r=>r.threadId===id)},
        flowRun:async(id,key)=>{calls.push(['run',id,key]);if(deferRead){deferRead=false;await new Promise(r=>readFinish=r)}return runs.get(key)||null},
        flowSave:async(id,definition,revision)=>{calls.push(['save',id,definition,revision]);if(deferSave){deferSave=false;await new Promise(r=>saveFinish=r)}const value={definition,revision:revision+1,digest:'new',updatedAt:2};definitions.set(id,[value]);return value},
        flowStart:async(id,key,revision,task)=>{calls.push(['start',id,key,revision,task]);const flow=definitions.get(id).find(x=>x.definition.id===key);const run={id:'run'+(++sequence),threadId:id,workspace:id,flow,taskGoal:task?.goal,status:'waiting',startedAt:Date.now(),epoch:0,attempts:[],failureCounts:{},pendingApproval:{nonce:'nonce'+sequence,stepId:'accept',executionId:'e'+sequence,inputDigest:'input'+sequence,fingerprint:'fp',summary:'请确认真实测试结果',definitionDigest:flow.digest}};runs.set(run.id,run);emit(id);return run},
        flowDecide:async(id,key,nonce,approve)=>{calls.push(['decide',id,key,nonce,approve]);const run={...runs.get(key),status:approve?'complete':'failed',pendingApproval:undefined,summary:approve?'成果已确认':'人工拒绝'};runs.set(key,run);emit(id);return run},
        flowCancel:async(id,key)=>{calls.push(['cancel',id,key]);runs.set(key,{...runs.get(key),status:'cancelled',pendingApproval:undefined});emit(id)},
        onFlowChanged:(id,fn)=>{if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(fn);return()=>listeners.get(id).delete(fn)}
      }};
      let panelMounts=0,panelUnmounts=0;
      function Probe(){useEffect(()=>{panelMounts++;return()=>{panelUnmounts++}},[]);return <p>受控插件结果</p>}
      function ChatFixture({id,enabled=true,withChild=false}) {
        const flow=useChatFlow(id,id,enabled);
        const [input,setInput]=useState(''),[error,setError]=useState(''),[mode,setMode]=useState('chat'),[childClicks,setChildClicks]=useState(0);
        const visible=useAppStore(s=>s.rightModule==='claw'&&!s.rightPanelCollapsed);
        window.chat=flow;
        return <><ScrollArea style={{height:200}}><p>消息记录 {flow.run?.status}</p></ScrollArea><form onSubmit={async e=>{e.preventDefault();setError('');if(mode==='chat'){calls.push(['chat',id,input]);setInput('');return}try{if(startBlocked)throw Error("正在准备发送消息");const submission=flow.submit(input);capturedSubmit=submission;submitSettled=false;try{if(await submission){setInput('');openClawSidebar('results')}}finally{submitSettled=true}}catch(error){setError(error.message)}}}>
          <ClawComposerBar threadId={id} flow={flow} mode={mode} onModeChange={setMode}>{withChild&&<button type="button" aria-label="灵件工作台" onClick={()=>setChildClicks(n=>n+1)}>灵件 {childClicks}</button>}</ClawComposerBar>
          <textarea aria-label="聊天消息" className="composer-textarea" value={input} onChange={e=>setInput(e.target.value)}/>
          <button type="submit" disabled={mode==='flow'&&(!flow.enabled||flow.busy||flow.active)}>{mode==='flow'?'发送并执行流程':'发送聊天'}</button><p role="alert">{error}</p></form>
          <div hidden={!visible} inert={!visible}><ClawSidebarHost threadId={id}/></div>
          <ClawSidebar threadId={id} flow={flow} disabled={false} onFollowUp={text=>{setMode('chat');setInput(text)}}><Probe/></ClawSidebar>
        </>
      }
      window.fixture={sourcesFail:value=>sourcesFail=value,sources:value=>sources=value,bindFlow:()=>{profileView.active={id:'bound',name:'Bound Claw',capabilities:[],models:{default:'m2',roles:{}},flow:saved('a')};profileView.bindingRevision=7;for(const fn of configurationListeners)fn()},panelCounts:()=>[panelMounts,panelUnmounts],hideSidebar:()=>useAppStore.getState().setRightPanelCollapsed(true),profile:()=>host.render(<ClawPanel threadId='a'/>),deferProfile:()=>deferProfile=true,finishProfile:()=>finishProfile(),configuration:()=>{for(const fn of configurationListeners)fn()},project:(enabled,applicable=true)=>{profileView.enabled=enabled;profileView.applicable=applicable;for(const fn of configurationListeners)fn()},blockStart:()=>startBlocked=true,select:selectChatFlow,chat:(id,enabled=true,withChild=false)=>host.render(<ChatFixture id={id} enabled={enabled} withChild={withChild}/>),updateVersion:id=>{definitions.get(id)[0].revision++},revoke:()=>{catalog.plugins[0].authorized=false},calls,render:id=>host.render(<FlowsPanel threadId={id}/>),unmount:()=>host.render(null),
        listeners:()=>[...listeners.values()].reduce((n,s)=>n+s.size,0),deferSave:()=>deferSave=true,finishSave:()=>saveFinish(),
        deferRead:()=>deferRead=true,finishRead:()=>readFinish(),deferCatalog:()=>deferCatalog=true,finishCatalog:()=>catalogFinish(),catalogPending:()=>typeof catalogFinish==='function',
        hasCapturedSubmit:()=>capturedSubmit!==null,submitSettled:()=>submitSettled,waitForSubmit:()=>capturedSubmit.then(()=>undefined,()=>undefined),readCounts:()=>({binding:viewReads,runs:calls.filter(c=>c[0]==='runs').length,catalog:calls.filter(c=>c[0]==='catalog').length,list:calls.filter(c=>c[0]==='list').length}),
        deferMcp:()=>deferMcp=true,finishMcp:()=>finishMcp(),emit,navigation:()=>window.navigationCalls||[],large:()=>{const large=definition('large');large.steps=Array.from({length:64},(_,i)=>({id:'s'+i,name:'步骤'+i,enabled:true,kind:'agent',prompt:'做事'}));const render=d=>host.render(<FlowEditor value={d} catalog={catalog} disabled={false} onChange={render}/>);render(large)},
        largeRun:()=>{const run={id:'large',threadId:'a',workspace:'a',flow:saved('a'),status:'complete',startedAt:1,epoch:10,failureCounts:{},attempts:Array.from({length:256},(_,i)=>({executionId:'e'+i,stepId:'build',attempt:i+1,epoch:i,status:'passed',startedAt:i,result:{passed:true,summary:'结果'+i,source:'agent'}}))};host.render(<FlowRunView run={run} busy={false} onDecide={()=>{}} onCancel={()=>{}}/>)}
      };
      ${body}
    `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      ...plugins,
      {
        name: "unrelated-app-store",
        setup(builder) {
          builder.onResolve({ filter: /^@\/lib\/(store|thread-context)$/ }, (args) => ({
            path: args.path,
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            resolveDir: root,
            contents: args.path.endsWith("thread-context")
              ? "export const useThreadStateSelector=()=>true"
              : `import {useSyncExternalStore} from 'react';
                const listeners=new Set();const notify=()=>{for(const fn of listeners)fn()};
                const state={rightModule:'work',rightPanelCollapsed:true,
                  models:[{id:'m2',name:'Model Two',model:'model-two',source:'custom',provider:'custom',available:true}],
                  setRightModule:value=>{state.rightModule=value;notify()},setRightPanelCollapsed:value=>{state.rightPanelCollapsed=value;notify()},
                  selectThread:async(id)=>{(window.navigationCalls??=[]).push(['thread',id])},
                  setShowCustomizeView:(...args)=>{(window.navigationCalls??=[]).push(args)}};
                export const useAppStore=selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(state));
                useAppStore.getState=()=>state;
                useAppStore.subscribe=listener=>{const notifyState=()=>listener(state);listeners.add(notifyState);return()=>listeners.delete(notifyState)};`
          }))
        }
      }
    ]
  })
  await page.goto("about:blank")
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: result.outputFiles[0].text })
}

async function editAndRun(page: Page) {
  await mount(page)
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  const review = page.locator('[data-flow-step="review"]')
  await review.getByRole("button", { name: /^配置步骤：/ }).click()
  await review.getByLabel("执行助手", { exact: true }).selectOption("review")
  await review.getByLabel("模型选择方式", { exact: true }).selectOption("fixed")
  await review.getByLabel("模型", { exact: true }).selectOption("m2")
  await review.getByLabel("上移步骤", { exact: true }).click()
  assert.equal(
    await page.locator("[data-flow-step]").first().getAttribute("data-flow-step"),
    "review"
  )
  await review.getByLabel("下移步骤", { exact: true }).click()
  await review.getByText("条件、成功路线与失败回退", { exact: true }).click()
  await review.getByLabel("执行条件", { exact: true }).selectOption("build")
  await review.getByLabel("未通过时", { exact: true }).selectOption("build")
  await review.getByLabel("最多失败转向次数", { exact: true }).fill("2")
  assert(await page.getByRole("button", { name: "运行已保存版本", exact: true }).isDisabled())
  await page.getByText("项目阶段与运行限制", { exact: true }).click()
  await page.getByLabel("Autobiz Feature", { exact: true }).selectOption("orders")
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  await page.getByText("已保存修订 2，可开始运行。", { exact: true }).waitFor()
  const save = await page.evaluate<FlowSaveCall | undefined>(
    "window.fixture.calls.find(c=>c[0]==='save')"
  )
  assert(save)
  assert.equal(save[3], 1)
  const savedReview = save[2].steps[1]
  assert(savedReview && savedReview.kind === "agent")
  assert.equal(savedReview.agentType, "review")
  assert.equal(savedReview.modelId, "m2")
  assert.deepEqual(savedReview.when, { stepId: "build", outcome: "passed" })
  assert.deepEqual(savedReview.onFailure, { stepId: "build", maxRetries: 2 })
  assert.equal(save[2].stageStart, "requirements_eval_in_progress")
  await page.getByRole("button", { name: "运行已保存版本", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
  await page
    .getByText("当前任务有原生权限审批或工具提问等待处理。流程会等待你的决定。", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "返回当前任务处理", exact: true }).click()
  assert.deepEqual(await page.evaluate("window.fixture.navigation()"), [["thread", "a"]])
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide').length"), 0)
  await page.getByRole("button", { name: "同意并继续", exact: true }).dblclick()
  await page.getByText("成果已确认", { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide')"), [
    ["decide", "a", "run1", "nonce1", true]
  ])
  await page.getByRole("button", { name: "运行已保存版本", exact: true }).click()
  await page.getByRole("button", { name: "拒绝并停止", exact: true }).click()
  await page.getByText("人工拒绝", { exact: true }).waitFor()
  await page.getByRole("button", { name: "运行已保存版本", exact: true }).click()
  await page.getByRole("button", { name: "取消运行", exact: true }).click()
  await page.getByRole("heading", { name: "Flow a · 已取消", exact: true }).waitFor()
  assert.equal(await page.getByRole("region", { name: "人工成果确认" }).count(), 0)
  pass(
    "edits reach revisioned save; dirty draft cannot run; nonce approval/rejection/cancellation use real UI actions"
  )
}

async function lifecycle(page: Page) {
  await mount(page)
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  await page.getByLabel("流程名称", { exact: true }).fill("old project saved")
  await page.evaluate("window.fixture.deferSave()")
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  await page.waitForFunction("window.fixture.calls.some(c=>c[0]==='save')")
  await page.evaluate("window.fixture.render('b')")
  await page.getByRole("button", { name: "Flow b", exact: true }).click()
  await page.evaluate("window.fixture.finishSave()")
  await settle(page)
  assert.equal(await page.getByLabel("流程名称", { exact: true }).inputValue(), "Flow b")
  assert.equal(await page.getByText("已保存修订 2，可开始运行。", { exact: true }).count(), 0)
  assert.deepEqual(
    await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').map(c=>c[1])"),
    ["a"]
  )
  await page.evaluate("window.fixture.deferCatalog();window.fixture.render('a')")
  await page.waitForFunction("window.fixture.catalogPending()")
  await page.evaluate("window.fixture.render('b')")
  await page.getByRole("button", { name: "Flow b", exact: true }).waitFor()
  await page.evaluate("window.fixture.finishCatalog()")
  await settle(page)
  assert.equal(await page.getByText("old project saved", { exact: true }).count(), 0)
  assert.equal(await page.evaluate("window.fixture.listeners()"), 1)
  await page.evaluate("window.fixture.unmount()")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  pass(
    "old project save/catalog responses cannot overwrite another project; unmount returns listeners to zero"
  )
}

async function templateAndValidation(page: Page) {
  await mount(page)
  await page.getByRole("button", { name: "新建通用开发流程", exact: true }).click()
  await page.getByRole("button", { name: "添加步骤", exact: true }).click()
  const added = page.locator("[data-flow-step]").last()
  await added.getByLabel("步骤类型", { exact: true }).selectOption("approval")
  await added.getByText("条件、成功路线与失败回退", { exact: true }).click()
  assert(await added.getByLabel("未通过时", { exact: true }).isDisabled())
  await added.getByRole("button", { name: "删除步骤", exact: true }).click()
  await page
    .locator('[data-flow-step="implement"]')
    .getByLabel("启用步骤", { exact: true })
    .uncheck()
  await page.getByRole("alert").filter({ hasText: "失败路线目标不存在或已禁用" }).waitFor()
  assert(await page.getByRole("button", { name: "保存流程", exact: true }).isDisabled())
  await page.locator('[data-flow-step="implement"]').getByLabel("启用步骤", { exact: true }).check()
  assert.equal(await page.locator('[data-flow-step="stage"]').count(), 0)
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  await page.getByText("已保存修订 1，可开始运行。", { exact: true }).waitFor()
  await page.getByRole("button", { name: "复制当前流程", exact: true }).click()
  assert.equal(
    await page.getByLabel("流程名称", { exact: true }).inputValue(),
    "通用开发流程 副本"
  )
  assert(await page.getByRole("button", { name: "运行已保存版本", exact: true }).isDisabled())
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  await page.getByText("已保存修订 1，可开始运行。", { exact: true }).waitFor()
  const saves = await page.evaluate<FlowSaveCall[]>(
    "window.fixture.calls.filter(c=>c[0]==='save')"
  )
  assert.equal(saves.length, 2)
  assert.equal(saves[0][2].schemaVersion, 2)
  assert.equal("plugin" in saves[0][2], false)
  assert.notEqual(saves[0][2].id, saves[1][2].id)
  assert.deepEqual(
    saves.map((s) => s[3]),
    [0, 0]
  )
  pass(
    "template add/remove/copy use independent ids; disabled dependencies prevent save; host template has no placeholder plugin or stage transition"
  )
}

async function boundedReads(page: Page) {
  await mount(page)
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  await page.getByRole("button", { name: "运行已保存版本", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
  await settle(page)
  const before = await page.evaluate<number>(
    "window.fixture.calls.filter(c=>c[0]==='run').length"
  )
  const directoryReads = await page.evaluate<FlowReadCounts>("window.fixture.readCounts()")
  await page.evaluate("window.fixture.deferRead();for(let i=0;i<100;i++)window.fixture.emit('a')")
  await page.waitForFunction(
    (n) =>
      (window as unknown as { fixture: { calls: unknown[][] } }).fixture.calls.filter(
        (c) => c[0] === "run"
      ).length ===
      n + 1,
    before
  )
  await page.evaluate("window.fixture.finishRead()")
  await settle(page)
  assert.equal(
    await page.evaluate("window.fixture.calls.filter(c=>c[0]==='run').length"),
    before + 2
  )
  assert.deepEqual(await page.evaluate("window.fixture.readCounts()"), directoryReads)
  pass(
    "100 run events coalesce into at most two selected-run reads and no catalog/definition/history reload"
  )
}

async function navigationAndScale(page: Page) {
  await mount(page, "host.render(<FlowTaskEntry/>);")
  await page.getByRole("button", { name: "按步骤执行 · 管理步骤与记录", exact: true }).click()
  assert.deepEqual(await page.evaluate("window.fixture.navigation()"), [[true, "flows"]])
  assert.deepEqual(await page.evaluate("window.fixture.calls"), [])
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  await page.evaluate("window.fixture.large()")
  await page.locator("[data-flow-step]").last().waitFor()
  assert.equal(await page.locator("[data-flow-step]").count(), 64)
  assert(await page.getByRole("button", { name: "添加步骤", exact: true }).isDisabled())
  const timings: number[] = []
  for (let i = 0; i < 20; i++) {
    timings.push(
      await page.evaluate(async () => {
        const start = performance.now()
        ;(
          document.querySelector('[data-flow-step] input[type="checkbox"]') as HTMLInputElement
        ).click()
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
        return performance.now() - start
      })
    )
  }
  const p95 = [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * 0.95) - 1]
  assert(p95 <= 100, `64-step edit second-frame p95 ${p95.toFixed(1)}ms exceeds 100ms`)
  await page.evaluate("window.fixture.largeRun()")
  await page.getByRole("list", { name: "步骤执行记录", exact: true }).waitFor()
  assert.equal(
    await page.getByRole("list", { name: "步骤执行记录", exact: true }).locator("li").count(),
    256
  )
  pass(
    `navigation performs zero flow IPC; 64-step editor p95 ${p95.toFixed(1)}ms; 256 attempts render bounded details`
  )
}

async function firstUseAndVisuals(page: Page) {
  const output = outputFolder("flow-ux")
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
  assert(css, "Build the production CSS before visual checks")
  await mount(page)
  await page.addStyleTag({ path: join(assets, css) })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.getByRole("button", { name: "新建代码检视流程", exact: true }).click()
  assert.equal(await page.locator("[data-flow-step]").count(), 2)
  assert.equal(await page.locator("[data-flow-step-settings]").count(), 1)
  assert.equal(await page.getByLabel("流程名称", { exact: true }).inputValue(), "代码检视与确认")
  await page.getByRole("button", { name: "添加运行检查", exact: true }).click()
  const last = page.locator("[data-flow-step]").last()
  assert.equal(await last.getByLabel("步骤类型", { exact: true }).inputValue(), "check")
  await last.getByRole("button", { name: "删除步骤", exact: true }).click()
  // Navigating to installation must not silently discard the current edit.
  page.once("dialog", (dialog) => dialog.dismiss())
  await page.getByRole("button", { name: "添加 / 授权灵件", exact: true }).click()
  assert.deepEqual(await page.evaluate("window.fixture.navigation()"), [])
  const review = page.locator('[data-flow-step="review"]')
  await review.getByRole("button", { name: /^配置步骤：/ }).click()
  await review.getByLabel("步骤目标", { exact: true }).fill("只检查权限问题，不改代码")
  await page
    .locator('[data-flow-step="accept"]')
    .getByRole("button", { name: /^配置步骤：/ })
    .click()
  await review.getByRole("button", { name: /^配置步骤：/ }).click()
  assert.equal(
    await review.getByLabel("步骤目标", { exact: true }).inputValue(),
    "只检查权限问题，不改代码"
  )
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  const saved = await page.evaluate<FlowDefinition>(
    "window.fixture.calls.find(c=>c[0]==='save')[2]"
  )
  assert.equal(saved.feature, undefined)
  assert.deepEqual(
    saved.steps.map((step) => step.kind),
    ["agent", "approval"]
  )
  await page.getByText("保存后，怎样使用？", { exact: true }).waitFor()
  await page.evaluate(() => window.scrollTo(0, 0))
  await settle(page)
  await page.screenshot({
    path: join(output, "flow-light.png"),
    fullPage: true,
    animations: "disabled"
  })
  const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await page.evaluate("window.applyTestTheme('codex-dark')")
  assert.notEqual(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    lightBackground
  )
  await page.screenshot({
    path: join(output, "flow-dark.png"),
    fullPage: true,
    animations: "disabled"
  })
  await page.setViewportSize({ width: 420, height: 900 })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.screenshot({
    path: join(output, "flow-narrow.png"),
    fullPage: true,
    animations: "disabled"
  })
  await page.evaluate("window.applyTestTheme('cmbdevclaw-white')")
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.getByRole("button", { name: "运行已保存版本", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  await page.screenshot({ path: join(output, "flow-running.png"), fullPage: true })
  pass(
    "first-use template needs no Feature; component selection, edit retention, leave guard, save/run and responsive themes work"
  )

  await mount(page, "host.render(<ModsImportGuide/>);")
  await page.addStyleTag({ path: join(assets, css) })
  await page.getByText("安装下载好的插件", { exact: false }).first().click()
  const pending = page.waitForEvent("download")
  await page.getByRole("button", { name: "下载插件示例（ZIP）", exact: true }).click()
  const download = await pending
  assert.equal(download.suggestedFilename(), "my-claw.zip")
  const file = await download.path()
  assert(file)
  const zip = await JSZip.loadAsync(readFileSync(file))
  for (const [name, contents] of Object.entries(MODS_STARTER_FILES))
    assert.equal(await zip.file(name)!.async("string"), contents)
  assert.deepEqual(await page.evaluate("window.fixture.calls"), [])
  await page.screenshot({ path: join(output, "upload-guide.png"), fullPage: true })
  pass(
    "download is a real ZIP with the tested manifest/module/source; downloading does not install, execute or grant"
  )
}

async function compactComposer(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a' withChild/>);")
  const trigger = page.getByRole("button", { name: "选择发送方式", exact: true })
  await trigger.waitFor()
  const child = page.getByRole("button", { name: "灵件工作台", exact: true })
  await child.click()
  assert.equal(await child.textContent(), "灵件 1")
  assert.equal(await page.getByRole("button", { name: "按步骤执行", exact: true }).count(), 0)
  assert.equal(await page.getByRole("button", { name: "直接聊天", exact: true }).count(), 0)
  assert.equal(await page.locator("[data-claw-composer] button").count(), 3)
  await page.getByLabel("聊天消息").fill("保留我的日常聊天草稿")
  await trigger.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("button", { name: "直接聊天", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "直接聊天", exact: true }).evaluate(
    node => node === document.activeElement
  ), true)
  await page.keyboard.press("Tab")
  assert.equal(await page.getByRole("button", { name: "按步骤执行", exact: true }).evaluate(
    node => node === document.activeElement
  ), true)
  await page.keyboard.press("Escape")
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true)
  assert.equal(await trigger.getAttribute("aria-expanded"), "false")
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留我的日常聊天草稿")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>['start','clawStart','chat','decide'].includes(c[0])).length"), 0)
  await page.evaluate("window.fixture.chat('a',false,true)")
  await page.waitForFunction("window.chat.enabled===false")
  assert.equal(await trigger.count(), 0)
  assert.equal(await child.isVisible(), true)
  assert.equal(await child.textContent(), "灵件 1")
  await child.focus()
  await page.keyboard.press("Enter")
  assert.equal(await child.textContent(), "灵件 2")
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留我的日常聊天草稿")
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await trigger.waitFor()
  assert.equal(await page.evaluate("Boolean(window.chat.choice)"), false)
  await page.getByLabel("聊天消息").fill("流程未配置时保留的普通问题")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  assert.equal(await page.getByRole("tab", { name: "设置", exact: true }).getAttribute("aria-selected"), "true")
  assert.equal(await page.getByText("直接提问就可以", { exact: true }).isVisible(), true)
  assert.equal(await page.getByText("查看这套组合的设置", { exact: true }).count(), 0)
  assert.equal(await page.getByRole("button", { name: "选择助手组合", exact: true }).isVisible(), true)
  assert.equal(await page.getByText("使用已开启的技能", { exact: true }).isVisible(), false)
  await page.evaluate("window.fixture.bindFlow()")
  await page.getByRole("heading", { name: "Bound Claw", exact: true }).waitFor()
  const settings = page.locator("details").filter({ hasText: "查看这套组合的设置" })
  assert.equal(await settings.getAttribute("open"), null)
  await page.getByText("查看这套组合的设置", { exact: true }).click()
  assert.equal(await page.getByText("做事方法（技能）", { exact: true }).isVisible(), true)
  await page.evaluate("window.fixture.project(true,false)")
  await page.getByText("这套组合暂不可用。请打开下方‘管理助手组合’查看并调整设置。", { exact: true }).waitFor()
  await page.evaluate("window.fixture.project(false)")
  await page.getByText("灵件功能已关闭。请到‘自定义助手 → 添加功能’开启。", { exact: true }).waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>['start','clawStart','chat','decide'].includes(c[0])).length"), 0)
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByLabel("聊天消息").fill("流程未配置时保留的普通问题")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
  await trigger.click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  assert.equal(await page.getByRole("tab", { name: "按步骤执行", exact: true }).getAttribute("aria-selected"), "true")
  assert.equal(await page.getByLabel("本次使用的步骤").isVisible(), true)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "流程未配置时保留的普通问题")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>['start','clawStart','chat','decide'].includes(c[0])).length"), 0)
  await page.evaluate("window.fixture.project(false)")
  await page.waitForFunction("window.chat.enabled===false")
  assert.equal(await page.evaluate("Boolean(window.chat.choice)"), false)
  assert.equal(await page.getByRole("button", { name: "发送并执行流程", exact: true }).isDisabled(), true)
  assert.equal(await trigger.isVisible(), true)
  await trigger.click()
  assert.equal(await page.getByRole("button", { name: "按步骤执行", exact: true }).isDisabled(), true)
  await page.getByRole("button", { name: "直接聊天", exact: true }).click()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "流程未配置时保留的普通问题")
  assert.equal(await page.getByRole("button", { name: "发送聊天", exact: true }).isDisabled(), false)
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat')"), [
    ["chat", "a", "流程未配置时保留的普通问题"]
  ])
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>['start','clawStart'].includes(c[0])).length"), 0)
  pass("Compact composer hides mode choices until requested, supports keyboard/Escape focus, preserves draft and keeps child controls when flow is disabled")
  pass("An unconfigured flow disabled while selected retains its mode menu, allowing ordinary chat without losing the draft")
}

async function chatBridge(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='catalog').length"), 0)
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await page.getByLabel("聊天消息").fill("检查订单导出")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).dblclick()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  const starts = await page.evaluate<FlowStartCall[]>(
    "window.fixture.calls.filter(c=>c[0]==='start')"
  )
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0][4], { workspace: "a", goal: "检查订单导出" })
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "")
  await page.getByRole("button", { name: "同意并继续", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='complete'")
  await page.getByLabel("聊天消息").fill("检查权限控制")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByRole("button", { name: "等待你确认 · 查看", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  await page.getByRole("button", { name: "取消运行", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='cancelled'")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').length"), 0)
  await page.evaluate("window.fixture.updateVersion('a')")
  await page.getByLabel("聊天消息").fill("保留这个新需求")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByText(/流程已更新或移除/).waitFor()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留这个新需求")
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByRole("button", { name: "刷新", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:2")
  await page.evaluate("window.fixture.revoke()")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByText(/尚未开启或授权/).waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 2)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 0)
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "直接聊天", exact: true }).click()
  await page.getByLabel("聊天消息").fill("为什么失败？")
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 2)
  pass(
    "chat choice starts nothing; explicit start freezes task, prevents double start, confirms/cancels, preserves template and rejected drafts"
  )

  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()

  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.evaluate("window.fixture.chat('a',false)")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  const count = await page.evaluate("window.fixture.calls.length")
  assert.equal(
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).isDisabled(),
    true
  )
  assert.equal(await page.evaluate("window.fixture.calls.length"), count)
  await page.evaluate("window.fixture.chat('b',true)")
  await settle(page)
  assert.equal(await page.evaluate("window.chat.choice"), null)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 2)
  pass("Mods-off never calls flow IPC and a different thread does not inherit the chosen flow")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByLabel("聊天消息").fill("旧项目的任务")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.evaluate("window.fixture.chat('b',true)")
  await settle(page)
  await page.evaluate("window.fixture.chat('a',true)")
  await settle(page)
  await page.evaluate("window.fixture.finishCatalog()")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.evaluate("window.chat.choice.id"), "flow_a")
  pass("A→B→A during preflight cannot revive the old task")
}

async function clawRaces(page: Page) {
  await mount(page, "host.render(<ClawPanel threadId='a'/>);")
  await page.getByText("高级编辑与已保存组合", { exact: true }).click()
  await page.getByLabel("选择能力 Demo").check()
  await page.getByLabel("助手组合名称").fill("Reviewed Claw")
  await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
  await page.getByLabel("聊天默认模型").selectOption("m2")
  await page.getByLabel("步骤模型 review").selectOption("m2")
  await page.getByLabel("组合使用的流程").selectOption("flow_a:1")
  await page.evaluate("window.fixture.deferProfile(); window.fixture.configuration()")
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  await page.getByRole("button", { name: "应用到当前对话", exact: true }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await page.getByText("当前组合：Reviewed Claw", { exact: true }).waitFor()
  await page.evaluate("window.fixture.finishProfile()")
  await settle(page)
  await page.getByText("当前组合：Reviewed Claw", { exact: true }).waitFor()
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  assert.equal(
    await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].revision"),
    2
  )
  const savedProfile = await page.evaluate<ClawProfile>(
    "window.fixture.calls.find(c=>c[0]==='claw'&&c[1].kind==='save')[1].profile"
  )
  assert(savedProfile.models && savedProfile.flow)
  assert.equal(savedProfile.models.default, "m2")
  assert.equal(savedProfile.models.roles.review, "m2")
  assert.equal(savedProfile.flow.revision, 1)
  pass(
    "late Claw refresh cannot replace the applied profile; model roles and flow snapshot reach save"
  )

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("保留流程目标")
  await page.evaluate("window.fixture.blockStart()")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByText("正在准备发送消息", { exact: true }).waitFor()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留流程目标")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  pass("rejected shared-lock admission preserves the flow goal and dispatches no run")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByLabel("聊天消息").fill("核对选择身份")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.evaluate(
    "window.fixture.select('a',{workspace:'a',id:'flow_a',revision:1,name:'new selection'}); window.fixture.finishCatalog()"
  )
  await page.getByText(/流程选择已改变/).waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  pass("changing selection during preflight cannot dispatch the earlier choice")
}

async function sidebarLifecycle(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByLabel("聊天消息").fill("选中流程也能普通聊天")
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 1)
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("检视订单导出")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  const observers = await page.evaluate("window.fixture.listeners()")
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: "收起当前助手", exact: true }).click()
    await page.getByRole("button", { name: "等待你确认 · 查看", exact: true }).waitFor()
    await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  }
  assert.deepEqual(await page.evaluate("window.fixture.panelCounts()"), [1, 0])
  assert.equal(await page.evaluate("window.fixture.listeners()"), observers)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 1)
  await page.evaluate("window.publishClawNotice('a','jobs','插件命令执行中')")
  await page.getByRole("button", { name: "插件命令执行中 · 查看", exact: true }).click()
  await page.locator("[data-claw-results]").waitFor()
  assert.equal(await page.getByRole("tab", { name: "运行过程", exact: true }).getAttribute("aria-pressed"), "true")
  assert.equal(await page.locator("[data-chat-flow-run]").count(), 1)
  assert.equal(await page.getByRole("button", { name: "同意并继续", exact: true }).count(), 1)
  await page.evaluate("window.chat.act('approve',{runId:'run1',nonce:'stale'})")
  await page.getByText("确认内容已更新，请核对当前成果后重新确认。", { exact: true }).waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide').length"), 0)
  await page.getByRole("button", { name: "同意并继续", exact: true }).dblclick()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide').length"), 1)
  await page.evaluate("window.fixture.unmount()")
  assert.deepEqual(await page.evaluate("window.fixture.panelCounts()"), [1, 1])
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  pass(
    "one input preserves explicit intent; 20 sidebar toggles retain one drawing and observer; closed approval visible; stale nonce denied"
  )

  await mount(page)
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  await page.getByRole("button", { name: "添加插件动作", exact: true }).click()
  await page.getByLabel("动作提供者").selectOption({ label: "provider-a · 独立检视" })
  const fromStep = await page.locator("[data-flow-step]").last().getAttribute("data-flow-step")
  await page.getByRole("button", { name: "添加插件动作", exact: true }).click()
  await page.getByLabel("动作提供者").selectOption({ label: "provider-b · 独立测试" })
  await page.getByLabel("动作输入", { exact: true }).fill('{"scope":"orders"}')
  await page.getByLabel("动作配置", { exact: true }).fill('{"strict":true}')
  await page.getByLabel("接收前置步骤输出").selectOption(fromStep!)
  await page.getByText("高级输出路径", { exact: true }).click()
  await page.getByLabel("输出字段路径（JSON Pointer，可留空）").fill("/result")
  await page.getByLabel("动作输入", { exact: true }).fill("{")
  assert(await page.getByRole("button", { name: "保存流程", exact: true }).isDisabled())
  await page.getByLabel("动作输入", { exact: true }).fill('{"scope":"orders"}')
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  const action = await page.evaluate<FlowStep | undefined>(
    "window.fixture.calls.find(c=>c[0]==='save')[2].steps.at(-1)"
  )
  assert(action && action.kind === "plugin-action")
  assert.equal(action.kind, "plugin-action")
  assert.equal(action.pluginId, "plugin-b")
  assert.deepEqual(action.input, { scope: "orders" })
  assert.deepEqual(action.config, { strict: true })
  assert.deepEqual(action.inputFrom, { stepId: fromStep, path: "/result" })
  pass(
    "cross-source action editor saves exact provider/input/config/binding and blocks invalid JSON"
  )

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.evaluate("window.fixture.bindFlow()")
  await page.waitForFunction("window.chat.choice?.bindingRevision===7")
  await page.getByLabel("当前助手指定的聊天模型").waitFor()
  await page.getByRole("button", { name: "发送聊天", exact: true }).waitFor()
  await page.evaluate("window.fixture.updateVersion('a')")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("使用绑定副本")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.waitForFunction("window.chat.run?.id==='bound1'")
  assert.equal(await page.evaluate("window.chat.run.flow.revision"), 1)
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart')"), [
    ["clawStart", "a", 7, "使用绑定副本"]
  ])
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  pass(
    "applying a bound flow preserves chat intent; changed template starts the frozen Claw API with binding revision"
  )
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "运行过程", exact: true }).click()
  await page.getByRole("button", { name: "带运行摘要追问", exact: true }).click()
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart').length"), 1)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 1)
  pass(
    "follow-up switches to chat intent, keeps the summary draft and never restarts the applied flow"
  )
}

async function sourceComposition(page: Page) {
  await mount(
    page,
    `profileView.active={id:'sources',name:'Applied sources',capabilities:[],skills:{mode:'selected',items:[sources.skills[0]]},mcp:{mode:'selected',items:[]}};profileView.profiles=[structuredClone(profileView.active)];host.render(<ClawPanel threadId='a'/>);`
  )
  await page.getByText("高级编辑与已保存组合", { exact: true }).click()
  await page.getByText("更多设置：技能、工具、模型与步骤", { exact: true }).click()
  const skills = page.getByRole("region", { name: "技能", exact: true })
  const mcp = page.getByRole("region", { name: "连接工具", exact: true })
  const output = outputFolder("source-browser")
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
  assert(css, "Build production CSS before source selector visual checks")
  await page.addStyleTag({ path: join(assets, css) })
  await page.setViewportSize({ width: 1366, height: 960 })
  assert.equal(await page.getByLabel("助手组合名称").inputValue(), "Applied sources")
  assert.equal(await skills.getByRole("checkbox").nth(0).isChecked(), true)
  assert.equal(await skills.getByRole("checkbox").nth(1).isChecked(), false)
  await page.screenshot({ path: join(output, "source-editor.png"), fullPage: true })
  await page.setViewportSize({ width: 800, height: 960 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(output, "source-editor-800.png"), fullPage: true })
  await page.setViewportSize({ width: 1366, height: 960 })
  await skills.getByRole("button", { name: "仅使用所选", exact: true }).click()
  assert.equal(await skills.getByRole("checkbox").nth(0).isChecked(), true)
  await page.getByLabel("助手组合名称").fill("Unsaved sources draft")
  await page.evaluate("window.fixture.configuration()")
  await settle(page)
  assert.equal(await page.getByLabel("助手组合名称").inputValue(), "Unsaved sources draft")
  await skills.getByRole("button", { name: "清空", exact: true }).click()
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  assert.deepEqual(
    await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].profile.skills"),
    { mode: "selected", items: [] }
  )
  assert.deepEqual(
    await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].profile.mcp"),
    { mode: "selected", items: [] }
  )
  await skills.getByRole("button", { name: "全选当前", exact: true }).click()
  await skills.getByLabel("搜索技能").fill("团队")
  assert.equal(await skills.getByRole("checkbox").count(), 1)
  await skills.getByLabel("搜索技能").fill("")
  await page.evaluate(
    "window.fixture.sources({skills:[{id:'skill-b',name:'Review',digest:'c'.repeat(64),owner:'团队插件'}],mcp:[]});window.fixture.configuration()"
  )
  await skills.getByText("已禁用、移除或不可用，请从组合移除", { exact: true }).waitFor()
  await skills.getByText("来源已更新，请移除后重新选择并核对", { exact: true }).waitFor()
  assert.equal(await skills.getByRole("checkbox").count(), 2)
  await page.evaluate("window.fixture.sourcesFail(true);window.fixture.configuration()")
  await page.getByText("技能和工具列表读取失败：directory unavailable", { exact: true }).waitFor()
  assert.equal(await skills.getByRole("checkbox").count(), 2)
  assert.equal(
    await skills.getByRole("button", { name: "全选当前", exact: true }).isDisabled(),
    true
  )
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  assert.equal(
    await page.evaluate(
      "window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].profile.skills.items.length"
    ),
    2
  )
  await skills.getByRole("button", { name: "使用全部已开启项", exact: true }).click()
  await mcp.getByRole("button", { name: "使用全部已开启项", exact: true }).click()
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  assert.deepEqual(
    await page.evaluate("window.fixture.calls.filter(c=>c[0]==='claw').at(-1)[1].profile.skills"),
    { mode: "all", items: [] }
  )
  await page.evaluate("window.fixture.sourcesFail(false)")
  await page.getByRole("button", { name: "重新读取列表", exact: true }).click()
  await page.getByRole("button", { name: "重新读取列表", exact: true }).waitFor({ state: "hidden" })
  await page.evaluate(
    "window.fixture.sources({skills:Array.from({length:600},(_,i)=>({id:'large-'+i,name:'Large Skill '+i,digest:'d'.repeat(64)})),mcp:[]});window.fixture.configuration()"
  )
  await settle(page)
  await skills.getByRole("button", { name: "仅使用所选", exact: true }).click()
  assert.equal(await skills.getByRole("checkbox").count(), 100)
  assert.equal(
    await skills.getByRole("button", { name: "全选当前", exact: true }).isDisabled(),
    true
  )
  await skills.getByRole("button", { name: /显示更多/ }).click()
  assert.equal(await skills.getByRole("checkbox").count(), 200)
  await skills.getByLabel("搜索技能").fill("Large Skill 599")
  assert.equal(await skills.getByRole("checkbox").count(), 1)
  pass(
    "Skill/MCP selections preserve explicit empty, current snapshot, source identity and drafts across catalog refresh/failure"
  )

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "设置", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='sources').length"), 0)
  assert.equal(await page.getByText("使用已开启的技能", { exact: true }).count(), 0)
  assert.equal(await page.getByText("使用已开启的工具", { exact: true }).count(), 0)
  pass("ordinary chat and sidebar summaries never scan the Skill/MCP source catalog")
}

async function nativeSteps(page: Page) {
  await mount(page)
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))
  assert(css, "Build production CSS before visual checks")
  await page.addStyleTag({ path: join(assets, css) })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  await page.getByText("第一次怎么用？", { exact: true }).click()
  const guide = (await page.locator("[data-flow-usage]").innerText()).replace(/\s+/g, " ")
  for (const kind of [
    "技能任务",
    "外部工具（MCP）",
    "插件动作",
    "助手任务",
    "运行检查",
    "人工确认",
    "Autobiz 阶段推进"
  ]) {
    assert.equal(
      await page.getByRole("button", { name: `添加${kind}`, exact: true }).isVisible(),
      true
    )
  }
  assert.match(guide, /从步骤库选择要做的事/)
  assert.match(guide, /外部服务的工具（MCP）/)
  assert.match(guide, /先加载工具列表/)
  assert.match(guide, /传递前一步结果/)
  assert.match(guide, /每轮任务只调用该工具一次/)
  assert.match(guide, /停止或重试不会撤销已经完成的文件修改或外部操作/)
  assert.match(guide, /按步骤执行/)
  assert.match(guide, /直接聊天.*不会.*流程/)
  assert.doesNotMatch(guide, /上述四类步骤|不会自动变成新的步骤类型/)
  await page.getByText("第一次怎么用？", { exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='mcpTools').length"), 0)
  await page.getByRole("button", { name: "添加技能任务", exact: true }).click()
  const skill = page.getByLabel("使用哪个技能")
  await skill.selectOption({ label: "Review · 团队插件" })
  await page.getByLabel("模型选择方式", { exact: true }).selectOption("fixed")
  await page.getByLabel("模型", { exact: true }).selectOption("m2")
  await page.getByLabel("步骤目标", { exact: true }).fill("用选择的技能评审改动")
  const output = outputFolder("native-steps-ui")
  await page.screenshot({
    path: join(output, "skill-step.png"),
    fullPage: true
  })
  await page.getByRole("button", { name: "添加外部工具（MCP）", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='mcpTools').length"), 0)
  await page.getByRole("button", { name: "加载 MCP 工具目录", exact: true }).click()
  await page.getByLabel("MCP 服务与工具").selectOption({ label: "Repository / lookup" })
  assert.equal(
    await page
      .getByLabel("MCP 服务与工具")
      .locator("option")
      .filter({ hasText: "高级 schema 暂不支持" })
      .getAttribute("disabled"),
    ""
  )
  await page.getByLabel("设置 动作输入 · query", { exact: true }).check()
  await page.getByLabel("动作输入 · query", { exact: true }).fill("review")
  await page.getByText("查看工具说明与参数格式", { exact: true }).click()
  await page.screenshot({
    path: join(output, "mcp-step.png"),
    fullPage: true
  })
  await page.setViewportSize({ width: 800, height: 900 })
  await settle(page)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({
    path: join(output, "mcp-step-800.png"),
    fullPage: true
  })
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.getByText("条件、成功路线与失败回退", { exact: false }).last().click()
  assert.equal(await page.getByLabel("未通过时", { exact: true }).isDisabled(), true)
  await page.getByRole("button", { name: "添加插件动作", exact: true }).click()
  await page.getByLabel("动作提供者").selectOption({ label: "provider-b · 独立测试" })
  await page.getByLabel("接收前置步骤输出").selectOption({ label: "外部工具（MCP）" })
  await page.getByLabel("输出来源路径", { exact: true }).selectOption("/structuredContent")
  const outputChoices = await page
    .getByLabel("接收前置步骤输出")
    .locator("option")
    .allTextContents()
  assert.equal(
    outputChoices.some((text) => text.includes("技能任务")),
    false
  )
  await page.getByLabel("动作输入", { exact: true }).fill("{")
  assert.equal(await page.getByRole("button", { name: "保存流程", exact: true }).isDisabled(), true)
  await page.getByLabel("动作输入", { exact: true }).fill("{}")
  await page.getByRole("button", { name: "保存流程", exact: true }).click()
  await page.getByText("已保存修订 2，可开始运行。", { exact: true }).waitFor()
  const saved = (await page.evaluate(
    "window.fixture.calls.filter(c=>c[0]==='save').at(-1)[2]"
  )) as { steps: Array<Record<string, unknown>> }
  assert.deepEqual(saved.steps.at(-3)?.skill, {
    id: "skill-b",
    name: "Review",
    digest: "b".repeat(64)
  })
  assert.equal(saved.steps.at(-3)?.modelId, "m2")
  assert.equal(saved.steps.at(-2)?.schemaDigest, "d".repeat(64))
  assert.deepEqual(saved.steps.at(-1)?.inputFrom, {
    stepId: saved.steps.at(-2)?.id,
    path: "/structuredContent"
  })
  await page.getByRole("button", { name: "配置步骤：外部工具（MCP）", exact: true }).click()
  await page.getByRole("button", { name: "刷新项目状态", exact: true }).click()
  await page
    .getByRole("button", { name: "刷新项目状态", exact: true })
    .waitFor({ state: "visible" })
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='mcpTools').length"), 1)
  await page.evaluate("window.fixture.deferMcp()")
  await page.getByRole("button", { name: "加载 MCP 工具目录", exact: true }).click()
  await page.evaluate("window.fixture.configuration();window.fixture.finishMcp()")
  await settle(page)
  assert.equal(await page.getByLabel("MCP 服务与工具").locator("option").count(), 1)
  await page.evaluate("window.fixture.deferMcp()")
  await page.getByRole("button", { name: "加载 MCP 工具目录", exact: true }).click()
  await page.evaluate("window.fixture.render('b')")
  await page.getByRole("button", { name: "Flow b", exact: true }).click()
  await page.getByRole("button", { name: "添加外部工具（MCP）", exact: true }).click()
  await page.evaluate("window.fixture.finishMcp()")
  await settle(page)
  assert.equal(await page.getByLabel("MCP 服务与工具").locator("option").count(), 1)
  pass(
    "native Skill/model + explicit MCP catalog + output wiring save; no automatic discovery and stale results fenced"
  )
}

async function projectActivation(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.evaluate("window.fixture.bindFlow()")
  await page.waitForFunction("window.chat.choice?.bindingRevision===7")
  await page.getByLabel("当前助手指定的聊天模型").waitFor()
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("关闭项目后保留的流程目标")
  const choice = await page.evaluate("JSON.stringify(window.chat.choice)")
  await page.evaluate("window.fixture.project(false)")
  await page.waitForFunction("window.chat.enabled===false")
  assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  assert.equal(await page.getByRole("button", { name: "按步骤执行", exact: true }).isDisabled(), true)
  await page.keyboard.press("Escape")
  assert.equal(
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).isDisabled(),
    true
  )
  await page.evaluate("window.chat.choose('')")
  const refusal = await page.evaluate<string | null>(
    "window.chat.submit('不允许启动').then(()=>null,error=>error.message)"
  )
  assert(typeof refusal === "string")
  assert.match(refusal, /当前不能运行 DIY 流程/)
  assert.equal(await page.evaluate("JSON.stringify(window.chat.choice)"), choice)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "关闭项目后保留的流程目标")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart').length"), 0)
  assert.equal(await page.evaluate("window.chat.binding.active.models.default"), "m2")
  await page.evaluate("window.fixture.project(true,false)")
  await page.waitForFunction("window.chat.binding?.applicable===false")
  assert.equal(await page.evaluate("window.chat.enabled"), false)
  assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
  await page.evaluate("window.fixture.project(true,true)")
  await page.waitForFunction("window.chat.enabled===true")
  await page.getByLabel("当前助手指定的聊天模型").waitFor()
  assert.equal(await page.evaluate("JSON.stringify(window.chat.choice)"), choice)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "关闭项目后保留的流程目标")
  assert.equal(
    await page.getByRole("button", { name: "发送并执行流程", exact: true }).isDisabled(),
    false
  )
  pass("Project OFF/applicable false pause the real controller and model badge without losing the applied choice or draft; ON restores them")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("关闭前已经启动的任务")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
  await page.getByLabel("聊天消息").fill("保留到下一次发送的草稿")
  await page.evaluate("window.fixture.project(false)")
  await page.waitForFunction("window.chat.enabled===false && !window.chat.busy")
  assert.equal(await page.getByRole("button", { name: "同意并继续", exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole("button", { name: "拒绝并停止", exact: true }).isDisabled(), true)
  await page.evaluate(
    "window.chat.act('approve',{runId:window.chat.run.id,nonce:window.chat.run.pendingApproval.nonce})"
  )
  await page.evaluate(
    "window.chat.act('reject',{runId:window.chat.run.id,nonce:window.chat.run.pendingApproval.nonce})"
  )
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide').length"), 0)
  assert.equal(await page.evaluate("window.chat.run.status"), "waiting")
  await page.getByRole("button", { name: "停止流程", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='cancelled'")
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='cancel')"), [
    ["cancel", "a", "run1"]
  ])
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留到下一次发送的草稿")
  await page.evaluate("window.fixture.project(true)")
  await page.waitForFunction("window.chat.enabled===true")
  assert.equal(await page.evaluate("window.chat.choice.id"), "flow_a")
  pass("Project OFF blocks approval and rejection but its existing owned run can still be cancelled through the real stop button")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("预检结束前关闭的任务")
  const preflightChoice = await page.evaluate("JSON.stringify(window.chat.choice)")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.waitForFunction("window.fixture.catalogPending()")
  await page.evaluate("window.fixture.project(false);window.fixture.project(true)")
  assert.equal(await page.evaluate("window.chat.enabled"), true)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await page.evaluate("window.fixture.finishCatalog()")
  await page.waitForFunction("window.chat.enabled===true && !window.chat.busy && !window.chat.loading")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.evaluate("JSON.stringify(window.chat.choice)"), preflightChoice)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "预检结束前关闭的任务")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start')"), [
    ["start", "a", "flow_a", 1, { workspace: "a", goal: "预检结束前关闭的任务" }]
  ])
  pass("OFF→ON notifications while preflight is held do not revive the old task; its choice and input start only after a new explicit send")
}

async function deferredUnmount(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await page.getByRole("button", { name: "打开当前助手", exact: true }).click()
  await page.getByRole("tab", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("本次使用的步骤").selectOption("flow_a:1")
  await page.getByRole("button", { name: "选择发送方式", exact: true }).click()
  await page.getByRole("button", { name: "按步骤执行", exact: true }).click()
  await page.getByLabel("聊天消息").fill("卸载前尚未完成的流程预检")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByRole("button", { name: "发送并执行流程", exact: true }).click()
  await page.waitForFunction("window.fixture.catalogPending() && window.fixture.hasCapturedSubmit()")
  await page.evaluate("window.fixture.configuration();window.fixture.unmount()")
  await settle(page)
  const reads = await page.evaluate<FlowReadCounts>("window.fixture.readCounts()")
  assert(reads.binding > 0 && reads.runs > 0 && reads.catalog >= 2 && reads.list >= 2,
    "The baseline must retain the real initial and held preflight reads")
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  await page.evaluate("window.fixture.finishCatalog()")
  await page.evaluate("window.fixture.waitForSubmit()")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.submitSettled()"), true)
  assert.deepEqual(await page.evaluate("window.fixture.readCounts()"), reads,
    "Settling a captured submit after unmount must add zero deferred binding/runs/catalog/list reads")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart').length"), 0)
  pass("A configuration read deferred by submit is discarded after unmount; settling the held preflight adds no new reads or dispatch")
}

async function main() {
  const artifactParent = resolve(root, "output/mods-v2-validation")
  const artifacts = resolve(root, process.env.CMB_MODS_FLOW_BROWSER_ARTIFACTS ??
    join(artifactParent, `mods-flow-browser-${Date.now()}-${randomUUID()}`))
  assert(relative(artifactParent, artifacts).match(/^[^./\\][^/\\]*$/))
  assert(!existsSync(artifacts), "Use a fresh artifact leaf; preserve previous successes and failures")
  mkdirSync(artifactParent, { recursive: true })
  mkdirSync(artifacts)
  acceptanceArtifacts = artifacts
  const executedSourceSha = createHash("sha256").update(readFileSync(__filename)).digest("hex")
  const startedAt = Date.now()
  const errors: string[] = []
  const failures: unknown[] = []
  const completedGroups: string[] = []
  let currentGroup = "launch"
  let browser: Browser | undefined
  let page: Page | undefined
  let completed = false
  try {
    browser = await chromium.launch({
      ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
      headless: true
    })
    page = await browser.newPage()
    page.setDefaultTimeout(10_000)
    page.on("pageerror", (error) => errors.push(error.message))
    const group = async (name: string, run: (target: Page) => Promise<void>) => {
      currentGroup = name
      await run(page!)
      completedGroups.push(name)
    }
    if (process.argv.includes("--entry-only")) {
      await group("templateAndValidation", templateAndValidation)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--native-only")) {
      await group("nativeSteps", nativeSteps)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--sources-only")) {
      await group("sourceComposition", sourceComposition)
      assert.deepEqual(errors, [])
    } else {
      await group("editAndRun", editAndRun)
      await group("templateAndValidation", templateAndValidation)
      await group("lifecycle", lifecycle)
      await group("boundedReads", boundedReads)
      await group("navigationAndScale", navigationAndScale)
      await group("firstUseAndVisuals", firstUseAndVisuals)
      await group("compactComposer", compactComposer)
      await group("chatBridge", chatBridge)
      await group("clawRaces", clawRaces)
      await group("sidebarLifecycle", sidebarLifecycle)
      await group("sourceComposition", sourceComposition)
      await group("nativeSteps", nativeSteps)
      await group("projectActivation", projectActivation)
      await group("deferredUnmount", deferredUnmount)
      assert.deepEqual(errors, [])
    }
    completed = true
  } catch (error) {
    failures.push(error)
    console.error("FLOW_BROWSER_FAILURE", { currentGroup, pageErrors: errors })
    try {
      await page?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
    } catch (screenshotError) {
      failures.push(screenshotError)
    }
    try {
      writeFileSync(join(artifacts, "failure.json"), JSON.stringify({
        currentGroup, executedSourceSha, pageErrors: errors,
        failures: failures.map((failure) => failure instanceof Error ? failure.stack : String(failure))
      }, null, 2) + "\n", { flag: "wx" })
    } catch (writeError) {
      failures.push(writeError)
    }
  } finally {
    try {
      await browser?.close()
    } catch (error) {
      failures.push(error)
    }
    let finalSourceSha: string | null = null
    try {
      finalSourceSha = createHash("sha256").update(readFileSync(__filename)).digest("hex")
      if (finalSourceSha !== executedSourceSha)
        failures.push(Error("Executed test source changed during run"))
    } catch (sourceError) {
      failures.push(sourceError)
    }
    try {
      writeFileSync(join(artifacts, "report.json"), JSON.stringify({
        passed: completed && failures.length === 0 && errors.length === 0,
        scope: "Real React/Flow controller and browser UI; controlled store and IPC fixture",
        artifacts, executedSourceSha, finalSourceSha, currentGroup, completedGroups, checks,
        pageErrors: errors, elapsedMs: Date.now() - startedAt,
        failures: failures.map((error) => error instanceof Error ? error.stack : String(error)),
        notCovered: ["production IPC/authority", "packaged application", "real model HTTP"]
      }, null, 2) + "\n", { flag: "wx" })
    } catch (reportError) {
      failures.push(reportError)
    }
    acceptanceArtifacts = undefined
  }
  if (failures.length) throw new AggregateError(failures, "Flow browser regression failed", {
    cause: failures[0]
  })
}
if (resolve(process.argv[1] ?? "") === resolve(__filename))
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
