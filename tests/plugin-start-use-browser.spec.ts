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
    reset(name: string): void
    missing(value: boolean): void
    fail(): void
    delay(): void
    release(): void
    changeAccount(): void
    disable(): void
    uninstall(): void
    change(): void
  }
}

async function main() {
  const root = resolve(__dirname, "..")
  const output = resolve(root, "output/plugin-start-use-browser", String(Date.now()))
  mkdirSync(output, { recursive: true })
  const stubs: Record<string, string> = {
    FunctionUserConfig: `export function FunctionUserConfig(props){return <div role="region" aria-label="原生插件配置">{props.pluginId}</div>}`,
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
      import {LocalProjectsPanel} from './src/renderer/src/components/harness-board/LocalProjectsPanel';
      import {beginConfigurationTarget} from './src/renderer/src/lib/configuration-target';
      import {useAppStore} from '@/lib/store';
      import {readHostPluginStartUseIntent,dismissHostPluginStartUse} from './src/renderer/src/lib/plugin-start-use-intent';
      let name='docs', changed=false, missing=false, fail=false, delayed, approved=false, global=false, workspaceEnabled=false, disabled=false, removed=false;
      const calls=[], create=[], commands=[], approvals=[], enables=[];
      const isChat=()=>name.startsWith('chat-');
      const mod=()=>({pluginId:'installed',name, digest:'c'.repeat(64), state:approved?'ready':'needs-approval',capabilities:['command']});
      window.api={plugins:{prepareStartUse:async input=>{
        calls.push(structuredClone(input));
        if(removed)throw Error('PLUGIN_START_USE_PLUGIN_UNAVAILABLE');
        if(fail)throw Error('PLUGIN_START_USE_CONTENT_CHANGED');
        if(input.expected.digest&&input.expected.digest!==(changed?'b':'a').repeat(64))throw Error('PLUGIN_START_USE_CONTENT_CHANGED');
        const report={identity:{pluginId:'installed',name,version:'1.0.0',digest:(changed?'b':'a').repeat(64)},kind:isChat()?'chat':'host-project',canOpen:!disabled,...(disabled?{activationRequired:true}:{}),
          issues:missing?[{code:'knowledge',message:'请补齐当前插件知识绑定。',resolution:'plugin-settings'}]:[],
          ...(isChat()?{chat:{...(name==='chat-skill-only'?{}:{functionMod:mod()}),skills:[{id:'plugin:installed/'+name,name:name+'-skill',description:'实际公开业务技能'}]}}:{})};
        if(delayed)await new Promise(resolve=>delayed=resolve);
        return report;
      },enableStartUse:async input=>{
        const state=window.fixtureStore.get();
        if(removed||changed||state.accountRevision!==1||input.expected.digest!=='a'.repeat(64))throw Error('PLUGIN_START_USE_IDENTITY_CHANGED');
        enables.push(structuredClone(input));disabled=false;
        return window.api.plugins.prepareStartUse(input);
      }},mods:{
        status:async()=>({workspace:'C:/owned',enabled:workspaceEnabled,outputPolicy:false,functionMods:[mod()],mods:[],diagnostics:[]}),
        globalEnabled:async()=>global, configureGlobal:async value=>{global=value;return global},
        configure:async(_thread,enabled,_policy,workspace)=>{if(workspace!=='C:/owned')throw Error('scope');workspaceEnabled=enabled},
        approveFunction:async(...args)=>{approvals.push(args);approved=true},
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
      const app=createRoot(document.getElementById('root'));
      function App(){const state=useAppStore(s=>s);return state.board?<LocalProjectsPanel/>:<InstalledPluginStartUse key={name+state.accountRevision}
        threadId='chat' workspace='C:/owned' pluginId='installed' expected={{name,version:'1.0.0'}}/>}
      app.render(<App/>);
      window.fixture={calls,create,commands,approvals,enables,
        reset:next=>{const pending=readHostPluginStartUseIntent();if(pending)dismissHostPluginStartUse(pending.id);name=next;changed=false;missing=false;fail=false;delayed=undefined;approved=false;global=false;workspaceEnabled=false;disabled=false;removed=false;commands.length=0;approvals.length=0;enables.length=0;
          close();window.fixtureStore.update({accountRevision:1,currentThreadId:'chat',showCustomizeView:true,board:false,
            threads:[{thread_id:'chat',metadata:{workspacePath:'C:/owned',agentMode:'normal'}}]});
          close=beginConfigurationTarget({threadId:'chat',workspace:'C:/owned'});app.render(<App/>);},
        missing:value=>missing=value, change:()=>changed=true, fail:()=>fail=true,
        disable:()=>disabled=true,uninstall:()=>removed=true,
        delay:()=>delayed=true, release:()=>{if(typeof delayed==='function'){const done=delayed;delayed=undefined;done()}},
        changeAccount:()=>window.fixtureStore.update({accountRevision:2}),
        changeWorkspace:()=>window.fixtureStore.update({threads:[{thread_id:'chat',metadata:{workspacePath:'C:/elsewhere',agentMode:'normal'}}]})};
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
    const open = () => start.getByRole("button", { name: "进入项目创建", exact: true }).click()
    const form = page.getByRole("region", { name: "项目列表", exact: true })
    for (const name of ["installed-disabled-docs", "installed-disabled-warehouse"]) {
      await page.evaluate((name) => {
        const f = (window as unknown as FixtureWindow).fixture
        f.reset(name)
        f.disable()
      }, name)
      await read()
      assert(
        await start.getByRole("button", { name: "进入项目创建", exact: true }).isDisabled()
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.enables.length),
        0
      )
      await start.getByRole("button", { name: "启用新插件", exact: true }).click()
      await start
        .getByRole("button", { name: "启用新插件", exact: true })
        .waitFor({ state: "detached" })
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.enables.length),
        1
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
        0
      )
      await open()
      await form.getByRole("combobox", { name: "项目插件", exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
        0
      )
      results.push(
        `${name}: disabled install requires explicit exact enablement, fresh diagnostics, then the real native form`
      )
    }
    for (const change of ["uninstall", "change"] as const) {
      await page.evaluate(() => {
        const f = (window as unknown as FixtureWindow).fixture
        f.reset("disabled-stale")
        f.disable()
      })
      await read()
      await page.evaluate(
        (change) => (window as unknown as FixtureWindow).fixture[change](),
        change
      )
      await start.getByRole("button", { name: "启用新插件", exact: true }).click()
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
    })
    await read()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.delay())
    await start.getByRole("button", { name: "启用新插件", exact: true }).click()
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
      await open()
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
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.reset("needs-knowledge"))
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.missing(true))
    await read()
    await start.getByRole("region", { name: "原生插件配置", exact: true }).waitFor()
    assert((await start.innerText()).includes("请补齐当前插件知识绑定"))
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.missing(false))
    await start.getByRole("button", { name: "重新检查使用条件", exact: true }).click()
    await start
      .getByRole("region", { name: "原生插件配置", exact: true })
      .waitFor({ state: "detached" })
    results.push(
      "configuration/knowledge remediation stays in the handoff and fresh recheck clears the blocker"
    )

    await open()
    await form.getByRole("combobox", { name: "项目插件", exact: true }).waitFor()
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
      await chat.getByText(`${name} 的聊天使用方式`, { exact: true }).waitFor()
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.approvals.length),
        0
      )
      assert.equal(
        await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
        0
      )
      assert.equal(
        await chat
          .getByRole("button", { name: "读取实际注册的命令与面板入口", exact: true })
          .isDisabled(),
        true
      )
      await chat.getByRole("button", { name: "开启灵件总开关", exact: true }).click()
      await chat.getByRole("button", { name: "在当前项目使用灵件", exact: true }).click()
      await chat.getByRole("button", { name: "授权以上能力", exact: true }).click()
      await chat.getByRole("button", { name: "读取实际注册的命令与面板入口", exact: true }).click()
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
        `${name}: shared native approval requires explicit enablement and consent; actual command registry is read only on request and exact-source entries are shown`
      )
    }
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.reset("chat-skill-only"))
    await read()
    await start.getByText("/chat-skill-only-skill", { exact: true }).waitFor()
    assert.equal(await start.getByRole("button", { name: "授权以上能力", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate(() => (window as unknown as FixtureWindow).fixture.commands.length),
      0
    )
    results.push(
      "pure Skill installation exposes its declared slash name/instructions and requests no Function Mod grant"
    )
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.reset("chat-stale"))
    await read()
    await start.getByRole("button", { name: "授权以上能力", exact: true }).waitFor()
    await page.evaluate(() => (window as unknown as FixtureWindow).fixture.fail())
    await start.getByRole("button", { name: "授权以上能力", exact: true }).click()
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
    await start.getByRole("button", { name: "授权以上能力", exact: true }).click()
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
