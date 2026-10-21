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

interface FlowBrowserWindow extends Window {
  fixture: {
    calls: unknown[][]
    chat(threadId: string, enabled?: boolean, withChild?: boolean): void
    hideSidebar(): void
    navigation(): unknown[][]
    otherActive(value: unknown): void
    largeRun(approval: boolean): void
    sessionCommands(commands: unknown[]): void
    sessionView(view: Record<string, unknown>): void
  }
  chat: { choice: unknown }
  revealClawPanes(threadId: string, panes: { key: string; openRequestId: string }[]): void
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
      import {revealClawPanes,publishClawNotice,openClawSidebar} from ${source("lib/claw-sidebar.ts")};
      window.publishClawNotice=publishClawNotice;window.revealClawPanes=revealClawPanes;
      import {useAppStore} from "@/lib/store";
      import {ScrollArea} from ${source("components/ui/scroll-area.tsx")};
      import {selectChatFlow} from  ${source("lib/chat-flow-choice.ts")};
      import {useChatFlow} from ${source("lib/use-chat-flow.ts")};
      import {ClawPanel} from ${source("components/customize/ClawPanel.tsx")};
      import {ChatFlowControls} from ${source("components/chat/ChatFlowControls.tsx")};
      import {ChatFlowTaskCards} from ${source("components/chat/ChatFlowTaskCards.tsx")};
      import {requestChatFlowUse} from ${source("lib/chat-flow-use.ts")};
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
      let deferProfile=false, finishProfile, startBlocked=false,deferCreator=false,finishCreator;
      let sourcesFail=false,otherActive=null,registeredCommands=[];
      let sources={skills:[{id:'skill-a',name:'Review',digest:'a'.repeat(64),owner:'个人技能'},{id:'skill-b',name:'Review',digest:'b'.repeat(64),owner:'团队插件'}],mcp:[{id:'mcp-a',name:'Repository',digest:'c'.repeat(64),owner:'全局服务'}]};
      catalog.skills=sources.skills;
      let deferMcp=false,finishMcp;
      const mcpTools=[{provider:sources.mcp[0],toolName:'lookup',schemaDigest:'d'.repeat(64),description:'Lookup records',inputSchema:{type:'object',properties:{query:{type:'string'}}}},{provider:{...sources.mcp[0],id:'other-service',name:'Other'},toolName:'lookup',schemaDigest:'e'.repeat(64),inputSchema:{type:'object'},unavailableReason:'高级 schema 暂不支持'}];
      window.api={featureGates:{isEnabled:async()=>({enabled:false,reason:'fixture'})},mods:{
        completionPolicy:async()=>({source:"default",policy:{mode:"off",scope:"project",checks:["code-review"],maxRepairs:0,timeoutMs:120000,modelTokenBudget:8192}}),
        commands:async()=>structuredClone(registeredCommands),
        flowMcpTools:async id=>{calls.push(['mcpTools',id]);if(deferMcp){deferMcp=false;await new Promise(r=>finishMcp=r)}return structuredClone(mcpTools)},
        clawSources:async()=>{calls.push(['sources']);if(sourcesFail)throw Error('directory unavailable');return structuredClone(sources)},
        clawView:async()=>{viewReads++;const captured=structuredClone(profileView);if(deferProfile){deferProfile=false;await new Promise(r=>finishProfile=r)}return captured},
        clawChange:async(id,mutation)=>{calls.push(['claw',mutation]);if(mutation.revision!==profileView.revision)throw Error('stale revision');if(mutation.kind==='save')profileView.profiles=[mutation.profile];else profileView.active=mutation.id===null?null:profileView.profiles.find(p=>p.id===mutation.id);profileView.revision++;return structuredClone(profileView)},
        onConfigurationChanged:fn=>{configurationListeners.add(fn);return()=>configurationListeners.delete(fn)},
        clawStart:async(id,revision,goal)=>{calls.push(['clawStart',id,revision,goal]);if(revision!==profileView.bindingRevision)throw Error('binding changed');const run={id:'bound'+(++sequence),threadId:id,workspace:id,flow:structuredClone(profileView.active.flow),taskGoal:goal,status:'complete',startedAt:Date.now(),epoch:0,attempts:[],failureCounts:{}};runs.set(run.id,run);emit(id);return run},
        flowCatalog:async id=>{calls.push(['catalog',id]);if(deferCatalog){deferCatalog=false;await new Promise(r=>catalogFinish=r)}return {...catalog,workspace:id}},
        flowList:async id=>{calls.push(['list',id]);return definitions.get(id)||[]},
        flowRuns:async id=>{calls.push(['runs',id]);return [...runs.values()].filter(r=>r.threadId===id).reverse()},
        flowActive:async id=>otherActive||(()=>{const r=[...runs.values()].find(r=>r.workspace===id&&['queued','running','waiting'].includes(r.status));return r?{runId:r.id,threadId:r.threadId,flowName:r.flow.definition.name,status:r.status}:null})(),
        flowRun:async(id,key)=>{calls.push(['run',id,key]);if(deferRead){deferRead=false;await new Promise(r=>readFinish=r)}return runs.get(key)||null},
        flowSave:async(id,definition,revision)=>{calls.push(['save',id,definition,revision]);if(deferSave){deferSave=false;await new Promise(r=>saveFinish=r)}const value={definition,revision:revision+1,digest:'new',updatedAt:2};definitions.set(id,[value]);return value},
        flowStart:async(id,key,revision,task)=>{calls.push(['start',id,key,revision,task]);const flow=definitions.get(id).find(x=>x.definition.id===key);const run={id:'run'+(++sequence),threadId:id,workspace:id,flow,taskGoal:task?.goal,status:'waiting',startedAt:Date.now(),epoch:0,attempts:[],failureCounts:{},pendingApproval:{nonce:'nonce'+sequence,stepId:'accept',executionId:'e'+sequence,inputDigest:'input'+sequence,fingerprint:'fp',summary:'请确认真实测试结果',definitionDigest:flow.digest}};runs.set(run.id,run);emit(id);return run},
        flowDecide:async(id,key,nonce,approve)=>{calls.push(['decide',id,key,nonce,approve]);const run={...runs.get(key),status:approve?'complete':'failed',pendingApproval:undefined,summary:approve?'成果已确认':'人工拒绝'};runs.set(key,run);emit(id);return run},
        flowCancel:async(id,key)=>{calls.push(['cancel',id,key]);runs.set(key,{...runs.get(key),status:'cancelled',pendingApproval:undefined});emit(id)},
        onFlowChanged:(id,fn)=>{if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(fn);return()=>listeners.get(id).delete(fn)}
      }};
      let panelMounts=0,panelUnmounts=0;
      function Probe(){useEffect(()=>{panelMounts++;return()=>{panelUnmounts++}},[]);return <p>受控插件结果</p>}
      function ChatFixture({id,enabled=true,withChild=false,taskOverview,taskWorking=false}) {
        const flow=useChatFlow(id,id,enabled);
        const [input,setInput]=useState(''),[childClicks,setChildClicks]=useState(0),[submitError,setSubmitError]=useState('');
        const visible=useAppStore(s=>s.rightModule==='claw'&&!s.rightPanelCollapsed);
        window.chat=flow;
        const start=async goal=>{if(startBlocked)throw Error("正在准备发送消息");const submission=flow.submit(goal);capturedSubmit=submission;submitSettled=false;try{return await submission}finally{submitSettled=true}};
        return <><ScrollArea style={{height:200}}><p>消息记录 {flow.run?.status}</p></ScrollArea>
          <ChatFlowTaskCards flow={flow} onFollowUp={text=>setInput(text)}/>
          {submitError&&<p role="alert">{submitError}</p>}
          <form onSubmit={async e=>{e.preventDefault();const submitted=input;setSubmitError('');if(flow.choice){try{if(await start(submitted))setInput(value=>value===submitted?'':value)}catch(error){setSubmitError(error.message)}}else{calls.push(['chat',id,input]);setInput('')}}}>
          <ClawComposerBar threadId={id} flow={flow}>{withChild&&<button type="button" aria-label="灵件工作台" onClick={()=>setChildClicks(n=>n+1)}>灵件 {childClicks}</button>}</ClawComposerBar>
          <textarea aria-label="聊天消息" className="composer-textarea" value={input} onChange={e=>setInput(e.target.value)}/>
          <button type="submit" disabled={flow.choice&&(flow.busy||flow.active||!flow.enabled)}>{flow.choice?'按此步骤执行':'发送聊天'}</button></form>
          <div hidden={!visible} inert={!visible}><ClawSidebarHost threadId={id}/></div>
          <ClawSidebar threadId={id} flow={flow} disabled={false} taskOverview={taskOverview} taskWorking={taskWorking} onStart={start} onFollowUp={text=>setInput(text)} onRequestCreator={async text=>{calls.push(["creator",id,text]);if(deferCreator){deferCreator=false;await new Promise(resolve=>finishCreator=resolve)}setInput(value=>[value,text].filter(Boolean).join("\\n\\n"))}}><Probe/></ClawSidebar>
        </>
      }
      window.fixture={use:requestChatFlowUse,otherActive:value=>otherActive=value,sourcesFail:value=>sourcesFail=value,sources:value=>sources=value,bindFlow:()=>{profileView.active={id:'bound',name:'Bound Claw',capabilities:[],models:{default:'m2',roles:{}},flow:saved('a')};profileView.bindingRevision=7;for(const fn of configurationListeners)fn()},panelCounts:()=>[panelMounts,panelUnmounts],hideSidebar:()=>useAppStore.getState().setRightPanelCollapsed(true),profile:()=>host.render(<ClawPanel threadId='a'/>),deferProfile:()=>deferProfile=true,finishProfile:()=>finishProfile(),configuration:()=>{for(const fn of configurationListeners)fn()},project:(enabled,applicable=true)=>{profileView.enabled=enabled;profileView.applicable=applicable;for(const fn of configurationListeners)fn()},blockStart:()=>startBlocked=true,select:selectChatFlow,chat:(id,enabled=true,withChild=false)=>host.render(<ChatFixture id={id} enabled={enabled} withChild={withChild}/>),updateVersion:id=>{definitions.get(id)[0].revision++},revoke:()=>{catalog.plugins[0].authorized=false},calls,render:id=>host.render(<FlowsPanel threadId={id}/>),unmount:()=>host.render(null),
        listeners:()=>[...listeners.values()].reduce((n,s)=>n+s.size,0),deferSave:()=>deferSave=true,finishSave:()=>saveFinish(),
        deferRead:()=>deferRead=true,finishRead:()=>readFinish(),deferCatalog:()=>deferCatalog=true,finishCatalog:()=>catalogFinish(),catalogPending:()=>typeof catalogFinish==='function',
        hasCapturedSubmit:()=>capturedSubmit!==null,submitSettled:()=>submitSettled,waitForSubmit:()=>capturedSubmit.then(()=>undefined,()=>undefined),readCounts:()=>({binding:viewReads,runs:calls.filter(c=>c[0]==='runs').length,catalog:calls.filter(c=>c[0]==='catalog').length,list:calls.filter(c=>c[0]==='list').length}),
        deferMcp:()=>deferMcp=true,finishMcp:()=>finishMcp(),emit,navigation:()=>window.navigationCalls||[],large:()=>{const large=definition('large');large.steps=Array.from({length:64},(_,i)=>({id:'s'+i,name:'步骤'+i,enabled:true,kind:'agent',prompt:'做事'}));const render=d=>host.render(<FlowEditor value={d} catalog={catalog} disabled={false} onChange={render}/>);render(large)},
        largeRun:(approval=false)=>{const run={id:'large',threadId:'a',workspace:'a',flow:saved('a'),status:approval?'waiting':'complete',startedAt:1,epoch:10,failureCounts:{},attempts:Array.from({length:256},(_,i)=>({executionId:'e'+i,stepId:'build',attempt:i+1,epoch:i,status:'passed',startedAt:i,result:{passed:true,summary:'结果'+i,source:'agent'}}))};if(approval){run.flow.definition.steps=Array.from({length:64},(_,i)=>({id:'s'+i,name:'步骤'+i,enabled:true,kind:'agent',prompt:'做事'}));run.pendingApproval={nonce:'n',summary:'确认完整成果',inputDigest:'digest'}}host.render(<FlowRunView run={run} busy={false} onDecide={()=>{}} onCancel={()=>{}}/>)}
      };
      window.fixture.deferCreator=()=>deferCreator=true;window.fixture.finishCreator=()=>finishCreator();
      window.fixture.sessionView=value=>{profileView={...profileView,...value};for(const fn of configurationListeners)fn()};
      window.fixture.sessionCommands=value=>registeredCommands=value;
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
                const listeners=new Set();let previous;const notify=()=>{const before=previous;previous={...state};for(const fn of listeners)fn(state,before)};
                const state={accountRevision:0,currentThreadId:'a',mainView:'thread',rightModule:'work',rightPanelCollapsed:true,
                  threads:[{thread_id:'a',metadata:{workspacePath:'a',agentMode:'normal'}},{thread_id:'b',metadata:{workspacePath:'b',agentMode:'normal'}}],
                  models:[{id:'m2',name:'Model Two',model:'model-two',source:'custom',provider:'custom',available:true}],
                  setRightModule:value=>{state.rightModule=value;notify()},setRightPanelCollapsed:value=>{state.rightPanelCollapsed=value;notify()},
                  selectThread:async(id)=>{state.currentThreadId=id;(window.navigationCalls??=[]).push(['thread',id]);notify()},
                  setShowCustomizeView:(...args)=>{(window.navigationCalls??=[]).push(args)}};previous={...state};
                export const useAppStore=selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(state));
                useAppStore.getState=()=>state;
                useAppStore.subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener)};
                export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;`
          }))
        }
      }
    ]
  })
  await page.goto("about:blank")
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: result.outputFiles[0].text })
}

export async function chooseSteps(page: Page, value?: string) {
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await page.getByRole("tab", { name: "高级设置", exact: true }).click()
  const select = page.getByRole("combobox", { name: "本次使用的步骤", exact: true })
  if (!await select.isVisible())
    await page.getByText("高级：为下一条消息使用预设任务", { exact: true }).click()
  if (!value) {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLSelectElement>(
      '[aria-label="本次使用的步骤"]'
    )].some(element => element.options.length > 1))
    value = await select.locator("option").nth(1).getAttribute("value") ?? undefined
  }
  assert(value, "The real catalog must contain a selectable saved flow")
  await select.selectOption(value)
  await page.keyboard.press("Escape")
}

export async function startFromEditor(page: Page) {
  const use = page.getByRole("button", { name: "去这段聊天使用", exact: true })
  if (await use.count()) {
    const before = await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter(
      (call: unknown[]) => call[0] === "start"
    ).length)
    await use.click()
    assert.equal(await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter(
      (call: unknown[]) => call[0] === "start"
    ).length), before)
    await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.chat("a"))
    await page.getByLabel("聊天消息").waitFor()
  }
  await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.hideSidebar())
  if (!await page.evaluate(() => (window as unknown as FlowBrowserWindow).chat.choice)) await chooseSteps(page)
  await page.getByLabel("聊天消息").fill("完成隔离流程任务")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
}

async function commandSettings(page: Page) {
  await mount(page, "registeredCommands=[{modId:'function:Demo',command:'set-weather',name:'设置本地天气',digest:'a'.repeat(64),argumentHint:'天气文字'},{modId:'function:Demo',command:'private',name:'隐藏命令',digest:'a'.repeat(64),isHidden:true},{modId:'function:Demo',command:'stale',name:'旧版本',digest:'b'.repeat(64)}];host.render(<ChatFixture id='a'/>);openClawSidebar('configuration');")
  await page.getByRole("tab", { name: "高级设置", exact: true }).click()
  await page.getByText('这个灵件没有设置表单', { exact: false }).waitFor()
  await page.getByRole('button', { name: /set-weather.*设置本地天气/ }).click()
  assert.equal(await page.getByLabel('聊天消息').inputValue(), '/set-weather ')
  assert.equal(await page.getByRole('button', { name: /隐藏命令|旧版本/ }).count(), 0)
  assert.equal(await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter((c: unknown[]) => ['start','chat','decide'].includes(c[0] as string)).length), 0)
  await page.screenshot({path:join(outputFolder('commands'),'settings.png'),fullPage:true})
  pass('Applied command-only plugin exposes current public commands, fills ordinary chat without executing and excludes stale/hidden commands')
}

async function crossThreadBusy(page: Page) {
  await mount(page, "otherActive={runId:'foreign',threadId:'b',flowName:'资料审核',status:'waiting'};host.render(<FlowsPanel threadId='a'/>);")
  await page.getByText('本项目的另一会话正在运行', { exact: false }).waitFor()
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '去这段聊天使用', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '前往运行所在会话', exact: true }).click()
  const navigation = await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.navigation())
  assert(navigation.some((value: unknown[]) => value.includes('b')))
  assert.equal(await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter((c: unknown[]) => ['start','cancel','decide'].includes(c[0] as string)).length), 0)
  await page.evaluate(() => { (window as unknown as FlowBrowserWindow).fixture.otherActive(null) })
  await page.getByRole('button', { name: '去这段聊天使用', exact: true }).waitFor()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '去这段聊天使用')?.disabled)
  await mount(page, "otherActive={runId:'foreign',threadId:'b',flowName:'资料审核',status:'waiting'};host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("保留这次需求")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: /本项目正在运行/ }).waitFor()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留这次需求")
  assert.equal(await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter((c: unknown[]) => c[0]==='start').length), 0)
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await page.getByRole("tab", { name: "当前任务", exact: true }).click()
  await page.getByRole("button", { name: "前往处理", exact: true }).click()
  assert((await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.navigation())).some((entry:unknown[])=>entry.includes('b')))
  pass('Cross-chat active owner is visible, blocks start, navigates without cancellation and clears after completion')
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
  assert(await page.getByRole("button", { name: "去这段聊天使用", exact: true }).isDisabled())
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
  await startFromEditor(page)
  await page.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
  await page
    .getByText("流程正在等你确认操作或补充信息。", { exact: true })
    .waitFor()
  await page.getByRole("button", { name: "返回当前任务处理", exact: true }).click()
  assert.deepEqual(await page.evaluate("window.fixture.navigation().at(-1)"), ["thread", "a"])
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide').length"), 0)
  await page.getByRole("button", { name: "同意并继续", exact: true }).dblclick()
  await page.locator("[data-chat-flow-tasks]").getByText("成果已确认", { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide')"), [
    ["decide", "a", "run1", "nonce1", true]
  ])
  await startFromEditor(page)
  await page.getByRole("button", { name: "拒绝并停止", exact: true }).click()
  await page.locator("[data-chat-flow-tasks]").getByText("人工拒绝", { exact: true }).waitFor()
  await startFromEditor(page)
  await page.locator("[data-chat-flow-tasks]").getByRole("button", { name: "停止任务", exact: true }).click()
  await page.locator("[data-chat-flow-tasks]")
    .getByRole("heading", { name: "当前任务 · 已停止", exact: true }).waitFor()
  assert.equal(await page.evaluate("window.chat.run?.status"), "cancelled")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='cancel').length"), 1)
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
  assert(await page.getByRole("button", { name: "去这段聊天使用", exact: true }).isDisabled())
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
  await startFromEditor(page)
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
  await page.getByText("历史步骤与技术详情",{exact:true}).click()
  await page.getByRole("list", { name: "步骤执行记录", exact: true }).waitFor()
  assert.equal(
    await page.getByRole("list", { name: "步骤执行记录", exact: true }).locator("li").count(),
    256
  )
  await mount(page, "window.fixture.largeRun(true)")
  const approval = await page.getByRole("region", {name:"人工成果确认"}).boundingBox()
  const progress = page.locator('[data-flow-run="large"]').getByRole("list", {
    name: "当前步骤进度", includeHidden: true
  })
  assert.equal(await progress.isVisible(), false, "Detailed steps stay folded before explicit inspection")
  await page.getByText("查看全部 64 步与结果", { exact: true }).click()
  assert.equal(await progress.locator("li").count(), 64)
  const steps = await page.locator('[data-flow-run="large"]').getByRole("list", {name:"当前步骤进度"}).boundingBox()
  assert(approval && steps && approval.y + approval.height <= steps.y,
    "Human approval stays above all 64 steps")
  for (const waiting of [false, true, false, true]) {
    await page.evaluate((value) => (window as unknown as FlowBrowserWindow).fixture.largeRun(value), waiting)
    await settle(page)
    const lists = await page.locator('[data-flow-run="large"] [aria-label="当前步骤进度"]').count()
    if (lists !== 1) writeFileSync(join(outputFolder("transition"), "duplicate.html"), await page.content())
    assert.equal(lists, 1, `Same-run transition waiting=${waiting} retains one progress list`)
  }
  pass(
    `navigation performs zero flow IPC; 64-step editor p95 ${p95.toFixed(1)}ms; 256 attempts render bounded details`
  )
}

async function sessionSelectionDisplay(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);openClawSidebar('configuration');")
  await page.getByRole("tab", { name: "高级设置", exact: true }).click()
  const sources = [
    { pluginId: "weather", name: "Weather", digest: "a".repeat(64), state: "ready", capabilities: [] },
    { pluginId: "replay", name: "Replay", digest: "b".repeat(64), state: "ready", capabilities: [] }
  ]
  const profile = (index: number) => ({
    id: `selected-${index}`, name: `本聊天助手-${index}`, capabilities: [sources[index]]
  })
  await page.evaluate((input) => {
    const fixture = (window as unknown as FlowBrowserWindow).fixture
    fixture.sessionCommands(input.map(item => ({
      modId: `function:${item.name}`, command: item.pluginId,
      name: `${item.name} 专用命令`, digest: item.digest
    })))
    fixture.sessionView({ capabilities: input, active: null })
  }, sources)
  const configuration = page.locator("[data-desktop-selection-excluded]")
  for (const index of [0, 1]) {
    await page.evaluate((active) => (window as unknown as FlowBrowserWindow).fixture.sessionView({ active }), profile(index))
    await configuration.getByText(`本聊天助手-${index}`, { exact: true }).waitFor()
    await configuration.getByRole("button", { name: new RegExp(`${sources[index].name} 专用命令`) }).waitFor()
    assert.equal(await configuration.getByRole("button", {
      name: new RegExp(`${sources[1 - index].name} 专用命令`)
    }).count(), 0, "Other authorized source is not this session's command")
  }
  await page.evaluate((active) => (window as unknown as FlowBrowserWindow).fixture.sessionView({
    active, issues: ["Replay 的已选版本已变化，请重新核对。"]
  }), profile(1))
  await configuration.getByText("这段聊天已选择，当前未生效", { exact: true }).waitFor()
  assert.equal(await configuration.getByRole("button", { name: /专用命令/ }).count(), 0)
  await configuration.getByText("Replay 的已选版本已变化，请重新核对。", { exact: true }).waitFor()
  await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.sessionView({
    active: { id: "empty", name: "空组合", capabilities: [] }, issues: []
  }))
  await configuration.getByText("空组合", { exact: true }).waitFor()
  assert.equal(await configuration.getByRole("button", { name: /专用命令/ }).count(), 0)
  await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.sessionView({ active: null }))
  await configuration.getByText("这段聊天使用默认功能", { exact: true }).waitFor()
  await configuration.getByRole("button", { name: /Weather 专用命令/ }).waitFor()
  await configuration.getByRole("button", { name: /Replay 专用命令/ }).waitFor()
  await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.sessionView({ enabled: false }))
  await configuration.getByText("当前没有生效的灵件", { exact: true }).waitFor()
  assert.equal(await configuration.getByRole("button", { name: /专用命令/ }).count(), 0)
  pass("Session selection excludes other plugins; invalid, empty, default and disabled states are truthful")
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
  assert.equal(await page.getByRole("tab", { name: "流程配置", exact: true }).getAttribute("aria-selected"), "true")
  assert.equal(await page.getByText("运行过程与历史", { exact: true }).count(), 0)
  await page.getByRole("tab", { name: "执行记录", exact: true }).click()
  await page.getByText("这段聊天还没有执行记录", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "保存流程", exact: true }).isVisible(), false)
  await page.getByRole("tab", { name: "执行记录", exact: true }).press("ArrowLeft")
  await page.getByRole("button", { name: "保存流程", exact: true }).waitFor()
  assert.equal(await page.getByRole("tab", { name: "流程配置", exact: true }).getAttribute("aria-selected"), "true")
  assert.equal(await page.getByText("这段聊天还没有执行记录", { exact: true }).count(), 0)
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
  await startFromEditor(page)
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
  assert.equal(await page.getByRole("button", { name: "选择发送方式" }).count(), 0)
  await page.getByLabel("聊天消息").fill("同一份聊天草稿")
  await chooseSteps(page, "flow_a:1")
  assert.equal(await page.locator("textarea").count(), 1)
  assert.equal(await page.locator("[data-chat-flow] textarea").count(), 0)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "同一份聊天草稿")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await page.getByRole("button", { name: "改为普通发送", exact: true }).click()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "同一份聊天草稿")
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 1)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.chat('b')")
  await page.waitForFunction("window.chat.threadId==='b'")
  assert.equal(await page.evaluate("window.chat.choice"), null)
  await page.evaluate("window.fixture.chat('a')")
  await page.waitForFunction("window.chat.choice?.id==='flow_a'")
  await page.getByLabel("聊天消息").fill("流程专用任务目标")
  const assets = join(root, "out/renderer/assets")
  const css = readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
  assert(css)
  await page.addStyleTag({ path: join(assets, css) })
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await page.getByRole("tab", { name: "当前任务", exact: true }).click()
  const captureFixed = async (state: string) => {
    for (const width of [300, 420]) {
      await page.setViewportSize({ width, height: 1000 })
      const region = page.getByRole("complementary", { name: "任务进展", exact: true })
      assert(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
        `Flow area overflow at ${width}`)
      await region.screenshot({ path: join(outputFolder("fixed-flow"), `${state}-${width}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 960 })
  }
  await captureFixed("ready")
  await page.getByRole("button", { name: "收起任务进展", exact: true }).click()
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  assert.equal(await page.evaluate("window.chat.choice"), null)
  assert.equal(await page.locator("[data-chat-task-id='run1']").count(), 1)
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  assert.equal(await page.getByRole("tab", { name: "当前任务", exact: true }).getAttribute("aria-selected"), "true")
  assert.equal(await page.locator("[data-chat-flow-run]").count(), 1)
  await page.evaluate(() => (window as unknown as FlowBrowserWindow).revealClawPanes("a", [{ key: "canvas", openRequestId: "new" }]))
  assert.equal(await page.getByRole("tab", { name: "当前任务", exact: true }).getAttribute("aria-selected"), "true")
  await page.getByRole("button", { name: "有新的灵件记录 · 查看", exact: true }).waitFor()
  await captureFixed("running")
  pass("One composer owns the task draft; explicit choice/cancel never executes, scope selection stays local, and the sidebar retains its active task across notices")
}

