/** Real settings shell and target/navigation helpers, with bounded panel/API probes. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

interface ConfigurationFixtureState {
  customizeInitialTab?: string
  currentThreadId: string
  showCustomizeView: boolean
  threads: Array<{
    thread_id: string
    title: string
    metadata: { workspacePath: string; agentMode: string }
  }>
}
interface ConfigurationWindow extends Window {
  state(): ConfigurationFixtureState
  calls: unknown[][]
  savedGuard(): boolean
  readTarget(): { threadId: string }
  patch(state: Partial<ConfigurationFixtureState>): void
  holdLoad: boolean
  releaseLoad(): void
}

const root = process.cwd()
const renderer = resolve(root, "src/renderer/src")
const output = resolve(root, "output/configuration-target-browser", String(Date.now()))
const source = (path: string) => JSON.stringify(resolve(renderer, path))
const panels = ["SkillsPanel", "GeneralPanel", "AppearancePanel", "McpPanel", "MemoryPanel",
  "TaskMmdPanel", "HeartbeatPanel", "PluginsPanel", "ModsPanel", "ClawPanel", "FlowsPanel",
  "EvaluationPanel", "SandboxPanel", "EvolutionPanel", "BuiltinRobotPanel", "UserInfoPanel",
  "HooksPanel", "LspPanel", "CodeExecToolsPanel", "PetPanel", "ExpertTeamPanel", "AssistantWorkbench"]
async function main() {
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {CustomizeView} from ${source("components/customize/CustomizeView.tsx")};
      import {readConfigurationTarget,captureConfigurationScope} from ${source("lib/configuration-target.ts")};
      import {prepareSimpleAuthoringTask} from ${source("lib/simple-authoring-composer.ts")};
      window.readTarget=readConfigurationTarget;window.capture=captureConfigurationScope;
      window.prepare=prepareSimpleAuthoringTask;
      createRoot(document.getElementById('root')).render(<CustomizeView/>);
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    alias: { "@": renderer }, plugins: [{ name: "isolated-settings", setup(builder) {
      builder.onResolve({filter: /(?:^@\/lib\/store$|^\.\/store$)/}, () => ({path:"store",namespace:"fixture"}))
      builder.onResolve({filter: /^\.\//}, (args) => {
        if (!args.importer.endsWith("CustomizeView.tsx")) return
        const name = args.path.slice(2)
        if (panels.includes(name) || ["SparksTour", "settings-return-focus"].includes(name))
          return {path:name,namespace:"fixture"}
      })
      builder.onLoad({filter:/.*/,namespace:"fixture"}, (args) => {
        if (args.path === "store") return {loader:"tsx",resolveDir:root,contents:`
          import {useSyncExternalStore} from 'react';
          const listeners=new Set();let state;
          const emit=()=>{state={...state};for(const fn of listeners)fn()};
          window.calls=[];window.pending=[];window.focused=0;
          const row=(id,path,metadata={})=>({thread_id:id,title:'同名聊天',metadata:{workspacePath:path,agentMode:'normal',...metadata}});
          state={currentThreadId:'a',showCustomizeView:true,customizeInitialTab:'claw',pendingEvolution:null,
            threads:[row('a','C:/alpha'),row('b','C:/beta'),row('child','C:/child',{parentThreadId:'a'}),row('remote','C:/remote',{remoteReadOnly:true})],
            setShowCustomizeView:(show,tab)=>{window.calls.push(['show',show,tab]);state.showCustomizeView=show;if(tab)state.customizeInitialTab=tab;emit()},
            selectThread:async id=>{window.calls.push(['navigate',id]);state.currentThreadId=id;state.showCustomizeView=false;emit()},
            loadThreads:async()=>{if(window.holdLoad)await new Promise(r=>window.releaseLoad=r);emit()}};
          window.state=()=>state;window.patch=patch=>{Object.assign(state,patch);emit()};
          let globalEnabled=false,projectEnabled=false;
          window.api={mods:{
            globalEnabled:async()=>globalEnabled,
            status:async id=>({workspace:state.threads.find(row=>row.thread_id===id).metadata.workspacePath,enabled:projectEnabled,outputPolicy:false}),
            configureGlobal:async enabled=>{window.calls.push(['global',enabled]);return globalEnabled=enabled},
            configure:async(...args)=>{window.calls.push(['configure',...args]);projectEnabled=true},
            development:{setMode:async input=>{window.calls.push(['creator',input]);return{threadId:input.threadId,workspace:input.expectedWorkspace,enabled:true,mode:input.mode,drafts:[],trials:[]}}}
          }};
          export function useAppStore(selector){const value=useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>state);return selector?selector(value):value}
          useAppStore.getState=()=>state;useAppStore.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
        `}
        if (args.path === "SparksTour") return {loader:"tsx",resolveDir:root,contents:`
          import React,{useImperativeHandle} from 'react';export function SparksTour({ref}){useImperativeHandle(ref,()=>({dismiss(){}}));return null}
        `}
        if (args.path === "settings-return-focus") return {contents:"export const useSettingsComposerReturn=()=>()=>window.focused++"}
        return {loader:"tsx",resolveDir:root,contents:`
          import React,{useState} from 'react';
          import {useConfigurationDraft,captureConfigurationScope,goToConfigurationThread} from ${source("lib/configuration-target.ts")};
          export function ${args.path}(props){const [draft,setDraft]=useState('');const [busy,setBusy]=useState(false);
            const scope={threadId:props.threadId??null,workspace:props.workspaceHint??props.workspace??null};
            useConfigurationDraft(scope,!!draft,busy);
            window.panelProps??={};window.panelProps['${args.path}']=props;
            return <section aria-label='${args.path}'>
              <p>目标 {props.threadId??props.currentThreadId??'-'} {props.workspaceHint??props.workspacePath??props.workspace??'-'}</p>
              <input aria-label='${args.path}草稿' value={draft} onChange={e=>setDraft(e.target.value)}/>
              <button onClick={()=>{window.calls.push(['apply',scope]);setDraft('')}}>应用配置</button>
              <button onClick={()=>goToConfigurationThread(scope)}>去这段聊天使用</button>
              <button onClick={()=>{window.savedGuard=captureConfigurationScope(scope)}}>捕获请求</button>
              <button onClick={()=>setBusy(!busy)}>切换忙碌</button>
              <button onClick={()=>props.onReturnToChat?.()}>返回目标</button>
              <button onClick={()=>props.onOpenReuseThread?.('a')}>复用聊天</button>
              {props.onStartCreator&&<button onClick={props.onStartCreator} disabled={props.creatorBusy||!!props.creatorUnavailable}>进入创造者模式</button>}
            </section>}
        `}
      })
    }}]
  })
  const browser = await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:"msedge"})})
  const page = await browser.newPage({viewport:{width:1100,height:800}})
  const errors: string[] = []
  page.on("pageerror", error=>errors.push(error.message))
  const choose = async (path: string) => {
    await page.getByRole("combobox", {name:"配置目标聊天",exact:true}).click()
    await page.getByRole("option",{name:`同名聊天 · ${path}`,exact:true}).click()
  }
  try {
    await page.goto("about:blank")
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({content:bundle.outputFiles[0].text})
    await page.getByRole("region",{name:"ClawPanel",exact:true}).getByText("目标 a C:/alpha").waitFor()
    const advancedGroup = page.getByRole("button", {name:"高级特性",exact:true})
    assert.equal(await advancedGroup.count(), 1)
    assert.equal(await page.getByRole("button", {name:"高级自定义",exact:true}).count(), 0)
    assert.equal(await advancedGroup.getAttribute("aria-expanded"), "true", "claw deep link expands its merged group")
    for (const [label, panel] of [
      ["搭配管理", "ClawPanel"], ["聊天任务模板", "FlowsPanel"],
      ["专家团", "ExpertTeamPanel"], ["效果测试", "EvaluationPanel"],
      ["心跳监控", "HeartbeatPanel"], ["记忆管理", "MemoryPanel"],
      ["任务画布", "TaskMmdPanel"], ["Java 代码诊断", "LspPanel"],
      ["自优化", "EvolutionPanel"], ["机器人管理", "BuiltinRobotPanel"],
      ["自动触发规则", "HooksPanel"], ["编程式工具调用", "CodeExecToolsPanel"]
    ]) {
      const entry = page.getByRole("button", {name:label,exact:true})
      assert.equal(await entry.count(), 1, `${label} has one navigation entry`)
      await entry.click()
      await page.getByRole("region", {name:panel,exact:true}).waitFor()
      assert.equal(await entry.getAttribute("aria-current"), "page")
    }
    for (const tab of ["flows", "claw"]) {
      await advancedGroup.click()
      assert.equal(await advancedGroup.getAttribute("aria-expanded"), "false")
      await page.evaluate(tab => (window as unknown as ConfigurationWindow).patch({customizeInitialTab:tab}), tab)
      await page.getByRole("region", {name:tab === "flows" ? "FlowsPanel" : "ClawPanel",exact:true}).waitFor()
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button =>
        button.textContent?.trim() === "高级特性" && button.getAttribute("aria-expanded") === "true"))
    }
    await page.getByRole("combobox",{name:"配置目标聊天",exact:true}).click()
    assert.equal(await page.getByRole("option").count(),2)
    await page.keyboard.press("Escape")
    await choose("C:/beta")
    const claw=page.getByRole("region",{name:"ClawPanel",exact:true})
    await claw.getByText("目标 b C:/beta").waitFor()
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).state().currentThreadId),"a")
    await claw.getByRole("button",{name:"应用配置",exact:true}).click()
    assert.deepEqual(await page.evaluate(()=> (window as unknown as ConfigurationWindow).calls.filter((item)=>item[0]==='apply')),
      [["apply",{threadId:"b",workspace:"C:/beta"}]])
    await claw.getByRole("button",{name:"捕获请求"}).click()
    await choose("C:/alpha")
    await choose("C:/beta")
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).savedGuard()),false)
    await claw.getByLabel("ClawPanel草稿").fill("保留B草稿")
    page.once("dialog",dialog=>dialog.dismiss())
    await choose("C:/alpha")
    assert.equal(await claw.getByLabel("ClawPanel草稿").inputValue(),"保留B草稿")
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).readTarget().threadId),"b")
    await page.getByRole("button",{name:"聊天任务模板",exact:true}).click()
    await page.getByRole("region",{name:"FlowsPanel",exact:true}).waitFor()
    page.once("dialog",dialog=>dialog.dismiss())
    await choose("C:/alpha")
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).readTarget().threadId),"b")
    await page.getByRole("button",{name:"搭配管理",exact:true}).click()
    page.once("dialog",dialog=>dialog.accept())
    await choose("C:/alpha")
    assert.equal(await claw.getByLabel("ClawPanel草稿").inputValue(),"")
    await claw.getByRole("button",{name:"切换忙碌"}).click()
    await choose("C:/beta")
    await page.getByRole("alert").getByText(/当前操作尚未结束/).waitFor()
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).readTarget().threadId),"a")
    await claw.getByRole("button",{name:"切换忙碌"}).click()
    await choose("C:/beta")
    await page.evaluate(()=>{const state=(window as unknown as ConfigurationWindow).state();(window as unknown as ConfigurationWindow).patch({threads:state.threads.filter((row)=>row.thread_id!=='b')})})
    await page.getByRole("combobox",{name:"配置目标聊天",exact:true}).getByText("原配置聊天已不可用，请重新选择").waitFor()
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).readTarget().threadId),"b")
    assert.equal(await claw.evaluate(node=>!!node.closest('[inert]')),true)
    await page.evaluate(()=>{const state=(window as unknown as ConfigurationWindow).state();(window as unknown as ConfigurationWindow).patch({threads:[...state.threads,{thread_id:'b',title:'同名聊天',metadata:{workspacePath:'C:/new-beta',agentMode:'normal'}}]})})
    await choose("C:/new-beta")
    await claw.getByText("目标 b C:/new-beta").waitFor()
    // Basic settings continue to describe open chat A, not configuration target B.
    if (await advancedGroup.getAttribute("aria-expanded") !== "true") await advancedGroup.click()
    await page.getByRole("button",{name:"任务画布",exact:true}).click()
    await page.getByRole("region",{name:"TaskMmdPanel",exact:true}).getByText("目标 a -").waitFor()
    await page.getByRole("navigation").filter({has:page.getByRole("button",{name:"基础功能",exact:true})}).getByRole("button",{name:"灵件与使用设置",exact:true}).click()
    const mods=page.getByRole("region",{name:"ModsPanel",exact:true})
    await mods.getByText("目标 b C:/new-beta").waitFor()
    await page.evaluate(()=>{(window as unknown as ConfigurationWindow).holdLoad=true})
    await mods.getByRole("button",{name:"复用聊天"}).click()
    await choose("C:/alpha")
    await page.evaluate(()=>{(window as unknown as ConfigurationWindow).releaseLoad()})
    await page.waitForTimeout(50)
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).calls.filter((item)=>item[0]==='navigate').length),0)
    await choose("C:/new-beta")
    await mods.getByRole("button",{name:"返回目标"}).click()
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).state().currentThreadId),"b")
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).state().showCustomizeView),false)
    await page.evaluate(()=> (window as unknown as ConfigurationWindow).patch({currentThreadId:'a',showCustomizeView:true}))
    await mods.getByRole("button",{name:"进入创造者模式",exact:true}).click()
    await page.waitForFunction(()=> !(window as unknown as ConfigurationWindow).state().showCustomizeView)
    assert.deepEqual(await page.evaluate(()=> (window as unknown as ConfigurationWindow).calls.filter(item=>item[0]==='configure')),
      [["configure","b",true,false,"C:/new-beta"]])
    assert.deepEqual(await page.evaluate(()=> (window as unknown as ConfigurationWindow).calls.filter(item=>item[0]==='creator')),
      [["creator",{threadId:"b",expectedWorkspace:"C:/new-beta",mode:"creator"}]])
    assert.equal(await page.evaluate(()=> (window as unknown as ConfigurationWindow).state().currentThreadId),"b")
    assert.deepEqual(errors,[])
    await page.screenshot({path:join(output,"target-selection.png")})
    writeFileSync(join(output,"report.json"),JSON.stringify({passed:true,errors,checks:[
      "B-configured-without-navigating-A","explicit-return-to-B","late-callback-fenced",
      "dirty-and-retained-editor-cancel","busy-blocked","deleted-target-no-fallback",
      "same-id-workspace-reselection","basic-settings-stay-A","reuse-late-response-ignored"
    ]},null,2))
    console.log(`PASS independent configuration target: ${output}`)
  } catch(error) {console.error(errors);await page.screenshot({path:join(output,"failure.png")});throw error}
  finally {await browser.close()}
}
void main().catch(error=>{console.error(error);process.exitCode=1})
