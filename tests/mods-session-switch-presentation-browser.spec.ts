/** Real keyed React remounts, fresh host decisions and delayed protected message reads. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage(),
    errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const evidence: unknown[] = []
  try {
    await mount(
      page,
      `
      import {ModsChatScope,useModsChatState} from './src/renderer/src/lib/mods-chat-scope';
      import {FunctionMessageText} from './src/renderer/src/components/chat/FunctionMessageText';
      {const events=new Map(),calls=[],decisions=[],reads=[],oldScopes=[],raw=[];
      let hold=false,capabilityHold=false,capability=true,allowNative=false;
      const subscribe=name=>listener=>{const set=events.get(name)||new Set();events.set(name,set);
        set.add(listener);return()=>set.delete(listener)};
      window.api.mods.onCardsChanged=subscribe('cards');
      window.api.mods.onConfigurationChanged=subscribe('config');
      window.api.threads={...window.api.threads,onThreadsChanged:subscribe('threads')};
      window.api.models={...window.api.models,onUserInfoChanged:subscribe('account')};
      window.api.mods.chatDisplayCapability=async thread=>{
        calls.push(['capability',thread]);if(capabilityHold)await new Promise(done=>decisions.push(done));return capability};
      window.api.mods.siteRead=async(thread,component,props,id)=>{
        calls.push(['read',thread]);if(hold)await new Promise(done=>reads.push(done));
        return {state:'projected',snapshot:{scopeId:'scope-'+thread,key:'host-'+thread,
          version:'v1',expiresAt:Date.now()+120000,data:{component,hostMessage:{...props,text:'SAFE '+thread}}}}};
      new MutationObserver(records=>{for(const record of records)if(!allowNative&&[record.target,...record.addedNodes]
        .some(node=>node.textContent?.includes('UNVERIFIED')))raw.push(true)})
        .observe(document.getElementById('root'),{subtree:true,childList:true,characterData:true});
      function Chat({thread,workspace,text}){const state=useModsChatState(thread,workspace);
        if(state.ready)oldScopes.push(state.isCurrent);
        return <ModsChatScope.Provider value={{threadId:thread,...state}}>
          <FunctionMessageText threadId={thread} messageId='message' role='assistant'
            text={text} isExpanded isFirstOfReply fallback={<p>UNVERIFIED</p>}
            renderText={safe=><div style={{height:240,width:600}}>{safe}</div>}/>
        </ModsChatScope.Provider>}
      function Fixture(){const [thread,setThread]=useState('A'),[workspace,setWorkspace]=useState('workspace'),[text,setText]=useState('UNVERIFIED');
        window.switching={calls,raw,oldScopes,go:setThread,workspace:setWorkspace,text:setText,
          capability:value=>{capability=value;allowNative=!value},
          hold:()=>{hold=true;capabilityHold=true},releaseCapability:()=>{capabilityHold=false;decisions.splice(0).forEach(done=>done())},
          releaseReads:()=>{hold=false;reads.splice(0).forEach(done=>done())},pending:()=>({decisions:decisions.length,reads:reads.length}),
          emit:(name,event)=>{for(const fn of [...events.get(name)||[]])fn(event)}};
        return <Chat key={thread} thread={thread} workspace={workspace} text={text}/>}
      host.render(<Fixture/>)}
    `,
      [
        browserWorkerPlugin(),
        ...(process.env.MODS_SWITCH_SCOPE_SOURCE
          ? [
              {
                name: "frozen-switch-scope-baseline",
                setup(builder: import("esbuild").PluginBuild) {
                  builder.onLoad({ filter: /[\\/]mods-chat-scope\.tsx$/ }, () => ({
                    contents: readFileSync(process.env.MODS_SWITCH_SCOPE_SOURCE!, "utf8"),
                    loader: "tsx"
                  }))
                }
              }
            ]
          : [])
      ]
    )
    const call = (script: string) => page.evaluate(script)
    const settle = () =>
      page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
      )
    const safe = (thread: string) => page.getByText(`SAFE ${thread}`, { exact: true })
    await safe("A").waitFor()
    await settle()
    await call("window.switching.go('B')")
    await safe("B").waitFor()
    await settle()
    assert.equal(
      await call("window.switching.oldScopes[0]()"),
      false,
      "Unmounted scope callbacks must stay revoked"
    )
    await call("window.switching.hold();window.switching.go('A')")
    await page.waitForFunction("window.switching.pending().decisions===1")
    assert.equal(await safe("A").count(), 0, "Cached drawings must await a fresh host decision")
    await call("window.switching.releaseCapability()")
    await page.waitForFunction("window.switching.pending().reads===1")
    await settle()
    if (process.env.MODS_SWITCH_SCOPE_SOURCE) {
      assert.equal(await safe("A").count(), 0)
      assert.equal(await page.locator("[data-function-site-pending]").count(), 1)
      assert.deepEqual(await call("window.switching.raw"), [])
      console.log(
        "REPRODUCED original keyed A-B-A discards verified text and remains blank until message IPC returns"
      )
      return
    }
    await safe("A").waitFor({ timeout: 1500 })
    assert.equal(await page.locator("[data-function-site-cached]").count(), 1)
    assert.equal(await page.locator("[data-function-site-pending]").count(), 0)
    assert.equal(await call("window.switching.oldScopes[0]()"), false)
    evidence.push({
      scenario: "A-B-A with held message IPC",
      cachedVisible: true,
      pendingRows: 0,
      oldCallbacksRevoked: true
    })
    await call("window.switching.releaseReads()")
    await page.locator("[data-function-site-projected]").waitFor()
    await settle()

    for (const [name, event] of [
      ["cards", { threadId: "A", scope: "site-presentations:*" }],
      ["cards", { threadId: "A", scope: "source-retiring:1" }],
      ["cards", { threadId: "A", scope: "source-replaced:2" }],
      ["cards", { threadId: "A", scope: "site-projection:host-A" }],
      ["threads", undefined],
      ["account", undefined],
      ["config", undefined]
    ] as const) {
      await call("window.switching.go('B')")
      await safe("B").waitFor()
      await settle()
      await page.evaluate(
        ([eventName, eventValue]) =>
          (
            window as unknown as {
              switching: { emit(name: string, event: unknown): void }
            }
          ).switching.emit(eventName, eventValue),
        [name, event]
      )
      await call("window.switching.hold();window.switching.go('A')")
      await page.waitForFunction("window.switching.pending().decisions===1")
      await call("window.switching.releaseCapability()")
      await page.waitForFunction("window.switching.pending().reads===1")
      await settle()
      assert.equal(await safe("A").count(), 0, `${name} must revoke dormant protected text`)
      assert.equal(await page.locator("[data-function-site-cached]").count(), 0)
      await call("window.switching.releaseReads()")
      await safe("A").waitFor()
      await settle()
      evidence.push({ scenario: `${name} invalidation while absent`, cachedVisible: false })
    }
    for (const workspace of ["other-workspace", "workspace"]) {
      await call(`window.switching.hold();window.switching.workspace(${JSON.stringify(workspace)})`)
      await page.waitForFunction("window.switching.pending().decisions===1")
      await call("window.switching.releaseCapability()")
      await page.waitForFunction("window.switching.pending().reads===1")
      await settle()
      assert.equal(await safe("A").count(), 0, "Directory replacement must discard old drawings")
      await call("window.switching.releaseReads()")
      await safe("A").waitFor()
      await settle()
      evidence.push({ scenario: `directory ${workspace}`, cachedVisible: false })
    }
    await call("window.switching.go('B')")
    await safe("B").waitFor()
    await settle()
    await call("window.switching.text('UNVERIFIED updated body');window.switching.hold();window.switching.go('A')")
    await page.waitForFunction("window.switching.pending().decisions===1")
    await call("window.switching.releaseCapability()")
    await page.waitForFunction("window.switching.pending().reads===1")
    await settle()
    assert.equal(await safe("A").count(), 0, "Changed input must not reuse an older protected body")
    await call("window.switching.releaseReads()")
    await safe("A").waitFor()
    await settle()
    evidence.push({ scenario: "message input changed while absent", cachedVisible: false })

    await call("window.switching.go('B')")
    await safe("B").waitFor()
    await settle()
    await call("window.switching.capability(false);window.switching.go('A')")
    // A real inactive host decision is the sole intentional native fallback in this fixture.
    await page.getByText("UNVERIFIED", { exact: true }).waitFor()
    await settle()
    await call("window.switching.capability(true);window.switching.go('B')")
    await safe("B").waitFor()
    await settle()
    await call("window.switching.hold();window.switching.go('A')")
    await page.waitForFunction("window.switching.pending().decisions===1")
    await call("window.switching.releaseCapability()")
    await page.waitForFunction("window.switching.pending().reads===1")
    await settle()
    assert.equal(await safe("A").count(), 0, "An inactive decision must discard dormant protected content")
    await call("window.switching.releaseReads()")
    await safe("A").waitFor()
    await settle()
    evidence.push({ scenario: "disabled then enabled after fresh decisions", cachedVisible: false })
    assert.deepEqual(await call("window.switching.raw"), [])
    assert.deepEqual(errors, [])
    const output = resolve("output/mods-session-switch-presentation-browser")
    mkdirSync(output, { recursive: true })
    writeFileSync(
      resolve(output, "evidence.json"),
      JSON.stringify({ evidence, errors, calls: await call("window.switching.calls") }, null, 2)
    )
    console.log(
      "PASS real keyed A-B-A keeps verified text after fresh admission; account, configuration, thread and source changes revoke it"
    )
  } finally {
    await page.close()
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