async function chatBridge(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='catalog').length"), 0)
  await chooseSteps(page, "flow_a:1")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await page.getByLabel("聊天消息").fill("检查订单导出")
  const execute = page.getByRole("button", { name: "按此步骤执行", exact: true })
  await execute.evaluate(element => {
    if (!(element instanceof HTMLButtonElement)) throw Error("Expected an execution button")
    element.click()
    element.click()
  })
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  const starts = await page.evaluate<FlowStartCall[]>("window.fixture.calls.filter(c=>c[0]==='start')")
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0][4], { workspace: "a", goal: "检查订单导出" })
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "")
  assert.equal(await page.evaluate("window.chat.choice"), null)
  await page.getByRole("button", { name: "同意并继续", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='complete'")
  assert.equal(await page.locator("[data-chat-task-id='run1']").count(), 1)
  await chooseSteps(page, "flow_a:1")
  await page.getByLabel("聊天消息").fill("检查权限控制")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  await page.locator("[data-chat-task-id='run2']").getByRole("button", { name: "停止任务", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='cancelled'")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='save').length"), 0)
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.updateVersion('a')")
  await page.getByLabel("聊天消息").fill("保留这个新需求")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: /流程已更新或移除/ }).first().waitFor()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留这个新需求")
  await chooseSteps(page, "flow_a:2")
  await page.evaluate("window.fixture.revoke()")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("alert").filter({ hasText: /尚未开启或授权/ }).first().waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 2)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 0)
  await page.getByRole("button", { name: "改为普通发送", exact: true }).click()
  await page.getByLabel("聊天消息").fill("为什么失败？")
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 2)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 1)
  pass("Explicit composer send freezes task, prevents double start, consumes successful choice and keeps revision/permission failures with their draft")

  await page.evaluate("window.fixture.use({threadId:'a',workspace:'a',id:'flow_a',name:'Flow a',revision:2});window.fixture.chat('a',false)")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  const count = await page.evaluate("window.fixture.calls.length")
  assert.equal(await page.getByRole("button", { name: "按此步骤执行", exact: true }).isDisabled(), true)
  assert.equal(await page.evaluate("window.fixture.calls.length"), count)
  await page.evaluate("window.fixture.chat('b',true)")
  await settle(page)
  assert.equal(await page.evaluate("window.chat.choice"), null)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 2)
  pass("Mods-off never calls flow IPC and a different thread does not inherit the one-message selection")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByLabel("聊天消息").fill("旧项目的任务")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.waitForFunction("window.fixture.catalogPending()")
  await page.evaluate("window.fixture.chat('b',true)")
  await settle(page)
  await page.evaluate("window.fixture.chat('a',true)")
  await settle(page)
  await page.evaluate("window.fixture.finishCatalog()")
  await page.waitForFunction("window.fixture.submitSettled()")
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
  await page.getByRole("button", { name: "应用到所选聊天", exact: true }).click()
  await page.getByRole("button", { name: "确认应用", exact: true }).click()
  await page.getByText("当前组合：Reviewed Claw", { exact: true }).waitFor()
  await page.evaluate("window.fixture.finishProfile()")
  await settle(page)
  await page.getByText("当前组合：Reviewed Claw", { exact: true }).waitFor()
  await page.getByLabel("助手组合名称").fill("Reviewed Claw updated")
  await page.getByRole("button", { name: "保存组合", exact: true }).click()
  await page.waitForFunction("window.fixture.calls.filter(c=>c[0]==='claw').length===3")
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
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("保留流程目标")
  await page.evaluate("window.fixture.blockStart()")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByText("正在准备发送消息", { exact: false }).waitFor()
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留流程目标")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  pass("rejected shared-lock admission preserves the flow goal and dispatches no run")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByLabel("聊天消息").fill("核对选择身份")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.evaluate(
    "window.fixture.select('a',{workspace:'a',id:'flow_a',revision:1,name:'new selection'}); window.fixture.finishCatalog()"
  )
  await page.getByText(/流程选择已改变/).waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  pass("changing selection during preflight cannot dispatch the earlier choice")
}

