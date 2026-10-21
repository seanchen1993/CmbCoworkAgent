/** Real React lifecycle and browser events, with controllable IPC latency. No app/user data. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { chromium, type Page } from "playwright"
import { verifyPolicyUsability } from "./support/mods-policy-usability-e2e"

const root = resolve(__dirname, "..")
const renderer = join(root, "src/renderer/src")
const source = (path: string) => JSON.stringify(join(renderer, path))
const pass = (text: string) => console.log("PASS " + text)
async function mount(page: Page, contents: string) {
  const result = await build({
    stdin: { resolveDir: root, loader: "tsx", contents },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".md": "text", ".png": "dataurl" },
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    plugins: [
      {
        name: "unrelated-app-store",
        setup(builder) {
          // This suite exercises installed settings; authoring has its own browser/worker suite.
          builder.onResolve({ filter: /^\.\/ModCreator$/ }, args =>
            args.importer.endsWith("ModsPanel.tsx")
              ? { path: "creator", namespace: "unused-creator" } : undefined)
          builder.onLoad({ filter: /.*/, namespace: "unused-creator" }, () => ({
            contents: "export const ModCreator=()=>null"
          }))
          // No code leaf is used by these empty-state/eligibility fixtures.
          builder.onResolve({ filter: /^\.\/FunctionCode$/ }, () => ({
            path: "code",
            namespace: "unused-code-leaf"
          }))
          builder.onLoad({ filter: /.*/, namespace: "unused-code-leaf" }, () => ({
            contents: "export const FunctionCode=()=>null"
          }))
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) =>
            args.path === "@/lib/store" || args.importer.replaceAll("\\", "/").includes("/src/renderer/src/lib/")
              ? { path: "store", namespace: "fixture" }
              : undefined
          )
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              "export const isThreadDeletionPending=()=>false;export const isThreadRetired=()=>false;const state={accountRevision:0,bumpPluginVersion(){},setShowCustomizeView:(...args)=>window.fixtureNavigation=args};export const useAppStore=selector=>selector(state);useAppStore.getState=()=>state"
          }))
        }
      }
    ]
  })
  await page.setContent('<div id="root"></div>')
  await page.addScriptTag({ content: result.outputFiles[0].text })
}
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )

async function verifyOuterPanel(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {ModsPanel} from ${source("components/customize/ModsPanel.tsx")};
    let finish, reject, deferRead=false, finishRead, reads=[], calls=[], enabled=true, failGlobal=false;
    const configListeners=new Set();
    const status=id=>({workspace:id,enabled:true,outputPolicy:false,mods:[],functionMods:[],diagnostics:[]});
    window.api={featureGates:{isEnabled:async()=>({enabled:true})},plugins:{list:async()=>[]},mods:{communityExamples:{list:async()=>({examples:[]})},
      functionUnlocked:async()=>true,globalEnabled:async()=>{if(failGlobal)throw Error("global read");return enabled},
      onConfigurationChanged:fn=>{configListeners.add(fn);return ()=>configListeners.delete(fn)},
      configureGlobal:async value=>{await new Promise(r=>finish=r);enabled=value;for(const fn of configListeners)fn();return value},
      status:async id=>{reads.push(id);if(id==="failed")throw Error("workspace read");if(deferRead){deferRead=false;return new Promise(r=>finishRead=()=>r(status(id)));}return status(id)},
      configure:async(id,value)=>{calls.push(id);await new Promise((r,j)=>{finish=r;reject=j});return value}
    }};
    const host=createRoot(document.getElementById("root"));
    window.fixture={render:id=>host.render(<ModsPanel threadId={id}/>),
      finish:()=>finish(),reject:()=>reject(Error("OLD_PROJECT_ERROR")),
      failGlobal:()=>failGlobal=true,recoverGlobal:()=>failGlobal=false,deferRead:()=>deferRead=true,finishRead:()=>finishRead(),reads:()=>reads,calls:()=>calls};
    window.fixture.render("a");
  `
  )
  await page.getByRole("button", { name: "我已添加", exact: true }).click()
  await page.getByText("当前项目：a", { exact: true }).waitFor()
  await page.getByLabel("在此项目使用灵件", { exact: true }).click()
  await page.waitForFunction("window.fixture.calls().length === 1")
  await page.evaluate("window.fixture.render('b')")
  await page.getByText("当前项目：b", { exact: true }).waitFor()
  await page.evaluate("window.fixture.finish()")
  await settle(page)
  assert(await page.getByLabel("在此项目使用灵件", { exact: true }).isEnabled())
  assert(await page.getByLabel("在此项目使用灵件", { exact: true }).isChecked())
  assert.deepEqual(await page.evaluate("window.fixture.reads()"), ["a", "b", "b"])
  await page.getByLabel("在此项目使用灵件", { exact: true }).click()
  await page.waitForFunction("window.fixture.calls().length === 2")
  await page.evaluate("window.fixture.render('c')")
  await page.getByText("当前项目：c", { exact: true }).waitFor()
  await page.evaluate("window.fixture.reject()")
  await settle(page)
  assert.equal(await page.getByRole("alert").count(), 0)
  assert(await page.getByLabel("在此项目使用灵件", { exact: true }).isEnabled())
  await page.evaluate("window.fixture.deferRead();window.fixture.render('d')")
  await page.waitForFunction("window.fixture.reads().includes('d')")
  await page.evaluate("window.fixture.render('e')")
  await page.getByText("当前项目：e", { exact: true }).waitFor()
  await page.evaluate("window.fixture.finishRead()")
  await settle(page)
  assert.equal(await page.getByText("当前项目：d", { exact: true }).count(), 0)
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), ["a", "b"])
  pass("outer settings isolate old project reads, successful operations and failed operations")
  await page.getByLabel("允许使用灵件", { exact: true }).click()
  await page.evaluate("window.fixture.render('f')")
  await page.getByText("当前项目：f", { exact: true }).waitFor()
  assert(await page.getByLabel("允许使用灵件", { exact: true }).isChecked())
  await page.evaluate("window.fixture.finish()")
  await page.waitForFunction(
    () => !(document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked
  )
  assert.equal(
    await page.getByLabel("允许使用灵件", { exact: true }).isChecked(),
    false
  )
  pass("global change finishing in unmounted project A still updates the current project's view")
  // Restore the known on state, then fail only the independent workspace read.
  await page.getByLabel("允许使用灵件", { exact: true }).click()
  await page.evaluate("window.fixture.finish()")
  await page.getByLabel("在此项目使用灵件", { exact: true }).waitFor()
  await page.evaluate("window.fixture.render('failed')")
  await page.getByRole("alert").waitFor()
  await page.getByRole("alert").filter({ hasText: "无法读取项目灵件状态" }).waitFor()
  assert(await page.getByRole("button", { name: "重新读取", exact: true }).isEnabled())
  assert(await page.getByLabel("允许使用灵件", { exact: true }).isChecked())
  assert(await page.getByLabel("允许使用灵件", { exact: true }).isEnabled())
  await page.evaluate("window.fixture.failGlobal();window.fixture.render('g')")
  await page.getByText("当前项目：g", { exact: true }).waitFor()
  assert(await page.getByLabel("允许使用灵件", { exact: true }).isDisabled())
  await page.evaluate("window.fixture.recoverGlobal()")
  await page.getByRole("button", { name: "重新读取", exact: true }).click()
  await page.waitForFunction(
    () => !(document.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled
  )
  assert.equal(await page.getByRole("alert").count(), 0)
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), ["a", "b"])
  pass("partial read failure preserves successful fields; unknown global state cannot be toggled")
}

async function verifyReaders(page: Page) {
  await mount(
    page,
    `
    import {useSyncExternalStore} from "react";
    import {createRoot} from "react-dom/client";
    import {FunctionCompletionEvidence} from ${source("components/chat/FunctionCompletionEvidence.tsx")};
    import {ModsChatScope} from ${source("lib/mods-chat-scope.tsx")};
    import {FunctionFeedback} from ${source("components/chat/FunctionFeedback.tsx")};
    import {FunctionLogs} from ${source("components/chat/FunctionLogs.tsx")};
    import {subscribeModCards,getModCards} from ${source("lib/mod-cards-store.ts")};
    let enabled=true, hold=false, releases=[];
    const counters={cards:0,feedback:0,logs:0,evidence:0,global:0};
    const cardListeners=new Set(),configListeners=new Set();
    const read=async(kind,id)=>{
      counters[kind]++;
      const value=!enabled||kind==="evidence"?[]:[{id:id+kind,plugin:"test",kind:"status",text:id+kind}];
      if(hold)await new Promise(r=>releases.push(r));
      return value;
    };
    window.api={mods:{globalEnabled:async()=>{counters.global++;return enabled},
      cards:id=>read("cards",id),feedback:id=>read("feedback",id),logs:id=>read("logs",id),
      completionEvidence:id=>read("evidence",id),
      onCardsChanged:fn=>{cardListeners.add(fn);return ()=>cardListeners.delete(fn)},
      onConfigurationChanged:fn=>{configListeners.add(fn);return ()=>configListeners.delete(fn)}
    }};
    function Cards({id}){
      const cards=useSyncExternalStore(fn=>subscribeModCards(id,fn),()=>getModCards(id));
      return <div data-cards>{cards.map(card=>card.text).join("")}</div>;
    }
    const host=createRoot(document.getElementById("root"));
    const render=id=>host.render(<ModsChatScope.Provider value={{threadId:id,enabled:true}}><FunctionCompletionEvidence threadId={id} isWorking={false}/><FunctionFeedback threadId={id}/><FunctionLogs threadId={id}/><Cards id={id}/></ModsChatScope.Provider>);
    window.fixture={render,counts:()=>({...counters}),listeners:()=>[cardListeners.size,configListeners.size],
      pane:()=>{for(const fn of cardListeners)fn({threadId:"a",scope:"panes"})},
      all:()=>{for(const fn of cardListeners)fn({threadId:"a"})},
      config:()=>{for(const fn of configListeners)fn()},
      off:()=>enabled=false,hold:()=>hold=true,release:()=>{hold=false;for(const r of releases.splice(0))r()},
      unmount:()=>host.unmount()};
    render("a");
  `
  )
  await page.locator("[data-function-log]").filter({ hasText: "alogs" }).waitFor()
  await page.locator("[data-cards]").filter({ hasText: "acards" }).waitFor()
  await page.waitForFunction("window.fixture.counts().evidence === 1")
  const baseline = await page.evaluate("window.fixture.counts()")
  assert.deepEqual(await page.evaluate("window.fixture.listeners()"), [4, 4])
  await page.evaluate("for(let i=0;i<100;i++)window.fixture.pane()")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), baseline)
  pass("100 panes-only notifications produce zero extra IPC in all four unrelated readers")
  await page.evaluate("window.fixture.all()")
  await page.waitForFunction("window.fixture.counts().evidence === 2")
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), {
    cards: 2,
    feedback: 2,
    logs: 2,
    evidence: 2,
    global: 2
  })
  await page.evaluate("window.fixture.hold();window.fixture.all()")
  await page.waitForFunction("window.fixture.counts().evidence === 3")
  await page.evaluate("window.fixture.off();window.fixture.config();window.fixture.release()")
  await page.waitForFunction(
    "window.fixture.counts().cards === 4 && window.fixture.counts().global === 4"
  )
  await settle(page)
  assert.equal(await page.locator("[data-function-feedback],[data-function-logs]").count(), 0)
  assert.equal(await page.locator("[data-cards]").textContent(), "")
  await page.evaluate("window.fixture.render('b')")
  await settle(page)
  const afterSwitch = await page.evaluate("window.fixture.counts()")
  await page.evaluate("window.fixture.all()")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), afterSwitch)
  await page.evaluate("window.fixture.unmount()")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.listeners()"), [0, 0])
  const afterUnmount = await page.evaluate("window.fixture.counts()")
  await page.evaluate("window.fixture.all();window.fixture.config()")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), afterUnmount)
  pass(
    "global updates still refresh all readers; native disable supersedes pending data and listeners are cleaned up"
  )
}

async function verifyCompatibilityCheck(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {FunctionCompatibilityCheck} from ${source("components/customize/FunctionCompatibilityCheck.tsx")};
    const callbacks=[],calls=[],configuration=new Set();
    window.api={mods:{onConfigurationChanged:fn=>{configuration.add(fn);return()=>configuration.delete(fn)},
      checkFunctionCompatibility:(id,plugin,digest)=>{
      calls.push({id,plugin,digest});return new Promise((resolve,reject)=>callbacks.push({resolve,reject}));
    }}};
    const root=createRoot(document.getElementById("root"));
    window.fixture={
      render:(id,digest="version1")=>root.render(<FunctionCompatibilityCheck threadId={id} pluginId="plugin" digest={digest} disabled={false}/>),
      calls:()=>calls,
      configuration:()=>{for(const fn of configuration)fn()},
      listeners:()=>configuration.size,
      close:()=>root.unmount(),
      resolve:(n,digest="version1")=>callbacks[n].resolve({digest,
        compatibility:{status:"bounded",registrations:[],diagnostics:[]},
        sdkCompatibility:{digest,strictCompatible:false,runtimeVerified:false,
          diagnostics:[{code:"MODS_SDK_UNSUPPORTED",message:"示例接口尚未支持",file:"hooks/example.mjs",line:4,column:1}]}}),
      reject:(n,code="MODS_CHECK_BUSY")=>callbacks[n].reject(Error(code))
    };
    window.fixture.render("a");
  `
  )
  const button = () => page.getByRole("button", { name: "检查社区兼容性", exact: true })
  await button().waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [])
  await button().click()
  assert(await page.getByRole("button", { name: "正在检查兼容性…", exact: true }).isDisabled())
  await page.evaluate("window.fixture.render('b')")
  await button().waitFor()
  await page.evaluate("window.fixture.resolve(0)")
  await settle(page)
  assert.equal(await page.getByRole("status").count(), 0)
  await button().click()
  await page.evaluate("window.fixture.render('b','version2')")
  await button().waitFor()
  await page.evaluate("window.fixture.reject(1)")
  await settle(page)
  assert.equal(await page.getByRole("alert").count(), 0)
  await button().click()
  await page.evaluate("window.fixture.resolve(2,'version2')")
  await page.getByText("已接入这些规则的触发入口", { exact: true }).waitFor()
  await page
    .getByText("这是兼容性检查，尚未验证整包的实际效果。仍需批准能力，并试用作者提供的功能。", {
      exact: true
    })
    .waitFor()
  await page.getByText("有接口暂不支持或需要确认", { exact: true }).waitFor()
  await page.getByText("示例接口尚未支持", { exact: true }).waitFor()
  await page.getByText("hooks/example.mjs:4", { exact: true }).waitFor()
  await button().click()
  await page.evaluate("window.fixture.reject(3)")
  await page.getByText("另一个插件正在检查，请稍后重试。", { exact: true }).waitFor()
  assert(await button().isEnabled())
  assert.equal(await page.getByRole("status").count(), 0)
  await button().click()
  await page.evaluate("window.fixture.reject(4,'MODS_SECRET_CODE_APPROVAL_REQUIRED')")
  await page
    .getByText("这个版本尚未获准读取已保存的敏感参数。请先核对并批准插件代码，再重新检查。", {
      exact: true
    })
    .waitFor()
  assert(await button().isEnabled())
  pass(
    "compatibility check is explicit, drops stale replies and explains busy or missing secret approval"
  )
  await button().click()
  await page.evaluate("window.fixture.resolve(5,'version2')")
  await page.getByRole("status").waitFor()
  await page.evaluate("window.fixture.configuration()")
  await settle(page)
  assert.equal(await page.getByRole("status").count(), 0)
  assert.equal(await page.getByText("示例接口尚未支持", { exact: true }).count(), 0)
  assert(await button().isEnabled())
  // A configuration event invalidates the old request without letting its finally
  // clear the busy state or duplicate-request guard of the replacement request.
  await button().click()
  await page.evaluate("window.dispatchEvent(new Event('mods:configuration-changed'))")
  await button().waitFor()
  await button().click()
  await page.evaluate("window.fixture.resolve(6,'version2')")
  await settle(page)
  assert.equal(await page.getByRole("status").count(), 0)
  assert(await page.getByRole("button", { name: "正在检查兼容性…", exact: true }).isDisabled())
  await page.evaluate("window.fixture.resolve(7,'version2')")
  await page.getByRole("status").waitFor()
  await button().click()
  await page.evaluate("window.fixture.configuration()")
  await button().waitFor()
  await button().click()
  await page.evaluate("window.fixture.reject(8)")
  await settle(page)
  assert.equal(await page.getByRole("alert").count(), 0)
  assert(await page.getByRole("button", { name: "正在检查兼容性…", exact: true }).isDisabled())
  await page.evaluate("window.fixture.resolve(9,'version2')")
  await page.getByRole("status").waitFor()
  assert.equal(await page.evaluate("window.fixture.calls().length"), 10)
  assert.equal(await page.evaluate("window.fixture.listeners()"), 1)
  await page.evaluate("window.fixture.close()")
  assert.equal(await page.evaluate("window.fixture.listeners()"), 0)
  pass("configuration changes clear completed compatibility results and reject late success/error/finally from older checks")

}

