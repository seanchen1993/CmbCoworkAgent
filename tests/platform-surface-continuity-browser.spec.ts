/** Real installed-use card -> shared entry -> original workspace, with controlled public IPC. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/platform-surface-continuity-browser")
  mkdirSync(output, { recursive: true })
  const bundle = await build({
    stdin: {
      loader: "tsx",
      resolveDir: process.cwd(),
      contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import {useAppStore} from '@/lib/store';
    import {InstalledChatPluginUse} from ${JSON.stringify(resolve(renderer, "components/customize/InstalledChatPluginUse.tsx"))};
    import {PlatformWorkspace} from ${JSON.stringify(resolve(renderer, "components/platform/PlatformWorkspace.tsx"))};
    import {PluginSurfaceEntries} from ${JSON.stringify(resolve(renderer, "components/platform/PluginSurfaceEntries.tsx"))};
    const ops=[],listeners=new Set(),configuration=new Set();let approved=false,global=false,enabled=false,cold=true,profiles=[],active=null,revision=0,bindingRevision=0;
    let version=1,deferList=false,releaseList,deferOpen=false,releaseOpen,blocks=0,catalogError=false,empty=false;
    const frames=new Map(),state=()=>useAppStore.getState(),workspace=()=>state().threads[0].metadata.workspacePath;
    const mod=()=>({pluginId:'installed',name:'notes',digest:'c'.repeat(64),state:approved?'ready':'needs-approval',capabilities:[]});
    const report=()=>({identity:{pluginId:'installed',name:'notes',version:'1.0.0',digest:'a'.repeat(64)},kind:'chat',canOpen:true,issues:[],chat:{functionMod:mod(),skills:[]}});
    const row=(which)=>({type:'surface',apiVersion:'devclaw.surface/v1',id:'shared',title:which==='first'?'笔记页':'笔记设置',placement:which==='first'?'page':'settings',paneId:which,openAction:'open',
      key:which+':'+version,ref:{provider:'notes',id:which,version:'1.0.0'},source:{provider:'notes',digest:'c'.repeat(64),generation:String(version)},enabled:true});
    const catalogue=()=>({revision:version,entries:cold||empty||catalogError?[]:[row('first'),row('second'),{...row('first'),key:'foreign',ref:{provider:'foreign',id:'first',version:'1.0.0'},source:{provider:'foreign',digest:'d'.repeat(64),generation:'foreign'}}],errors:catalogError?['notes/invalid: 页面声明不可用']:[] ,canPrepare:cold});
    const tree=()=>({type:'Box',props:{flexDirection:'column'},children:[{type:'Text',props:{},children:['页面内容 '+blocks]},{type:'Button',props:{key:'change',label:'更新笔记'},press:{plugin:'notes',handle:1}}]});
    let serial=0;
    const surfaceApi={
      platformSurfaceList:async()=>{ops.push(['list']);const captured=catalogue();if(deferList){deferList=false;await new Promise(resolve=>releaseList=resolve)}return captured},
      platformSurfacePrepare:async()=>{ops.push(['prepare']);cold=false;return catalogue()},
      platformBehaviorList:async()=>({revision:1,bindings:[],active:[],errors:[]}),
      platformSurfaceOpen:async(t,address)=>{const entry=catalogue().entries.find(e=>e.key===address.key);if(!entry)throw Error('stale');const id='open-'+(++serial),scope=workspace();ops.push(['open',entry.key,id,scope]);
        const value={openId:id,entry,pane:{key:'notes:'+entry.paneId,id:entry.paneId,plugin:'notes',title:entry.title,generation:'draw-'+serial,tree:tree(),closeOnEscape:true,rows:10}};
        if(deferOpen){deferOpen=false;await new Promise(resolve=>releaseOpen=resolve)}frames.set(id,value);return value},
      platformSurfaceRead:async(t,address)=>{const value=frames.get(address.openId);if(!value)throw Error('stale');return{...value,pane:{...value.pane,tree:tree()}}},
      platformSurfaceAct:async(t,address,action)=>{ops.push(['act',address.openId,action.kind]);blocks++},
      platformSurfaceClose:async(t,address)=>{ops.push(['close',address.openId]);frames.delete(address.openId)},
      platformSurfaceDisable:async(t,address)=>{frames.delete(address.openId)},platformSurfaceEnable:async()=>{}
    };
    window.api={plugins:{prepareStartUse:async()=>report()},mods:{...surfaceApi,
      onCardsChanged:()=>()=>{},onPlatformChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},onConfigurationChanged:fn=>{configuration.add(fn);return()=>configuration.delete(fn)},
      status:async()=>({workspace:workspace(),enabled,outputPolicy:false,functionMods:[mod()],mods:[],diagnostics:[]}),globalEnabled:async()=>global,
      configureGlobal:async value=>{global=value;ops.push(['global',value]);return value},configure:async(t,value)=>{enabled=value;ops.push(['directory',value])},approveFunction:async()=>{approved=true;ops.push(['approve'])},
      clawView:async()=>({workspace:workspace(),applicable:true,enabled:true,revision,bindingRevision,profiles,active,capabilities:[mod()],issues:[]}),
      clawChange:async(t,change)=>{if(change.kind==='save'){profiles=[...profiles,structuredClone(change.profile)];revision++}else if(change.kind==='apply'){active=profiles.find(p=>p.id===change.id);revision++;bindingRevision=revision}return window.api.mods.clawView(t)},
      commands:async()=>[],panes:async()=>[],development:{status:async()=>({threadId:'chat',workspace:workspace(),enabled:true,trials:[]}),onChanged:()=>()=>{}}
    }};
    const root=createRoot(document.getElementById('root'));
    function App(){const s=useAppStore(s=>s);const ws=workspace();const key=JSON.stringify([s.accountRevision,ws,s.threads[0].created_at]);
      return <main style={{position:'relative',height:'100vh',padding:20}}>
        <textarea aria-label='原聊天草稿' defaultValue='保留未发送内容'/>
        <button onClick={()=>s.setShowCustomizeView(true)}>插件使用入口</button>
        <div hidden={!s.showCustomizeView}><InstalledChatPluginUse key={key} input={{threadId:'chat',expectedWorkspace:ws,pluginId:'installed',expected:{name:'notes',version:'1.0.0'}}} report={report()} disabled={s.fixtureDisabled}/></div>
        <PlatformWorkspace key={key} scopeKey={key} threadId='chat' active={!s.showCustomizeView} api={surfaceApi}/>
      </main>}
    root.render(<App/>);
    window.surfaceFixture={ops,disable:value=>window.fixtureStore.update({fixtureDisabled:value}),
      refresh:()=>{for(const fn of listeners)fn({threadId:'chat'})},
      deferList:()=>deferList=true,finishList:()=>releaseList(),deferOpen:()=>deferOpen=true,finishOpen:()=>releaseOpen(),
      changeScope:()=>window.fixtureStore.update({accountRevision:state().accountRevision+1,threads:[{thread_id:'chat',created_at:'birth-2',metadata:{workspacePath:'C:/new',agentMode:'normal'}}]}),
      version:()=>{version++;for(const fn of listeners)fn({threadId:'chat'})},
      badDirectory:value=>{catalogError=value;for(const fn of listeners)fn({threadId:'chat'})},
      empty:()=>{empty=true;cold=true;for(const fn of listeners)fn({threadId:'chat'})},
      snapshot:()=>({frames:[...frames.keys()],cold,blocks})};
  `
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    alias: { "@": renderer },
    loader: { ".md": "text", ".png": "dataurl" },
    define: {
      "process.env.NODE_ENV": '"development"',
      "import.meta.env": "{}",
      "import.meta.hot": "undefined"
    },
    plugins: [
      {
        name: "store-fixture",
        setup(builder) {
          builder.onResolve({ filter: /(?:^@\/lib\/store$|^\.\/store$|\/lib\/store$)/ }, () => ({
            path: "store",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "tsx",
            resolveDir: process.cwd(),
            contents: `
        import {useSyncExternalStore}from'react';const listeners=new Set();
        let state={accountRevision:1,currentThreadId:'chat',mainView:'thread',showCustomizeView:true,threads:[{thread_id:'chat',created_at:'birth-1',metadata:{workspacePath:'C:/owned',agentMode:'normal'}}]};
        const update=patch=>{state={...state,...patch};for(const fn of listeners)fn()};
        state.setShowCustomizeView=value=>update({showCustomizeView:value});state.selectThread=async id=>update({currentThreadId:id,showCustomizeView:false});
        state.setRightModule=()=>{};state.setRightPanelCollapsed=()=>{};
        export const useAppStore=selector=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn)},()=>selector(state));
        useAppStore.getState=()=>state;useAppStore.subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};
        export const isThreadDeletionPending=()=>false,isThreadRetired=()=>false;
        window.fixtureStore={update,get:()=>state};
      `
          }))
        }
      },
      browserWorkerPlugin()
    ]
  })
  const css = await compile(readFileSync(resolve(renderer, "index.css"), "utf8"), {
    base: renderer,
    onDependency: () => undefined
  })
  const candidates = new Scanner({}).scanFiles(
    [
      "components/platform/PlatformWorkspace.tsx",
      "components/platform/PluginSurfaceEntries.tsx",
      "components/customize/InstalledChatPluginUse.tsx",
      "components/customize/FunctionPluginApproval.tsx",
      ...readdirSync(resolve(renderer, "components/ui"))
        .filter((n) => n.endsWith(".tsx"))
        .map((n) => "components/ui/" + n)
    ].map((file) => ({ content: readFileSync(resolve(renderer, file), "utf8"), extension: "tsx" }))
  )
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  const errors: string[] = [],
    checks: string[] = []
  const pass = (message: string) => {
    checks.push(message)
    console.log("PASS " + message)
  }
  page.setDefaultTimeout(10000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.route("https://surface.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' })
    )
    await page.goto("https://surface.test/")
    await page.addStyleTag({ content: css.build(candidates) })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.getByRole("button", { name: "确认并进入使用", exact: true }).click()
    const entrySection = page.locator('section[aria-label="插件界面入口"]')
    const find = entrySection.getByRole("button", { name: "查找插件界面", exact: true })
    await find.waitFor()
    await page.evaluate("window.surfaceFixture.deferList()")
    await find.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await page.evaluate("window.surfaceFixture.disable(true);window.surfaceFixture.finishList()")
    await page.waitForFunction(
      "document.querySelector('[aria-label=\"插件界面入口\"]')?.textContent?.includes('正在核对界面入口') === false"
    )
    assert.equal(
      await page.evaluate("window.surfaceFixture.ops.filter(x=>x[0]==='prepare').length"),
      0
    )
    await page.evaluate("window.surfaceFixture.disable(false)")
    await entrySection.getByRole("button", { name: "查找插件界面", exact: true }).click()
    await entrySection.getByRole("button", { name: "打开笔记设置", exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.surfaceFixture.ops.filter(x=>x[0]==='approve').length"),
      1
    )
    assert.equal(await entrySection.getByRole("button", { name: "打开foreign" }).count(), 0)
    await entrySection.getByRole("button", { name: "打开笔记设置", exact: true }).click()
    const region = page.getByRole("region", { name: "笔记设置", exact: true })
    await region.waitFor()
    assert.equal(
      await page.evaluate("window.surfaceFixture.ops.filter(x=>x[0]==='open').at(-1)[1]"),
      "second:1"
    )
    await region.getByRole("button", { name: "更新笔记", exact: true }).click()
    await page.getByText("页面内容 1", { exact: true }).waitFor()
    await page.getByRole("button", { name: "返回聊天", exact: true }).click()
    assert.equal(
      await page.getByRole("textbox", { name: "原聊天草稿" }).inputValue(),
      "保留未发送内容"
    )
    pass(
      "real installed-use confirmation opens the exact second same-id capability, acts and returns without losing draft"
    )
    await page.getByRole("button", { name: "插件使用入口", exact: true }).click()
    const target = entrySection.getByRole("button", { name: "打开笔记页", exact: true })
    await target.waitFor()
    await page.evaluate("window.surfaceFixture.deferList()")
    const before = await page.evaluate("window.surfaceFixture.ops.filter(x=>x[0]==='open').length")
    await target.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await page.evaluate("window.surfaceFixture.refresh()")
    assert(await target.isDisabled(), "read-only refresh must not release interactive pending")
    await page.evaluate("window.surfaceFixture.finishList()")
    await page.getByRole("region", { name: "笔记页", exact: true }).waitFor()
    assert.equal(
      await page.evaluate("window.surfaceFixture.ops.filter(x=>x[0]==='open').length"),
      before + 1
    )
    pass("same-tick double click and read-only refresh produce one navigation and one open")
    await page.getByRole("button", { name: "返回聊天", exact: true }).click()
    await page.getByRole("button", { name: "插件使用入口", exact: true }).click()
    await target.waitFor()
    await page.evaluate("window.surfaceFixture.deferOpen()")
    const pendingBefore = await page.evaluate(
      "window.surfaceFixture.ops.filter(x=>x[0]==='open').length"
    )
    await target.click()
    await page.waitForFunction(
      `window.surfaceFixture.ops.filter(x=>x[0]==='open').length === ${pendingBefore + 1}`
    )
    const oldOpen = await page.evaluate(
      "window.surfaceFixture.ops.filter(x=>x[0]==='open').at(-1)[2]"
    )
    await page.evaluate("window.surfaceFixture.changeScope()")
    await page.getByRole("button", { name: "笔记设置", exact: true }).click()
    await region.waitFor()
    const newOpen = await page.evaluate(
      "window.surfaceFixture.ops.filter(x=>x[0]==='open').at(-1)[2]"
    )
    await page.evaluate("window.surfaceFixture.finishOpen()")
    await page.waitForFunction(
      (id) => window.surfaceFixture.ops.some((row) => row[0] === "close" && row[1] === id),
      oldOpen
    )
    assert(await region.isVisible(), "late old-scope reply cannot replace the current page")
    assert(
      await page.evaluate((id) => window.surfaceFixture.snapshot().frames.includes(id), newOpen)
    )
    pass("account/directory/birth change retires a late old open without closing the new page")
    await page.getByRole("button", { name: "返回聊天", exact: true }).click()
    await page.getByRole("button", { name: "插件使用入口", exact: true }).click()
    await target.waitFor()
    await page.evaluate("window.surfaceFixture.deferList()")
    const beforeStale = await page.evaluate(
      "window.surfaceFixture.ops.filter(x=>x[0]==='open').length"
    )
    await target.click()
    await page.evaluate("window.surfaceFixture.version();window.surfaceFixture.finishList()")
    await page
      .getByRole("alert")
      .filter({ hasText: /界面.*许可.*变化/ })
      .waitFor()
    assert.equal(await page.getByRole("region", { name: "笔记页", exact: true }).count(), 0)
    assert.equal(
      await page.evaluate("window.surfaceFixture.ops.filter(x=>x[0]==='open').length"),
      beforeStale
    )
    pass(
      "source generation change rejects the old entry key rather than opening a same-id replacement"
    )
    await page
      .getByRole("alert")
      .filter({ hasText: /界面.*许可.*变化/ })
      .getByRole("button", { name: "关闭", exact: true })
      .click()
    await page.evaluate("window.surfaceFixture.badDirectory(true)")
    await page
      .locator("[data-platform-workspace]")
      .getByText("notes/invalid: 页面声明不可用", { exact: true })
      .waitFor()
    await page.evaluate("window.surfaceFixture.badDirectory(false);window.surfaceFixture.empty()")
    await page.locator("[data-platform-workspace]").waitFor({ state: "detached" })
    await page.getByRole("button", { name: "插件使用入口", exact: true }).click()
    await page.getByRole("button", { name: "查找插件界面", exact: true }).click()
    await page.getByText("此版本没有独立界面，可按上方使用方式在聊天中触发命令或规则。", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("textbox", { name: "原聊天草稿" }).inputValue(),
      "保留未发送内容"
    )
    pass(
      "invalid declarations retain recovery; empty catalogues stay quiet in chat and are explained in plugin settings"
    )
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "continuity.png"), fullPage: true })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          passed: true,
          scope:
            "Production React installed card, source entry and original workspace; controlled IPC, no model/business run",
          checks,
          errors
        },
        null,
        2
      )
    )
    console.log("PASS " + checks.join("; "))
  } catch (cause) {
    console.error(await page.locator("body").innerText())
    console.error(await page.evaluate("window.surfaceFixture.ops.slice(-15)"))
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true })
    throw cause
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
