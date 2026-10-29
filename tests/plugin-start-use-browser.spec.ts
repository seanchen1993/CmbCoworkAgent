/** Real delivery handoff and native Host form, with bounded IPC facts and unrelated panels. */
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import type { PluginStartUseIdentity } from "../src/shared/plugin-start-use"

interface FixtureWindow extends Window {
  fixture: {
    calls: unknown[]
    create: Array<{
      expectedPlugin: PluginStartUseIdentity
      installedPluginId: string
      startUseScope: { threadId: string; expectedWorkspace: string }
    }>
    commands: string[]
    approvals: unknown[]
    enables: unknown[]
    configurationReads: string[]
    reset(name: string): void
    missing(value: boolean): void
    fail(): void
    delay(): void
    release(): void
    changeAccount(): void
    changeWorkspace(): void
    nativeReady(): void
    disable(): void
    uninstall(): void
    change(): void
    customize(): void
    fullSelection(): void
    failWorkspaceOnce(): void
    presentation(label: string, disabled: boolean): void
    snapshot(): {
      active: { capabilities: Array<{ pluginId: string }>; models: unknown; skills: unknown }
      global: boolean
      workspaceEnabled: boolean
      settings: unknown[][]
      rightModule: string
      currentThreadId: string
    }
  }
}

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/plugin-start-use-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const stubs: Record<string, string> = {
    FunctionUserConfig: `export function FunctionUserConfig(props){return <div role="region" aria-label="原生插件配置">{props.pluginId}<button onClick={()=>{window.fixture.missing(false);props.onSaved?.()}}>保存配置</button></div>}`,
    ProjectActionResults: "export function ProjectActionResults(){return null}",
    ProjectLibraryPanel: "export function ProjectLibraryPanel(){return null}",
    ProjectFunctionConsent: "export function ProjectFunctionConsent(){return null}",
    SparksDocumentationLink: "export function SparksDocumentationLink(){return null}"
  }
  const bundled = await build({
    write: false,
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "bounded-handoff-fixtures",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onResolve(
            {
              filter:
                /(?:FunctionUserConfig|ProjectActionResults|ProjectLibraryPanel|ProjectFunctionConsent|SparksDocumentationLink)$/
            },
            (args) => {
              const name = args.path.split("/").at(-1)!
              return stubs[name] ? { path: name, namespace: "fixture" } : undefined
            }
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            loader: "tsx",
            resolveDir: root,
            contents:
              args.path === "store"
                ? `
          import {useSyncExternalStore} from 'react';
          const listeners=new Set();
          let state={accountRevision:1,currentThreadId:'chat',showCustomizeView:true,board:false,
            threads:[{thread_id:'chat',metadata:{workspacePath:'C:/owned',agentMode:'normal'}}]};
          const update=patch=>{state={...state,...patch};for(const fn of listeners)fn()};
          state.setShowCustomizeView=show=>update({showCustomizeView:show});
          state.setShowHarnessBoardView=show=>update({board:show,showCustomizeView:false,currentThreadId:show?null:'chat'});
          state.selectThread=async id=>update({currentThreadId:id,showCustomizeView:false});
          state.setRightModule=rightModule=>update({rightModule});
          state.setRightPanelCollapsed=rightPanelCollapsed=>update({rightPanelCollapsed});
          export const useAppStore=selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(state));
          useAppStore.getState=()=>state; useAppStore.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
          window.fixtureStore={update,get:()=>state};
        `
                : stubs[args.path]
          }))
        }
      }
    ],
    stdin: {
      loader: "tsx",
      resolveDir: root,
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {InstalledPluginStartUse} from './src/renderer/src/components/customize/InstalledPluginStartUse';
      import {CreatorProjectDeliveryCard} from './src/renderer/src/components/customize/CreatorProjectDeliveryCard';
      import {LocalProjectsPanel} from './src/renderer/src/components/harness-board/LocalProjectsPanel';
      import {pluginStartUseDestinationConfigurationIssues} from './src/main/plugins/plugin-start-use-diagnostics';
      import {beginConfigurationTarget} from './src/renderer/src/lib/configuration-target';
      import {useAppStore} from '@/lib/store';
      import {readHostPluginStartUseIntent,dismissHostPluginStartUse} from './src/renderer/src/lib/plugin-start-use-intent';
      import {parseClawProfile} from './src/shared/mods/claw';
      let name='docs', changed=false, missing=false, fail=false, delayed, approved=false, global=false, workspaceEnabled=false, disabled=false, removed=false;
      let profiles=[],activeProfile=null,revision=0,bindingRevision=0,failWorkspace=false,hasOther=false,extra=[];
      const settings=[];
      const other=()=>({pluginId:'original-tools',name:'original-tools',digest:'f'.repeat(64),state:'ready',capabilities:['command']});
      const calls=[], create=[], commands=[], approvals=[], enables=[],configurationReads=[];
      const isChat=()=>name.startsWith('chat-');
      const mod=()=>({pluginId:'installed',name, digest:'c'.repeat(64), state:disabled?'disabled':approved?'ready':'needs-approval',capabilities:['command']});
      window.api={plugins:{prepareStartUse:async input=>{
        calls.push(structuredClone(input));
        if(removed)throw Error('PLUGIN_START_USE_PLUGIN_UNAVAILABLE');
        if(fail)throw Error('PLUGIN_START_USE_CONTENT_CHANGED');
        if(input.expected.digest&&input.expected.digest!==(changed?'b':'a').repeat(64))throw Error('PLUGIN_START_USE_CONTENT_CHANGED');
        const destination=isChat()?'chat':'host-project';
        const issues=!disabled?await pluginStartUseDestinationConfigurationIssues(destination,async()=>{
          configurationReads.push(input.expectedWorkspace);
          return{pluginId:'installed',plugin:name,digest:'c'.repeat(64),workspace:input.expectedWorkspace,
            savedRevision:0,state:'inactive',fields:missing?[
              {key:'knowledgeRoot',label:'Knowledge',description:'',type:'directory',supported:true,required:true},
              {key:'selectedUnits',label:'Selected units',description:'',type:'string',supported:true,required:true}]:[]}
        }):[];
        const report={identity:{pluginId:'installed',name,version:'1.0.0',digest:(changed?'b':'a').repeat(64)},kind:destination,canOpen:!disabled,...(disabled?{activationRequired:true}:{}),issues,
          ...(isChat()?{chat:{...(name==='chat-skill-only'?{}:{functionMod:mod()}),skills:disabled?[]:[{id:'plugin:installed/'+name,name:name+'-skill',description:'实际公开业务技能'}]}}:{})};
        if(delayed)await new Promise(resolve=>delayed=resolve);
        return report;
      },enableStartUse:async input=>{
        const state=window.fixtureStore.get();
        if(removed||changed||state.accountRevision!==1||input.expected.digest!=='a'.repeat(64))throw Error('PLUGIN_START_USE_IDENTITY_CHANGED');
        enables.push(structuredClone(input));disabled=false;
        return window.api.plugins.prepareStartUse(input);
      }},mods:{
        clawView:async()=>structuredClone({workspace:'C:/owned',enabled:workspaceEnabled,applicable:true,capabilities:[mod(),...(hasOther?[other()]:[]),...extra],profiles,active:activeProfile,revision,bindingRevision,issues:[]}),
        clawChange:async(t,m)=>{
          if(t!=='chat'||m.workspace!=='C:/owned'||m.revision!==revision)throw Error('STALE');
          if(m.kind==='save'){profiles.push(parseClawProfile(m.profile));revision++}
          else{if(m.bindingRevision!==bindingRevision)throw Error('STALE');activeProfile=structuredClone(profiles.find(p=>p.id===m.id));revision++;bindingRevision=revision}
          return window.api.mods.clawView(t)
        },
        status:async()=>({workspace:'C:/owned',enabled:workspaceEnabled,outputPolicy:false,functionMods:[mod(),...(hasOther?[other()]:[]),...extra],mods:[],diagnostics:[]}),
        globalEnabled:async()=>global, configureGlobal:async value=>{settings.push(['global',value]);global=value;return global},
        configure:async(_thread,enabled,policy,workspace)=>{if(workspace!=='C:/owned')throw Error('scope');settings.push(['workspace',enabled,policy]);if(failWorkspace){failWorkspace=false;throw Error('CONTROLLED_WRITE_FAILURE')}workspaceEnabled=enabled},
        approveFunction:async(...args)=>{if(disabled)throw Error('DISABLED_SOURCE');approvals.push(args);approved=true},
        commands:async()=>{commands.push('nativecatalog');if(!global||!workspaceEnabled||!approved)throw Error('no approval');return [
          {apiVersion:'cmb.mods/v2',modId:'function:'+name,digest:'c'.repeat(64),command:name+'-check',name:'真实业务检查'},
          {apiVersion:'cmb.mods/v2',modId:'function:foreign',digest:'c'.repeat(64),command:'foreign-entry',name:'foreign'},
          {apiVersion:'cmb.mods/v2',modId:'function:'+name,digest:'d'.repeat(64),command:'stale-entry',name:'stale'},
          {apiVersion:'cmb.mods/v2',modId:'function:'+name,digest:'c'.repeat(64),command:'hidden-entry',name:'hidden',isHidden:true}]},
        panes:async()=>[]
      },file:{selectDirectory:async()=>({canceled:false,filePaths:['C:/new-project']})},
      harnessBoard:{localProjects:{templates:async()=>[{installedPluginId:'installed',name,version:'1.0.0',stages:['draft','review']}],
        list:async()=>[],create:async input=>{create.push(structuredClone(input));return{project:{projectId:'created'},operations:[]}},
        get:async()=>new Promise(()=>{}),command:async()=>{commands.push('command');throw Error('must not execute')}}}};
      let close=beginConfigurationTarget({threadId:'chat',workspace:'C:/owned'});
      const app=createRoot(document.getElementById('root'));let fixtureRun=0;
      function App(){const state=useAppStore(s=>s);return state.board?<LocalProjectsPanel/>:
        name.startsWith('creator-')?<CreatorProjectDeliveryCard key={name+state.accountRevision+':'+fixtureRun}
          threadId='chat' workspace='C:/owned' request={{id:'saved-request',name,digest:'b'.repeat(64)}}
          delivery={{id:'delivery',requestId:'saved-request',sourceDigest:'b'.repeat(64),phase:'installed',pluginId:'installed',name,version:'1.0.0',digest:'a'.repeat(64),canInstall:false,canExport:false}}
          api={{}} onStatus={()=>{}}/>:<InstalledPluginStartUse key={name+state.accountRevision+':'+fixtureRun}
        threadId='chat' workspace='C:/owned' pluginId='installed' expected={{name,version:'1.0.0'}} actionLabel={state.fixtureLabel} disabled={state.fixtureDisabled}/>}
      app.render(<App/>);
      window.fixture={calls,create,commands,approvals,enables,configurationReads,
        reset:next=>{fixtureRun++;const pending=readHostPluginStartUseIntent();if(pending)dismissHostPluginStartUse(pending.id);name=next;changed=false;missing=false;fail=false;delayed=undefined;approved=false;global=false;workspaceEnabled=false;disabled=false;removed=false;commands.length=0;approvals.length=0;enables.length=0;profiles=[];activeProfile=null;revision=0;bindingRevision=0;failWorkspace=false;hasOther=false;extra=[];settings.length=0;
          configurationReads.length=0;close();window.fixtureStore.update({accountRevision:1,currentThreadId:'chat',showCustomizeView:true,board:false,fixtureLabel:undefined,fixtureDisabled:false,
            threads:[{thread_id:'chat',metadata:{workspacePath:'C:/owned',agentMode:'normal'}}]});
          close=beginConfigurationTarget({threadId:'chat',workspace:'C:/owned'});app.render(<App/>);},
        missing:value=>missing=value, change:()=>changed=true, fail:()=>fail=true,
        nativeReady:()=>{approved=true;global=true;workspaceEnabled=true},
        disable:()=>disabled=true,uninstall:()=>removed=true,
        delay:()=>delayed=true, release:()=>{if(typeof delayed==='function'){const done=delayed;delayed=undefined;done()}},
        changeAccount:()=>window.fixtureStore.update({accountRevision:2}),
        changeWorkspace:()=>window.fixtureStore.update({threads:[{thread_id:'chat',metadata:{workspacePath:'C:/elsewhere',agentMode:'normal'}}]})};
      Object.assign(window.fixture,{
        customize:()=>{hasOther=true;global=true;workspaceEnabled=true;activeProfile=parseClawProfile({id:'personal',name:'原搭配',capabilities:[other()],models:{default:'chosen',roles:{Explore:'fast'}},skills:{mode:'selected',items:[]}});profiles=[structuredClone(activeProfile)];revision=1;bindingRevision=1},
        fullSelection:()=>{global=true;workspaceEnabled=true;extra=Array.from({length:8},(_,i)=>({pluginId:'retained-'+i,name:'retained-'+i,digest:'f'.repeat(64),state:'ready',capabilities:[]}));activeProfile=parseClawProfile({id:'full',name:'满额搭配',capabilities:extra});profiles=[structuredClone(activeProfile)];revision=1;bindingRevision=1},
        failWorkspaceOnce:()=>failWorkspace=true,
        presentation:(label,disabled)=>window.fixtureStore.update({fixtureLabel:label,fixtureDisabled:disabled}),
        snapshot:()=>structuredClone({active:activeProfile,global,workspaceEnabled,settings,rightModule:window.fixtureStore.get().rightModule,currentThreadId:window.fixtureStore.get().currentThreadId})
      });
    `
    }
  })
  const browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, channel: "msedge" }))
  const results: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.route("http://127.0.0.1/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div id="root"></div></body></html>'
      })
    )
    await page.goto("http://127.0.0.1/")
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    const start = page.getByRole("region", { name: "已安装插件开始使用", exact: true })
    const read = () => start.getByRole("button", { name: "开始使用", exact: true }).click()
    const form = page.getByRole("region", { name: "项目列表", exact: true })
    for (const name of ["installed-disabled-docs", "installed-disabled-warehouse"]) {
      await page.evaluate((name) => {
        const f = (window as unknown as FixtureWindow).fixture
        f.reset(name)
        f.disable()
      }, name)
      await read()
      await form.getByRole("combobox", { name: "项目插件", exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.enables.length),
        1
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
        0
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
        0
      )
      results.push(
        `${name}: one explicit Start Use pins and enables the exact install, then opens the native form without execution grants`
      )
    }
    for (const change of ["uninstall", "change"] as const) {
      await page.evaluate(() => {
        const f = (window as unknown as FixtureWindow).fixture
        f.reset("disabled-stale")
        f.disable()
        f.delay()
      })
      await read()
      await page.evaluate(
        (change) => (window as unknown as FixtureWindow).fixture[change](),
        change
      )
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.release())
      await start.getByRole("alert").waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.enables.length),
        0
      )
      results.push(`${change}: stale disabled installation never dispatches enablement`)
    }
    await page.evaluate(() => {
      const f = (window as unknown as FixtureWindow).fixture
      f.reset("disabled-late-account")
      f.disable()
      f.delay()
    })
    await read()
    await page.evaluate(() => {
      const f = (window as unknown as FixtureWindow).fixture
      f.changeAccount()
      f.release()
    })
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.enables.length),
      0
    )
    results.push("late account change during enable preflight never dispatches catalog mutation")
    for (const name of ["docs", "warehouse-quality"]) {
      await page.evaluate((name) => (window as unknown as FixtureWindow).fixture.reset(name), name)
      await read()
      await form.getByRole("combobox", { name: "项目插件", exact: true }).waitFor()
      assert.equal(
        await form.getByRole("combobox", { name: "项目插件", exact: true }).inputValue(),
        "installed"
      )
      assert.equal(
        await form.getByRole("combobox", { name: "项目插件", exact: true }).isDisabled(),
        true
      )
      assert((await form.innerText()).includes(name))
      const before = await page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.create.length
      )
      await form.getByRole("textbox", { name: "项目名称", exact: true }).fill("我的独立任务")
      await form
        .getByRole("textbox", { name: "希望完成什么", exact: true })
        .fill("保留原生检查并产生实际产物")
      await form.getByRole("button", { name: "选择工作目录", exact: true }).click()
      await form.getByRole("button", { name: "创建项目", exact: true }).click()
      await page.waitForFunction(
        (before) => (window as unknown as FixtureWindow).fixture.create.length === before + 1,
        before
      )
      const created = await page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.create.at(-1)
      )
      assert(created)
      assert.equal(created.expectedPlugin.name, name)
      assert.equal(created.expectedPlugin.pluginId, "installed")
      assert.equal(created.expectedPlugin.digest, "a".repeat(64))
      assert.equal(created.installedPluginId, "installed")
      assert.deepEqual(created.startUseScope, { threadId: "chat", expectedWorkspace: "C:/owned" })
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
        0
      )
      results.push(
        `${name}: exact template opens directly; only explicit native create dispatches; no stage starts`
      )
    }
    for (const name of [
      "needs-knowledge",
      "dual-project-required-config",
      "creator-needs-knowledge"
    ]) {
      await page.evaluate((name) => {
        const fixture = (window as unknown as FixtureWindow).fixture
        fixture.reset(name)
        fixture.missing(true)
      }, name)
      const before = await page.evaluate(
        () => (window as unknown as FixtureWindow).fixture.create.length
      )
      await read()
      await form.getByRole("combobox", { name: "项目插件", exact: true }).waitFor()
      assert.equal(
        await form.getByRole("combobox", { name: "项目插件", exact: true }).inputValue(),
        "installed"
      )
      assert.equal(
        await start.getByRole("region", { name: "原生插件配置", exact: true }).count(),
        0
      )
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.configurationReads),
        [],
        "project entry never reads required parameters from the author chat workspace"
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.create.length),
        before
      )
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals),
        []
      )
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands),
        []
      )
      const state = await page.evaluate(() =>
        (window as unknown as FixtureWindow).fixture.snapshot()
      )
      assert.equal(state.global, false)
      assert.equal(state.workspaceEnabled, false)
      results.push(
        `${name}: required project parameters stay in the target project; opening its form reads or grants nothing in the author workspace`
      )
    }

    await form.getByRole("textbox", { name: "项目名称", exact: true }).fill("过期插件不能创建")
    await form.getByRole("textbox", { name: "希望完成什么", exact: true }).fill("测试变更拒绝")
    await form.getByRole("button", { name: "选择工作目录", exact: true }).click()
    const previous = await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.create.length
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
    await form.getByRole("button", { name: "创建项目", exact: true }).click()
    await form.getByRole("alert").waitFor()
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.create.length),
      previous
    )
    results.push("plugin change after opening the form prevents native create dispatch")

    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.reset("late-reply"))
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.delay())
    await read()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).fixture.changeAccount()
      ;(window as unknown as FixtureWindow).fixture.release()
    })
    assert.equal(await page.getByRole("region", { name: "项目列表", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.create.length),
      previous
    )
    results.push("late reply across account change cannot navigate or create")
    for (const name of ["chat-docs", "chat-warehouse-quality"]) {
      await page.evaluate((name) => (window as unknown as FixtureWindow).fixture.reset(name), name)
      await read()
      const chat = start.getByRole("region", { name: "聊天插件使用入口", exact: true })
      await chat.getByRole("heading", { name: "确认使用此插件", exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
        0
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
        0
      )
      assert.equal(
        await chat.getByRole("button", { name: "开启灵件总开关", exact: true }).count(),
        0
      )
      assert.equal(
        await chat
          .getByRole("button", { name: "读取实际注册的命令与面板入口", exact: true })
          .count(),
        0
      )
      await chat.getByRole("button", { name: "确认并进入使用", exact: true }).click()
      await chat.getByText(`/${name}-check`, { exact: true }).waitFor()
      const text = await chat.innerText()
      assert(text.includes(`/${name}-skill`))
      assert(
        !text.includes("foreign-entry") &&
          !text.includes("stale-entry") &&
          !text.includes("hidden-entry")
      )
      assert.deepEqual(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals),
        [["chat", "installed", "c".repeat(64), "C:/owned"]]
      )
      await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true })
      results.push(
        `${name}: one explicit consent sets native switches and exact grant; only then discovers exact-source entries without executing commands`
      )
    }
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-disabled-business")
      fixture.disable()
    })
    await read()
    const confirmDisabled = start.getByRole("button", { name: "确认并进入使用", exact: true })
    await confirmDisabled.waitFor()
    assert.equal(await start.getByRole("button", { name: "开始使用", exact: true }).count(), 0)
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = (window as unknown as FixtureWindow).fixture
        return [
          fixture.enables.length,
          fixture.approvals.length,
          fixture.commands.length,
          fixture.snapshot().settings.length
        ]
      }),
      [0, 0, 0, 0]
    )
    await confirmDisabled.click()
    await start.getByText("/chat-disabled-business-check", { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = (window as unknown as FixtureWindow).fixture
        return [fixture.enables.length, fixture.approvals.length]
      }),
      [1, 1]
    )
    assert.equal(
      await start.getByRole("button", { name: "确认并进入使用", exact: true }).count(),
      0
    )
    results.push(
      "disabled business source stays inert during review; one consent enables and grants the exact version and opens its real use entries"
    )

    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-disabled-configured")
      fixture.disable()
      fixture.missing(true)
    })
    await read()
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    await start.getByRole("button", { name: "保存配置", exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      0
    )
    await start.getByRole("button", { name: "保存配置", exact: true }).click()
    await start.getByText("/chat-disabled-configured-check", { exact: true }).waitFor()
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = (window as unknown as FixtureWindow).fixture
        return [fixture.enables.length, fixture.approvals.length]
      }),
      [1, 1]
    )
    assert.equal(
      await start.getByRole("button", { name: "确认并进入使用", exact: true }).count(),
      0
    )
    results.push(
      "saving required configuration resumes the same exact source/scope consent and does not present a second enable action"
    )

    for (const change of ["change", "changeWorkspace"] as const) {
      await page.evaluate((change) => {
        const fixture = (window as unknown as FixtureWindow).fixture
        fixture.reset(`chat-pending-${change}`)
        fixture.disable()
        fixture.missing(true)
      }, change)
      await read()
      await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
      await start.getByRole("button", { name: "保存配置", exact: true }).waitFor()
      await page.evaluate(
        (change) => (window as unknown as FixtureWindow).fixture[change](),
        change
      )
      await start.getByRole("button", { name: "保存配置", exact: true }).click()
      await start.getByRole("alert").filter({ hasText: "聊天或插件已变化" }).waitFor()
      assert.deepEqual(
        await page.evaluate(() => {
          const fixture = (window as unknown as FixtureWindow).fixture
          return [fixture.enables.length, fixture.approvals.length, fixture.commands.length]
        }),
        [1, 0, 0]
      )
      results.push(`required configuration cannot resume the old consent after ${change}`)
    }

    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-native-ready")
      fixture.nativeReady()
    })
    await read()
    await start.getByText("/chat-native-ready-check", { exact: true }).waitFor()
    assert.equal(
      await start.getByRole("button", { name: "确认并进入使用", exact: true }).count(),
      0
    )
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = (window as unknown as FixtureWindow).fixture
        return [
          fixture.enables.length,
          fixture.approvals.length,
          fixture.snapshot().settings.length
        ]
      }),
      [0, 0, 0]
    )
    results.push(
      "the exact native-ready source opens its use entries directly without catalog, grant or switch writes"
    )

    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.reset("chat-skill-only"))
    await read()
    await start.getByText("/chat-skill-only-skill", { exact: true }).waitFor()
    assert.equal(
      await start.getByRole("button", { name: "确认并进入使用", exact: true }).count(),
      0
    )
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
      0
    )
    results.push(
      "pure Skill installation exposes its declared slash name/instructions and requests no Function Mod grant"
    )
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-skill-only")
      fixture.disable()
    })
    await read()
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    await start.getByText("/chat-skill-only-skill", { exact: true }).waitFor()
    assert.equal(await start.locator("[data-native-function-approval]").count(), 0)
    assert.deepEqual(
      await page.evaluate(() => {
        const fixture = (window as unknown as FixtureWindow).fixture
        return [
          fixture.enables.length,
          fixture.approvals.length,
          fixture.commands.length,
          fixture.snapshot().settings.length
        ]
      }),
      [1, 0, 0, 0]
    )
    results.push(
      "a disabled ordinary Skill plugin enables without granting Function Mods permissions or changing runtime switches"
    )
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-required-configuration")
      fixture.missing(true)
    })
    await read()
    assert.equal(await start.getByRole("region", { name: "聊天插件使用入口" }).count(), 1)
    await start.getByRole("button", { name: "保存配置", exact: true }).click()
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).waitFor()
    assert.equal(await start.getByRole("region", { name: "原生插件配置" }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      0
    )
    results.push(
      "saving required chat configuration opens fresh consent directly, without stale child issues or automatic grants"
    )

    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-existing-selection")
      fixture.customize()
    })
    await read()
    const allow = start.getByRole("button", { name: "确认并进入使用", exact: true })
    await allow.waitFor()
    assert.equal(await start.getByRole("button", { name: "返回聊天", exact: true }).count(), 0)
    await allow.evaluate((node: HTMLButtonElement) => {
      node.click()
      node.click()
    })
    await start.getByText("/chat-existing-selection-check", { exact: true }).waitFor()
    const selection = await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.snapshot()
    )
    assert.deepEqual(
      selection.active.capabilities.map((item) => item.pluginId),
      ["original-tools", "installed"]
    )
    assert.deepEqual(selection.active.models, { default: "chosen", roles: { Explore: "fast" } })
    assert.deepEqual(selection.active.skills, { mode: "selected", items: [] })
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      1
    )
    const retained = await start.getByRole("region", { name: "聊天插件使用入口" }).elementHandle()
    const readsBefore = await page.evaluate(
      () => (window as unknown as FixtureWindow).fixture.calls.length
    )
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.presentation("去使用", true)
    )
    assert(await retained!.evaluate((node) => node.isConnected))
    assert(await start.getByRole("button", { name: "返回聊天", exact: true }).isDisabled())
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.calls.length),
      readsBefore
    )
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.presentation("去使用", false)
    )
    assert(await retained!.evaluate((node) => node.isConnected))
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.calls.length),
      readsBefore
    )
    results.push(
      "explicit consent adds the exact plugin to an existing selection, preserves models/skills, locks duplicate clicks and retains the form across display-prop changes"
    )

    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-partial-settings")
      fixture.failWorkspaceOnce()
    })
    await read()
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    const partial = start.getByRole("alert").filter({ hasText: "未能完成设置" })
    await partial.waitFor()
    assert.equal(await start.getByRole("button", { name: "返回聊天", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      1
    )
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
      0
    )
    await partial.locator("..").getByRole("button", { name: "重新检查", exact: true }).click()
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    await start.getByText("/chat-partial-settings-check", { exact: true }).waitFor()
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      1
    )
    assert(
      (await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands)).every(
        (item) => item === "nativecatalog"
      )
    )
    results.push(
      "partial settings failure blocks use, requires read-only reconciliation and fresh consent, and never repeats a confirmed grant or executes a task"
    )
    await page.evaluate(() => {
      const fixture = (window as unknown as FixtureWindow).fixture
      fixture.reset("chat-full-selection")
      fixture.fullSelection()
    })
    await read()
    await start.getByRole("alert").filter({ hasText: "超过 8 个能力" }).waitFor()
    await start.getByRole("button", { name: "调整聊天搭配", exact: true }).click()
    const repaired = await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.snapshot()
    )
    assert.equal(repaired.rightModule, "claw")
    assert.equal(repaired.currentThreadId, "chat")
    assert.equal(repaired.active.capabilities.length, 8)
    assert.deepEqual(repaired.settings, [])
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      0
    )
    results.push(
      "full selection blocks activation with its actual reason but read-only repair navigation remains reachable without grants or removing any capability"
    )

    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.reset("chat-stale"))
    await read()
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    await start.getByRole("alert").waitFor()
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      0
    )
    results.push(
      "uninstalled or changed source rejects an old native approval button before dispatch"
    )
    await page.evaluate(() =>
      (window as unknown as FixtureWindow).fixture.reset("chat-late-account")
    )
    await read()
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>(
        "[data-native-function-approval] button"
      )
      return button && !button.disabled
    })
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.delay())
    await start.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    await page.evaluate(() => {
      ;(window as unknown as FixtureWindow).fixture.changeAccount()
      ;(window as unknown as FixtureWindow).fixture.release()
    })
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
      0
    )
    results.push("late approval preparation across account change never dispatches native approval")
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "handoff.png"), fullPage: true })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          results,
          scope:
            "Real InstalledPluginStartUse and LocalProjectsPanel create form; IPC observations and unrelated panels/config editor are fixtures; native creation/source guards have separate real-store tests"
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ passed: true, output, results }))
  } finally {
    await browser.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