async function sidebarLifecycle(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.getByLabel("聊天消息").fill("取消选择后普通聊天")
  await page.getByRole("button", { name: "改为普通发送", exact: true }).click()
  await page.getByRole("button", { name: "发送聊天", exact: true }).click()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='chat').length"), 1)
  await chooseSteps(page, "flow_a:1")
  await page.getByLabel("聊天消息").fill("检视订单导出")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认" }).waitFor()
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  const observers = await page.evaluate("window.fixture.listeners()")
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: "收起任务进展", exact: true }).click()
    await page.getByRole("button", { name: "查看任务进展", exact: true }).waitFor()
    await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  }
  assert.deepEqual(await page.evaluate("window.fixture.panelCounts()"), [1, 0])
  assert.equal(await page.evaluate("window.fixture.listeners()"), observers)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 1)
  await page.evaluate("window.publishClawNotice('a','jobs','插件命令执行中')")
  await page.getByRole("button", { name: "插件命令执行中 · 查看", exact: true }).click()
  await page.locator("[data-claw-results]").waitFor()
  assert.equal(await page.getByRole("tab", { name: "结果", exact: true }).getAttribute("aria-pressed"), "true")
  assert.equal(await page.locator("[data-chat-flow-run]").count(), 0,
    "Hidden sidebar details release their duplicate run view")
  assert.equal(await page.locator("[data-chat-task-id='run1']").count(), 1)
  assert.equal(await page.locator("[data-chat-flow-tasks]").getByRole("button", { name: "同意并继续", exact: true }).count(), 1)
  await page.getByRole("tab", {name:"当前任务",exact:true}).click()
  await page.locator("[data-chat-flow-run]").waitFor()
  await page.evaluate("window.chat.act('approve',{runId:'run1',nonce:'stale'})")
  await page.getByRole("alert").filter({ hasText: "确认内容已更新，请核对当前成果后重新确认。" }).first().waitFor()
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='decide').length"), 0)
  await page.locator("[data-chat-flow-tasks]").getByRole("button", { name: "同意并继续", exact: true }).dblclick()
  await page.waitForFunction("window.chat.run.status==='complete'")
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
  await page.waitForFunction("window.chat.binding?.bindingRevision===7")
  assert.equal(await page.evaluate("window.chat.choice"), null)
  await page.getByRole("button", { name: "发送聊天", exact: true }).waitFor()
  await chooseSteps(page, "claw:7")
  assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
  await page.evaluate("window.fixture.updateVersion('a')")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("使用绑定副本")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.waitForFunction("window.chat.run?.id==='bound1'")
  assert.equal(await page.evaluate("window.chat.run.flow.revision"), 1)
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='clawStart')"), [
    ["clawStart", "a", 7, "使用绑定副本"]
  ])
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  pass(
    "applying a bound flow preserves chat intent; changed template starts the frozen Claw API with binding revision"
  )
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await page.getByRole("tab", { name: "当前任务", exact: true }).click()
  await page.locator("[data-chat-flow-tasks]").getByRole("button", { name: "继续处理这个任务", exact: true }).click()
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
  await skills.getByRole("radio", { name: "仅使用所选", exact: true }).check()
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
  await skills.getByRole("radio", { name: "使用全部已开启项", exact: true }).check()
  await mcp.getByRole("radio", { name: "使用全部已开启项", exact: true }).check()
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
  await skills.getByRole("radio", { name: "仅使用所选", exact: true }).check()
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
  await page.getByRole("button", { name: "查看任务进展", exact: true }).click()
  await page.getByRole("tab", { name: "高级设置", exact: true }).click()
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
  await page.getByText("如何开始任务？", { exact: true }).click()
  const everydayGuide = await page.locator("[data-flow-usage]").innerText()
  assert.match(everydayGuide, /无需先配置任务方案/)
  assert.match(everydayGuide, /任务进展/)
  assert.doesNotMatch(everydayGuide, /先加载工具列表/)
  await page.getByText("高级：使用手动保存的任务方案", { exact: true }).click()
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
  assert.match(guide, /手动编辑器用于明确安排先后顺序/)
  assert.match(guide, /外部服务的工具（MCP）/)
  assert.match(guide, /先加载工具列表/)
  assert.match(guide, /传递前一步结果/)
  assert.match(guide, /每轮任务只调用该工具一次/)
  assert.match(guide, /停止或重试不会撤销已经完成的文件修改或外部操作/)
  assert.match(guide, /聊天的同一个输入框填写目标/)
  assert.match(guide, /绑定不会改变普通发送/)
  assert.match(guide, /成功启动后恢复普通发送/)
  assert.match(guide, /改为普通发送/)
  assert.match(guide, /普通发送也不会自动执行已保存方案/)
  assert.doesNotMatch(guide, /聊天输入框始终用于普通聊天|在流程任务中.*填写目标/)
  assert.doesNotMatch(guide, /上述四类步骤|不会自动变成新的步骤类型/)
  await page.getByText("如何开始任务？", { exact: true }).click()
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
  await page.waitForFunction("window.chat.binding?.bindingRevision===7")
  assert.equal(await page.evaluate("window.chat.choice"), null)
  await chooseSteps(page, "claw:7")
  assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("关闭项目后保留的流程目标")
  const choice = await page.evaluate("JSON.stringify(window.chat.choice)")
  await page.evaluate("window.fixture.project(false)")
  await page.waitForFunction("window.chat.enabled===false")
  assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
  assert.equal(await page.getByRole("button", { name: "查看任务进展", exact: true }).isDisabled(), false)
  assert.equal(
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).isDisabled(),
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
  assert.equal(await page.getByLabel("当前助手指定的聊天模型").count(), 0)
  assert.equal(await page.evaluate("JSON.stringify(window.chat.choice)"), choice)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "关闭项目后保留的流程目标")
  assert.equal(
    await page.getByRole("button", { name: "按此步骤执行", exact: true }).isDisabled(),
    false
  )
  pass("Project OFF/applicable false pause the real controller and model badge without losing the applied choice or draft; ON restores them")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("关闭前已经启动的任务")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
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
  await page.locator("[data-chat-flow-tasks]").getByRole("button", { name: "停止任务", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='cancelled'")
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='cancel')"), [
    ["cancel", "a", "run1"]
  ])
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "保留到下一次发送的草稿")
  await page.evaluate("window.fixture.project(true)")
  await page.waitForFunction("window.chat.enabled===true")
  assert.equal(await page.evaluate("window.chat.choice"), null)
  pass("Project OFF blocks approval and rejection but its existing owned run can still be cancelled through the real stop button")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("预检结束前关闭的任务")
  const preflightChoice = await page.evaluate("JSON.stringify(window.chat.choice)")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.waitForFunction("window.fixture.catalogPending()")
  await page.evaluate("window.fixture.project(false);window.fixture.project(true)")
  assert.equal(await page.evaluate("window.chat.enabled"), true)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  await page.evaluate("window.fixture.finishCatalog()")
  await page.waitForFunction("window.chat.enabled===true && !window.chat.busy && !window.chat.loading")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.evaluate("JSON.stringify(window.chat.choice)"), preflightChoice)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "预检结束前关闭的任务")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.getByRole("region", { name: "人工成果确认", exact: true }).waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start')"), [
    ["start", "a", "flow_a", 1, { workspace: "a", goal: "预检结束前关闭的任务" }]
  ])
  pass("OFF→ON notifications while preflight is held do not revive the old task; its choice and input start only after a new explicit send")
}