async function verifyPeerMessages(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {FunctionPeerMessages} from ${source("components/chat/FunctionPeerMessages.tsx")};
    import {ModsChatScope} from ${source("lib/mods-chat-scope.tsx")};
    let enabled=false,reads=0,hold=false,release;
    const config=new Set(),peers=new Set();
    window.api={mods:{globalEnabled:async()=>enabled,
      peerMessages:async id=>{reads++;const result=[{id,plugin:"test",text:"peer-"+id,
        fromAgentId:"child",status:"delivered",createdAt:1,updatedAt:1}];
        if(hold)await new Promise(r=>release=r);return result},
      onPeerMessagesChanged:fn=>{peers.add(fn);return()=>peers.delete(fn)},
      onConfigurationChanged:fn=>{config.add(fn);return()=>config.delete(fn)}}};
    const host=createRoot(document.getElementById("root"));
    window.fixture={render:id=>host.render(<ModsChatScope.Provider value={{threadId:id,enabled:true}}><FunctionPeerMessages threadId={id}/></ModsChatScope.Provider>),
      reads:()=>reads,enable:value=>{enabled=value;for(const fn of config)fn()},
      hold:()=>hold=true,release:()=>{hold=false;release?.()},
      refresh:()=>{for(const fn of peers)fn({threadId:"a"})},
      close:()=>host.unmount(),listeners:()=>[config.size,peers.size]};
    window.fixture.render("a");
  `
  )
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.reads()"), 0)
  assert.equal(await page.locator("[data-function-peer-messages]").count(), 0)
  await page.evaluate("window.fixture.enable(true)")
  await page.locator("[data-function-peer-messages]").waitFor()
  await page.locator("[data-function-peer-messages] summary").click()
  await page.getByText("peer-a", { exact: true }).waitFor()
  await page.evaluate("window.fixture.hold();window.fixture.refresh()")
  await settle(page)
  await page.evaluate("window.fixture.enable(false);window.fixture.release()")
  await settle(page)
  assert.equal(await page.locator("[data-function-peer-messages]").count(), 0)
  await page.evaluate("window.fixture.close()")
  assert.deepEqual(await page.evaluate("window.fixture.listeners()"), [0, 0])
  pass(
    "Mods-off sends zero peer queries; disable discards delayed records and unmount releases listeners"
  )
}

async function verifyChatScope(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {ModsChatScope,useModsChatState} from ${source("lib/mods-chat-scope.tsx")};
    import {FunctionSite} from ${source("components/chat/FunctionSite.tsx")};
    import {FunctionPanes} from ${source("components/chat/FunctionPanes.tsx")};
    import {FunctionFeedback} from ${source("components/chat/FunctionFeedback.tsx")};
    import {FunctionLogs} from ${source("components/chat/FunctionLogs.tsx")};
    import {FunctionPeerMessages} from ${source("components/chat/FunctionPeerMessages.tsx")};
    import {FunctionCompletionEvidence} from ${source("components/chat/FunctionCompletionEvidence.tsx")};
    import {ModCards} from ${source("components/chat/ModCards.tsx")};
    import {ModCommandJobs} from ${source("components/chat/ModCommandJobs.tsx")};
    import {useModCommands} from ${source("features/slash-commands/useModCommands.ts")};
    import {useFunctionTurnNotices} from ${source("lib/use-function-turn-notices.ts")};
    let enabled=false,hold=false,release,fail=false;
    const calls=[],listeners=new Map();
    const subscribe=(key,fn)=>{let set=listeners.get(key);if(!set)listeners.set(key,set=new Set());set.add(fn);return()=>set.delete(fn)};
    const mods={globalEnabled:async()=>enabled,
      chatDisplayCapability:(id,workspace)=>{calls.push(["capability",id,workspace]);const value=enabled;
        return hold?new Promise(r=>release=()=>r(value)):Promise.resolve(value)}};
    for(const name of ["cards","jobs","logs","panes","feedback","peerMessages","completionEvidence","commands","turnNotices"])
      mods[name]=async id=>{calls.push([name,id]);return []};
    for(const name of ["onCardsChanged","onJobsChanged","onPeerMessagesChanged","onConfigurationChanged"])
      mods[name]=fn=>subscribe(name,fn);
    mods.siteMountOutcome=async(id,kind)=>{calls.push(["siteMount",id]);if(fail)throw Error("REAL_RENDER_FAILURE");return {state:"mounted",owner:id+kind}};
    mods.siteRender=async()=>null;
    mods.siteUnmount=async()=>{};
    window.api={mods};
    function App({id,workspace}){
      const state=useModsChatState(id,workspace);const enabled=state.enabled;
      useModCommands(id,enabled);useFunctionTurnNotices(id,enabled);
      return <ModsChatScope.Provider value={{threadId:id,...state}}>
        <FunctionSite threadId={id} component="PromptHint" facts={{}} fallback={<span>Native fallback</span>}/>
        <ModCards threadId={id}/><ModCommandJobs threadId={id}/><FunctionLogs threadId={id}/>
        <FunctionPanes threadId={id}/><FunctionFeedback threadId={id}/><FunctionPeerMessages threadId={id}/>
        <FunctionCompletionEvidence threadId={id} isWorking={false}/>
      </ModsChatScope.Provider>
    }
    const host=createRoot(document.getElementById("root"));
    window.fixture={render:(id,workspace)=>host.render(<App id={id} workspace={workspace}/>),
      calls:()=>calls.slice(),clear:()=>calls.length=0,
      enabled:value=>{enabled=value;for(const fn of [...(listeners.get("onConfigurationChanged")??[])])fn()},
      hold:()=>hold=true,release:()=>{hold=false;release?.()},fail:()=>fail=true,
      listeners:()=>Object.fromEntries([...listeners].map(([key,set])=>[key,set.size])),close:()=>host.unmount()};
    window.fixture.render("draft",null);
  `
  )
  await page.getByRole("alert").waitFor()
  assert.equal(await page.getByText("Native fallback", { exact: true }).count(), 0)
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [])
  assert.deepEqual(await page.evaluate("window.fixture.listeners()"), {})
  await page.evaluate("window.fixture.render('a','workspace-a')")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.calls().filter(x=>x[0]!=='capability')"), [])
  await page.getByText("Native fallback", { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [["capability", "a", "workspace-a"]])
  assert.deepEqual(await page.evaluate("window.fixture.listeners()"), {
    onConfigurationChanged: 1, onCardsChanged: 1
  })
  await page.evaluate("window.fixture.enabled(true)")
  await page.waitForFunction("window.fixture.calls().some(x=>x[0]==='siteMount')")
  for (const name of [
    "cards",
    "jobs",
    "logs",
    "panes",
    "feedback",
    "peerMessages",
    "completionEvidence",
    "commands",
    "turnNotices"
  ])
    await page.waitForFunction(`window.fixture.calls().some(x=>x[0]===${JSON.stringify(name)})`)
  await page.evaluate("window.fixture.render('a',null)")
  await settle(page)
  await page.evaluate(
    "window.fixture.enabled(false);window.fixture.clear();window.fixture.render('a','workspace-a')"
  )
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.calls().filter(x=>x[0]!=='capability')"), [])
  await page.evaluate("window.fixture.enabled(true)")
  await page.waitForFunction("window.fixture.calls().some(x=>x[0]==='siteMount')")
  await page.evaluate("window.fixture.enabled(false)")
  await settle(page)
  await page.evaluate("window.fixture.clear();window.dispatchEvent(new Event('focus'))")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [])
  const disabledListeners = (await page.evaluate("window.fixture.listeners()")) as Record<
    string,
    number
  >
  assert.equal(disabledListeners.onConfigurationChanged, 1)
  assert.equal(disabledListeners.onCardsChanged, 1)
  assert(
    Object.entries(disabledListeners).every(
      ([name, count]) => ["onConfigurationChanged", "onCardsChanged"].includes(name) || count === 0
    )
  )
  await page.evaluate("window.fixture.hold();window.fixture.enabled(true)")
  await settle(page)
  await page.evaluate("window.fixture.render('empty',null)")
  await settle(page)
  await page.evaluate("window.fixture.clear();window.fixture.release()")
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [])
  assert.equal(
    await page.getByText("灵件显示更新失败，请重试。", { exact: true }).count(),
    0
  )
  await page.evaluate("window.fixture.fail();window.fixture.render('b','workspace-b')")
  await page.getByText("灵件显示更新失败，请重试。", { exact: true }).waitFor()
  assert(await page.getByRole("button", { name: "重新读取界面", exact: true }).isEnabled())
  // A failed mount is not a host assertion that this site is inactive.
  assert.equal(await page.getByText("Native fallback", { exact: true }).count(), 0)
  await page.evaluate("window.fixture.close()")
  await settle(page)
  const closedListeners = await page.evaluate("window.fixture.listeners()") as Record<string, number>
  assert.equal(closedListeners.onConfigurationChanged, 0)
  assert.equal(closedListeners.onCardsChanged, 0)
  assert(
    Object.values(
      (await page.evaluate("window.fixture.listeners()")) as Record<string, number>
    ).every((count) => count === 0)
  )
  pass(
    "chat scope skips Mods reads without workspace/off, retains exactly the capability/configuration invalidators while off, discards stale enable and releases both listeners on unmount"
  )
}