async function deferredUnmount(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.evaluate("window.fixture.hideSidebar()")
  await page.getByLabel("聊天消息").fill("卸载前尚未完成的流程预检")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
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

async function scopeReloadAfterLockedOperation(page: Page) {
  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.getByLabel("聊天消息").fill("范围恢复后保留的任务")
  await page.evaluate("window.fixture.deferCatalog()")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.waitForFunction("window.fixture.catalogPending()")
  await page.evaluate("window.fixture.chat('a',false)")
  await page.waitForFunction("window.chat.enabled===false")
  await page.evaluate("window.fixture.chat('a',true)")
  await page.waitForFunction("window.chat.enabled===true")
  await page.evaluate("window.fixture.finishCatalog()")
  await page.evaluate("window.fixture.waitForSubmit()")
  await settle(page)
  assert.equal(await page.evaluate("window.chat.binding?.workspace"), "a",
    "Reactivated scope must reload its binding after the old preflight releases its lock")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 0)
  assert.equal(await page.getByLabel("聊天消息").inputValue(), "范围恢复后保留的任务")
  assert.equal(await page.evaluate("window.chat.choice.id"), "flow_a")

  await mount(page, "host.render(<ChatFixture id='a'/>);")
  await chooseSteps(page, "flow_a:1")
  await page.getByLabel("聊天消息").fill("停止结果需要留在原任务")
  await page.getByRole("button", { name: "按此步骤执行", exact: true }).click()
  await page.waitForFunction("window.chat.run?.status==='waiting'")
  await page.evaluate(`const cancel=window.api.mods.flowCancel;
    window.api.mods.flowCancel=async(...args)=>{
      await new Promise(resolve=>window.finishScopeCancel=resolve);return cancel(...args)
    };void(window.scopeCancel=window.chat.act('cancel'))`)
  await page.waitForFunction("window.chat.stopping")
  await page.evaluate("window.fixture.chat('a',false)")
  await page.waitForFunction("window.chat.enabled===false")
  await page.evaluate("window.fixture.chat('a',true)")
  await page.waitForFunction("window.chat.enabled===true")
  await page.evaluate("window.finishScopeCancel()")
  await page.evaluate("window.scopeCancel")
  await settle(page)
  assert.equal(await page.evaluate("window.chat.run?.status"), "cancelled",
    "Stop result must reload after reactivation while cancel holds the lock")
  assert.equal(await page.evaluate("window.chat.binding?.workspace"), "a")
  assert.equal(await page.evaluate("window.chat.recentRuns.length"), 1)
  assert.equal(await page.locator("[data-chat-task-id='run1']").count(), 1)
  assert(await page.evaluate<number>("window.fixture.listeners()") > 0,
    "The restored run must regain progress observers")
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='cancel').length"), 1)
  assert.equal(await page.evaluate("window.fixture.calls.filter(c=>c[0]==='start').length"), 1)
  await page.evaluate("window.fixture.unmount()")
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  pass("Scope reactivation reloads binding, task result and observers after held preflight/stop; no task is replayed")
}

async function flowWorkspaceSeparation(page: Page) {
  await mount(page, "runs.set('historic',{id:'historic',threadId:'a',workspace:'a',flow:saved('a'),status:'complete',startedAt:1,epoch:1,attempts:[],failureCounts:{},summary:'上次任务已经完成'});host.render(<FlowsPanel threadId='a'/>);")
  await page.getByRole("button", { name: "Flow a", exact: true }).click()
  const goal = page.getByLabel("流程名称", { exact: true })
  await goal.fill("还没有保存的新流程名称")
  assert.equal(await page.getByText("上次任务已经完成", { exact: true }).count(), 0)
  await page.getByRole("tab", { name: "执行记录", exact: true }).click()
  await page.getByText("这段聊天执行过的任务", { exact: true }).waitFor()
  assert.equal(await goal.isVisible(), false)
  await page.getByRole("tab", { name: "流程配置", exact: true }).click()
  assert.equal(await goal.inputValue(), "还没有保存的新流程名称")
  assert.equal(await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter((call:unknown[]) => ["start", "save", "decide", "cancel"].includes(String(call[0]))).length), 0)
  pass("Flow configuration and execution records are separate; switching preserves unsaved edits and starts no work")
}

async function optionalCatalogIsolation(page: Page) {
  await mount(page, "catalog.diagnostics=[{source:'optional-provider',code:'UNAVAILABLE',message:'部分可选目录不可用，其他流程仍可配置。'}];host.render(<FlowsPanel threadId='a'/>);")
  await page.getByRole("status", { name: "可选目录读取提示" }).getByText(
    "部分可选目录不可用，其他流程仍可配置。", { exact: true }
  ).waitFor()
  await page.getByRole("button", { name: "新建通用开发流程", exact: true }).click()
  await page.getByLabel("流程名称", { exact: true }).fill("独立业务流程")
  assert.equal(await page.getByLabel("流程名称", { exact: true }).inputValue(), "独立业务流程")
  await page.screenshot({ path: join(outputFolder("optional-provider"), "configuration.png"), fullPage: true })
  assert.equal(await page.evaluate(() => (window as unknown as FlowBrowserWindow).fixture.calls.filter((call: unknown[]) => ["start", "save", "decide", "cancel"].includes(String(call[0]))).length), 0)
  pass("Optional provider diagnostics preserve ordinary flow configuration without starting work")
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
    if (process.argv.includes("--optional-catalog-only")) {
      await group("optionalCatalogIsolation", optionalCatalogIsolation)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--scope-lock-only")) {
      await group("scopeReloadAfterLockedOperation", scopeReloadAfterLockedOperation)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--selection-only")) {
      await group("sessionSelectionDisplay", sessionSelectionDisplay)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--scale-only")) {
      await group("navigationAndScale", navigationAndScale)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--fixed-only")) {
      await group("compactComposer", compactComposer)
      await group("chatBridge", chatBridge)
      await group("clawRaces", clawRaces)
      await group("sidebarLifecycle", sidebarLifecycle)
      await group("projectActivation", projectActivation)
      await group("deferredUnmount", deferredUnmount)
      await group("scopeReloadAfterLockedOperation", scopeReloadAfterLockedOperation)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--busy-only")) {
      await group("crossThreadBusy", crossThreadBusy)
      await group("commandSettings", commandSettings)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--workspace-only")) {
      await group("flowWorkspaceSeparation", flowWorkspaceSeparation)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--entry-only")) {
      await group("templateAndValidation", templateAndValidation)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--native-only")) {
      await group("nativeSteps", nativeSteps)
      assert.deepEqual(errors, [])
    } else if (process.argv.includes("--sources-only")) {
      await group("sourceComposition", sourceComposition)
      assert.deepEqual(errors, [])
    } else {
      await group("optionalCatalogIsolation", optionalCatalogIsolation)
      await group("sessionSelectionDisplay", sessionSelectionDisplay)
      await group("crossThreadBusy", crossThreadBusy)
      await group("commandSettings", commandSettings)
      await group("editAndRun", editAndRun)
      await group("templateAndValidation", templateAndValidation)
      await group("lifecycle", lifecycle)
      await group("boundedReads", boundedReads)
      await group("navigationAndScale", navigationAndScale)
      await group("firstUseAndVisuals", firstUseAndVisuals)
      await group("flowWorkspaceSeparation", flowWorkspaceSeparation)
      await group("compactComposer", compactComposer)
      await group("chatBridge", chatBridge)
      await group("clawRaces", clawRaces)
      await group("sidebarLifecycle", sidebarLifecycle)
      await group("sourceComposition", sourceComposition)
      await group("nativeSteps", nativeSteps)
      await group("projectActivation", projectActivation)
      await group("deferredUnmount", deferredUnmount)
      await group("scopeReloadAfterLockedOperation", scopeReloadAfterLockedOperation)
      assert.deepEqual(errors, [])
    }
    completed = true
  } catch (error) {
    failures.push(error)
    console.error("FLOW_BROWSER_FAILURE", { currentGroup, pageErrors: errors })
    try {
      if (page) writeFileSync(join(artifacts, "failure-dom.html"), await page.content())
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