async function verifyDisabledJobHistory(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {ModsChatScope} from ${source("lib/mods-chat-scope.tsx")};
    import {ModCommandJobs} from ${source("components/chat/ModCommandJobs.tsx")};
    let reads=0,sites=0,cancels=0,hold=false,release;
    const listeners=new Set(),cards=new Set(),configuration=new Set();
    const rows=[{id:"done",command:"completed",state:"succeeded",presentation:"inline",
      createdAt:1,result:{text:"ORIGINAL_OUTPUT"}},
      {id:"busy",command:"unfinished",state:"running",createdAt:1}];
    window.api={mods:{jobs:async()=>{reads++;if(hold)return new Promise(r=>release=()=>r(rows.map(x=>({...x,result:{text:"LATE_OUTPUT"}}))));return rows},
      onJobsChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},
      onCardsChanged:fn=>{cards.add(fn);return()=>cards.delete(fn)},
      onConfigurationChanged:fn=>{configuration.add(fn);return()=>configuration.delete(fn)},
      siteMountOutcome:async()=>{sites++;return {state:"inactive"}},siteUnmount:async()=>{},
      cancelJob:async()=>cancels++}};
    const host=createRoot(document.getElementById("root"));
    window.fixture={render:(id,enabled)=>host.render(<ModsChatScope.Provider value={{threadId:id,enabled}}>
      <ModCommandJobs threadId={id}/></ModsChatScope.Provider>),
      counts:()=>({reads,sites,cancels,listeners:listeners.size,cards:cards.size,configuration:configuration.size}),
      hold:()=>{hold=true;for(const fn of listeners)fn({threadId:"a"})},release:()=>release?.(),
      close:()=>host.unmount()};
    window.fixture.render("a",false);
  `
  )
  await settle(page)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), {
    reads: 0,
    sites: 0,
    cancels: 0,
    listeners: 0,
    cards: 0,
    configuration: 0
  })
  await page.evaluate("window.fixture.render('a',true)")
  await page.getByText("ORIGINAL_OUTPUT", { exact: true }).waitFor()
  await page.getByRole("button", { name: "停止命令", exact: true }).waitFor()
  await page.evaluate("window.fixture.hold()")
  await page.waitForFunction("window.fixture.counts().reads===2")
  await page.evaluate("window.fixture.render('a',false)")
  await page.getByText("灵件已关闭，以下仅为本次打开的历史结果。", { exact: true }).waitFor()
  await settle(page)
  const counts = await page.evaluate("window.fixture.counts()")
  assert.equal(counts.listeners + counts.cards + counts.configuration, 0)
  assert.equal(await page.getByRole("button", { name: "停止命令" }).count(), 0)
  assert.equal(await page.getByText(/unfinished/).count(), 0)
  await page.evaluate(
    "window.fixture.release();window.dispatchEvent(new Event('mods:configuration-changed'))"
  )
  await settle(page)
  await page.getByText("ORIGINAL_OUTPUT", { exact: true }).waitFor()
  assert.equal(await page.getByText("LATE_OUTPUT", { exact: true }).count(), 0)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), counts)
  await page.evaluate("window.fixture.render('b',false)")
  await settle(page)
  assert.equal(await page.getByText("ORIGINAL_OUTPUT", { exact: true }).count(), 0)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), counts)
  await page.evaluate("window.fixture.close()")
  pass(
    "disabling retains only this thread's already-read native results with zero new reads/listeners/actions; late replies and other threads stay isolated"
  )
}

async function verifyDisabledCommandSubmission(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {useModCommands} from ${source("features/slash-commands/useModCommands.ts")};
    let hold=false,release,current,reads=0,enqueues=0,result,hostEnabled=false;
    const commands=[{command:"demo",name:"Demo",apiVersion:"cmb.mods/v2"}];
    window.api={mods:{globalEnabled:async()=>hostEnabled,commands:async()=>{reads++;if(hold)await new Promise(r=>release=r);return commands},
      enqueue:async()=>{if(!hostEnabled)throw Error("Mods 状态已改变");enqueues++},onCardsChanged:()=>()=>{},onJobsChanged:()=>()=>{}}};
    function App({enabled}){current=useModCommands("thread",enabled);return null}
    const host=createRoot(document.getElementById("root"));
    window.fixture={render:enabled=>{hostEnabled=enabled;host.render(<App enabled={enabled}/>)},
      start:()=>{hold=true;current.submit("/demo").then(v=>result=v,e=>result=String(e))},
      release:()=>{hold=false;release()},result:()=>result,counts:()=>({reads,enqueues}),
      submit:()=>current.submit("/demo"),close:()=>host.unmount()};
    window.fixture.render(false);
  `
  )
  await settle(page)
  assert.equal(await page.evaluate("window.fixture.submit()"), false)
  assert.deepEqual(await page.evaluate("window.fixture.counts()"), { reads: 0, enqueues: 0 })
  await page.evaluate("window.fixture.render(true)")
  await settle(page)
  await page.evaluate("window.fixture.start()")
  await settle(page)
  await page.evaluate("window.fixture.render(false)")
  await settle(page)
  await page.evaluate("window.fixture.release()")
  await page.waitForFunction("typeof window.fixture.result()==='string'")
  assert.match(await page.evaluate("window.fixture.result()"), /Mods 状态已改变/)
  assert.equal(await page.evaluate("window.fixture.counts().enqueues"), 0)
  await page.evaluate("window.fixture.close()")
  pass(
    "disabled slash commands never query the host and an in-flight submission cannot enqueue after disable"
  )
}

async function verifyUsageGuide(page: Page) {
  await mount(
    page,
    `
    import {createRoot} from "react-dom/client";
    import {ModsPanel} from ${source("components/customize/ModsPanel.tsx")};
    let failCopy=false;const copies=[],calls=[];
    import {getThemeDefinition,CSS_VARIABLE_BY_PALETTE_KEY} from ${source("lib/theme-registry.ts")};
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{if(failCopy)throw Error("denied");copies.push(text)}}});
    window.api={featureGates:{isEnabled:async()=>({enabled:true})},plugins:{list:async()=>[]},mods:{communityExamples:{list:async()=>({examples:[]})},globalEnabled:async()=>false,
      onConfigurationChanged:()=>()=>{},
      configureGlobal:async()=>{calls.push("enable")}}};
    const root=createRoot(document.getElementById("root"));
    root.render(<ModsPanel threadId={null}/>);
      window.fixture={copies:()=>copies,calls:()=>calls,failCopy:()=>failCopy=true,
        dark:()=>{document.documentElement.classList.add("dark");for(const [key,value] of Object.entries(getThemeDefinition("codex-dark").palette))document.documentElement.style.setProperty(CSS_VARIABLE_BY_PALETTE_KEY[key],value)},
        missingClipboard:()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:undefined})};
  `
  )
  await page.getByRole("button", { name: "我已添加", exact: true }).click()
  await page.getByRole("heading", { name: "灵件", exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "我已添加", exact: true }).getAttribute("aria-pressed"), "true")
  await page.locator("[data-installed-mods]").waitFor()
  assert(await page.getByRole("heading", { name: "已安装插件", exact: true }).isVisible())
  assert.equal(await page.locator('input[type="password"]').count(), 0)
  assert(await page.getByRole("button", { name: "上传插件（ZIP）" }).isEnabled())
  await page.getByRole("button", { name: "对话创作", exact: true }).click()
  await page.getByText("灵件使用指南", { exact: true }).click()
  const guideSummary = page.locator("summary").filter({
    hasText: "描述需求、确认应用和查看结果"
  })
  await guideSummary.waitFor({ state: "visible" })
  assert.equal(await page.getByRole("tab", { name: "快速上手" }).isVisible(), false)
  await guideSummary.click()
  await page.getByRole("tab", { name: "快速上手" }).waitFor()
  await page.getByText("高级：安装现成插件并使用命令", { exact: true }).click()
  await page.getByRole("button", { name: "复制 /claw-info", exact: true }).click()
  await page.getByText("已复制，回到聊天框粘贴后发送。", { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate("window.fixture.copies()"), ["/claw-info"])
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [])
  await page.evaluate("window.fixture.failCopy()")
  await page.getByRole("button", { name: "复制 /claw-files", exact: true }).click()
  await page.getByText("暂时无法复制，请选中上方命令手动复制。", { exact: true }).waitFor()
  await page.evaluate("window.fixture.missingClipboard()")
  await page.getByRole("button", { name: "复制 /claw-info", exact: true }).click()
  assert.equal(
    await page.getByText("暂时无法复制，请选中上方命令手动复制。", { exact: true }).count(),
    2
  )
  await page.getByRole("tab", { name: "代码检查示例" }).click()
  await page.getByText("需要更严格的代码检查？", { exact: true }).waitFor()
  await page.getByRole("button", { name: "复制 /claw-review-status", exact: true }).waitFor()
  await page.getByRole("tab", { name: "常见问题" }).click()
  await page.getByText("灵件和插件是什么关系？", { exact: true }).click()
  await page.getByText("插件是安装包", { exact: false }).waitFor()
  await page.getByText("高级：手动管理任务方案", { exact: true }).click()
  await page.getByRole("button", { name: "打开任务方案编辑器", exact: true }).click()
  assert.deepEqual(await page.evaluate("window.fixtureNavigation"), [true, "flows"])
  assert.deepEqual(await page.evaluate("window.fixture.calls()"), [])
  pass(
    "password-free settings keep guidance readable; copying never executes, failure is recoverable, and flow navigation is explicit"
  )
  if (process.env.MODS_UX_SCREENSHOTS === "1") {
    const assets = join(root, "out/renderer/assets")
    const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))!
    await page.addStyleTag({ path: join(assets, css) })
    const output = join(root, "output/mods-ux")
    mkdirSync(output, { recursive: true })
    await page.getByRole("tab", { name: "快速上手" }).click()
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.screenshot({ path: join(output, "guide-light.png"), fullPage: true })
    await page.evaluate("window.fixture.dark()")
    await page.setViewportSize({ width: 420, height: 900 })
    await page.screenshot({ path: join(output, "guide-dark-narrow.png"), fullPage: true })
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  }
}

async function main() {
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
    headless: true
  })
  try {
    for (const verify of [
      (page: Page) => verifyPolicyUsability(page, pass),
      verifyOuterPanel,
      verifyCompatibilityCheck,
      verifyReaders,
      verifyPeerMessages,
      verifyChatScope,
      verifyDisabledJobHistory,
      verifyDisabledCommandSubmission,
      verifyUsageGuide
    ]) {
      const page = await browser.newPage()
      await page.route("http://localhost/mods-review", route => route.fulfill({contentType:"text/html",body:"<div id=\"root\"></div>"}))
      await page.goto("http://localhost/mods-review")
      page.on("pageerror", (error) => console.error("Browser error:", error))
      page.setDefaultTimeout(10000)
      await verify(page)
      await page.close()
    }
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
