/** Real React/DOM Markdown publication with controlled IPC; not a native permission proof. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium, type Page } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

const initialText = "**Report** [named][report] and <https://example.test/auto?q=1&x=2>\n\n" +
  "[entity](https://example.test/a?one=1&amp;two=2) " +
  "[encoded](https://example.test/a%20b) [file](file:///C:/workspace/report.md)\n\n" +
  "[report]: https://example.test/report\n\n" +
  "<context>visible</context><script>window.MARKDOWN_SCRIPT_RAN=true</script>\n\n" +
  "![image label](https://example.test/image.png) [unsafe](javascript:alert(1))\n\n" +
  "| Name | Value |\n| --- | --- |\n| Report | Done |\n\n```ts\nconst value = 1\n```"

async function fixture(page: Page, scenario = "pane", firstPreviewHeld = false) {
  await mount(page, `
    import {Suspense,startTransition} from "react";
    import {Element} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionPanes.tsx"))};
    import {FunctionClient} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionClient.tsx"))};
    import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
    import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
    import {ProtectedFunctionPreview} from ${JSON.stringify(resolve("src/renderer/src/components/panels/ProtectedFunctionPreview.tsx"))};
    import {useProtectedFunctionPreview} from ${JSON.stringify(resolve("src/renderer/src/lib/use-protected-function-preview.ts"))};
    import {emitProtectedFunctionPreview,closeProtectedFunctionPreviewOwner} from ${JSON.stringify(resolve("src/renderer/src/lib/protected-function-preview.ts"))};
    import {parseFunctionMarkdown} from ${JSON.stringify(resolve("src/shared/mods/v2/markdown.ts"))};
    {
    const scenario=${JSON.stringify(scenario)},calls=[],invalidated=new Set(),cards=new Set(),configuration=new Set();
    const heldLinks=[],heldPreviews=[],observed=[];
    let holdLink=false,holdPreview=${JSON.stringify(firstPreviewHeld)},nullPreview=false,syncFailure=false;
    let retainClosed=false,ready=false,holdSite=false,releaseSite;
    let suspendedCandidates=0;
    const neverCommit=new Promise(()=>{});
    function SuspendCandidate({enabled}){
      if(enabled){suspendedCandidates++;throw neverCommit}
      return null;
    }
    const paneAddress=generation=>({kind:'pane',pane:'actual-pane',generation});
    const clientAddress=generation=>({kind:'client',pane:'parent-pane',instance:'actual-client',generation});
    const siteAddress=generation=>({kind:'site',owner:'actual-site-owner',pane:'actual-site-pane',generation});
    const rootNode=document.getElementById('root');
    const observer=new MutationObserver(records=>{
      for(const value of [rootNode.textContent,...records.map(row=>row.oldValue)])
        if(typeof value==='string'&&value.includes('RAW_EVENT'))observed.push(value);
    });
    observer.observe(rootNode,{subtree:true,childList:true,characterData:true,characterDataOldValue:true});
    const preview=receipt=>({receipt,title:'Protected report',text:'SAFE_NATIVE_SNAPSHOT '+receipt});
    let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
    window.api.workspace={readFile:async()=>{calls.push(['FORBIDDEN_RAW_FILE_READ']);throw Error('No raw reader')}};
    window.api.mods.markdownLink=(threadId,action)=>{
      if(syncFailure){syncFailure=false;throw Error('synchronous native bridge unavailable')}
      calls.push(['link',threadId,structuredClone(action)]);
      if(holdLink){holdLink=false;return new Promise(resolve=>heldLinks.push(resolve))}
      return Promise.resolve({state:'handled'});
    };
    window.api.mods.markdownPreview=async(threadId,receipt)=>{
      calls.push(['preview',threadId,receipt]);
      const value=nullPreview?null:preview(receipt);
      if(holdPreview){holdPreview=false;return new Promise(resolve=>heldPreviews.push(()=>resolve(value)))}
      return value;
    };
    window.api.mods.markdownPreviewClose=async(threadId,receipt)=>{calls.push(['preview-close',threadId,receipt])};
    window.api.mods.onMarkdownPreviewInvalidated=fn=>{invalidated.add(fn);return()=>invalidated.delete(fn)};
    window.api.mods.clientAct=async(threadId,action)=>{calls.push(['client',threadId,structuredClone(action)]);return {}};
    window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
    window.api.mods.onConfigurationChanged=fn=>{configuration.add(fn);return()=>configuration.delete(fn)};
    window.api.mods.feedback=async()=>[];
    window.api.mods.siteMountOutcome=async()=>({state:'mounted',owner:'actual-site-owner'});
    window.api.mods.siteRender=async()=>{if(holdSite){holdSite=false;await new Promise(r=>releaseSite=r)}return ({key:'actual-site-pane',id:'actual-site-owner',plugin:'Q',title:'site',
      generation:'site-g1',rows:8,closeOnEscape:false,tree:{type:'Box',props:{},children:[
        {type:'Markdown',props:{text:'[site](https://example.test/site)'}}]},
      markdownLinks:[{nodePath:[0],nonce:'actual-site-nonce'}],
      nativeContent:{component:'AbovePrompt',entries:[{ref:0,props:{}}],nativeUnchanged:false}})};
    window.api.mods.siteUnmount=async(threadId,owner)=>{calls.push(['site-unmount',threadId,owner])};
    window.api.mods.siteAct=async()=>({});
    function Fixture(){
      const [text,setText]=useState(${JSON.stringify(initialText)}),[generation,setGeneration]=useState('g1'),
        [withReceipt,setReceipt]=useState(true),[visible,setVisible]=useState(true),[thread,setThread]=useState('thread');
      const [revision,setRevision]=useState(0),[working,setWorking]=useState(false);
      const [candidate,setCandidate]=useState(false);
      const protectedPreview=useProtectedFunctionPreview(thread, true,
        ()=>calls.push(['preview-request',revision]));
      const renderGeneration=candidate?'abandoned-g2':generation;
      const address=scenario==='client'?clientAddress(renderGeneration):paneAddress(renderGeneration);
      const tree={type:'fragment',children:[{type:'Box',props:{},children:[
        'before ',{type:'fragment',children:[{type:'Markdown',props:{text}}]},
        {type:'Button',props:{key:'old-button',label:'Original button'},press:{plugin:'Q',handle:7}}]}]};
      const links=withReceipt?[{nodePath:[0,1,0],nonce:'actual-pane-nonce'}]:[{nodePath:[1],nonce:'different-leaf'}];
      window.markdownFixture={working:setWorking,holdSite:()=>holdSite=true,releaseSite:()=>releaseSite?.(),hidden:value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))},
        revoke:()=>{for(const fn of cards)fn({threadId:thread})},calls,observed,ready:()=>ready,expected:()=>parseFunctionMarkdown(text).hrefs,
        text:setText,generation:setGeneration,receipt:setReceipt,visible:setVisible,thread:setThread,
        rerender:()=>setRevision(value=>value+1),
        suspendCandidate:()=>startTransition(()=>setCandidate(true)),
        suspendedCandidates:()=>suspendedCandidates,
        discardCandidate:()=>setCandidate(false),
        failSynchronously:()=>syncFailure=true,
        releaseHandled:()=>{for(const resolve of heldLinks.splice(0))resolve({state:"handled"})},
        holdLink:()=>holdLink=true,releaseLink:()=>{for(const resolve of heldLinks.splice(0))resolve({
          state:'preview',preview:{receipt:'stale-link',title:'RAW_EVENT_TITLE',text:'RAW_EVENT_TEXT'}})},
        releaseLinkOne:receipt=>{const resolve=heldLinks.shift();if(resolve)resolve({state:'preview',
          preview:{receipt,title:'RAW_EVENT_TITLE',text:'RAW_EVENT_TEXT'}})},
        holdPreview:()=>holdPreview=true,nullPreview:()=>nullPreview=true,
        releasePreview:()=>{for(const resolve of heldPreviews.splice(0))resolve()},
        held:()=>({links:heldLinks.length,previews:heldPreviews.length}),
        retainClosed:()=>retainClosed=true,
        open:receipt=>emitProtectedFunctionPreview({threadId:thread,address,preview:{receipt,
          title:'RAW_EVENT_TITLE',text:'RAW_EVENT_TEXT'}}),
        invalidate:receipt=>{for(const fn of invalidated)fn({threadId:thread,receipt})},
        closeOwner:()=>closeProtectedFunctionPreviewOwner(thread,address),
        unmount:()=>host.render(null)};
      // This effect runs after this component's actual preview subscription effect.
      // addScriptTag/host.render alone is not a receipt that listeners are installed.
      useEffect(()=>{ready=true;return()=>{ready=false}},[]);
      const act=async(node,kind)=>{calls.push(['old-act',node?.props?.key,kind])};
      return <main style={{padding:24,width:850}}>
        <textarea aria-label='Ordinary composer'/>
        {visible&&<Suspense fallback={<p>Uncommitted candidate</p>}>
          {(scenario==='site'?<ModsChatScope.Provider value={{threadId:thread,enabled:true,ready:true}}>
          <FunctionSite threadId={thread} component='AbovePrompt' facts={{isWorking:working}} renderNative={()=>null} fallback={<p>Raw fallback</p>}/>
        </ModsChatScope.Provider>:scenario==='client'?<FunctionClient threadId={thread} pane='parent-pane'
          node={{type:'Client',props:{key:'client',module:'client.tsx'},client:{plugin:'Q'}}}
          snapshot={{id:'actual-client',generation,plugin:'Q',element:'client',module:'client.tsx',
            tree:{type:'Box',props:{},children:[{type:'Markdown',props:{text:'Plain client text [client](https://example.test/client)'}},
              {type:'Button',props:{key:'old-client-button',label:'Original client button'},press:{plugin:'Q',handle:8}}]},
            markdownLinks:[{nodePath:[0],nonce:'actual-client-nonce'}]}}
          refresh={()=>calls.push(['client-refresh'])}
          render={(node,busy,clientAct,markdown)=><Element node={node} busy={busy} act={clientAct} markdown={markdown}/>}/>
          :<Element node={tree} busy={false} act={act} markdown={{threadId:thread,address,links,
            refresh:()=>calls.push(['refresh'])}}/>)}
          <SuspendCandidate enabled={candidate}/>
        </Suspense>}
        {protectedPreview.request&&<ProtectedFunctionPreview key={thread+':'+protectedPreview.request.preview.receipt}
          request={protectedPreview.request} onClose={()=>{calls.push(['closed']);if(!retainClosed)protectedPreview.clear()}}/>}
      </main>;
    }
    host.render(<Fixture/>);
    }
  `, [browserWorkerPlugin()])
  await page.waitForFunction("window.markdownFixture?.ready()===true")
}

const settle = (page: Page) => page.evaluate(
  () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
)
const linkCalls = (page: Page) => page.evaluate(
  "window.markdownFixture.calls.filter(row=>row[0]==='link')"
)

async function main() {
  mkdirSync(resolve("output"), { recursive: true })
  const output = mkdtempSync(resolve("output/mods-markdown-browser-"))
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }) })
  const page = await browser.newPage({ viewport: { width: 1150, height: 900 } })
  const errors: string[] = [], checks: string[] = [], requests: string[] = []
  let failure = ""
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => requests.push(request.url()))
  const pass = (label: string) => { checks.push(label); console.log("PASS " + label) }
  try {
    await fixture(page)
    await page.getByRole("link", { name: "named", exact: true }).waitFor()
    assert.deepEqual(await page.locator("[data-function-markdown] a").evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute("href"))),
      await page.evaluate("window.markdownFixture.expected()"))
    pass("actual Markdown DOM hrefs equal the shared final HAST for reference, entity, encoded, GFM and file links")
    assert.equal(await page.locator("#root img, #root script, #root iframe").count(), 0)
    assert.equal(await page.evaluate("Boolean(window.MARKDOWN_SCRIPT_RAN)"), false)
    assert((await page.locator("#root").innerText()).includes("<context>visible</context>"))
    assert.equal(await page.locator(".streaming-markdown-table-wrap").count(), 1)
    assert.equal(await page.locator(".streaming-markdown-code-block").count(), 1)
    assert.equal(requests.some((url) => url.includes("example.test")), false)
    pass("raw HTML remains literal, images never fetch, and original code/table formatting remains usable")

    const named = page.getByRole("link", { name: "named", exact: true })
    await named.click()
    await page.waitForFunction("window.markdownFixture.calls.filter(row=>row[0]==='refresh').length===1")
    let actions = await linkCalls(page)
    assert.equal(actions.length, 1)
    assert.deepEqual(actions[0][2].address, { kind: "pane", pane: "actual-pane", generation: "g1" })
    assert.equal(actions[0][2].nonce, "actual-pane-nonce")
    assert.equal(actions[0][2].href, "https://example.test/report")
    assert.equal(typeof actions[0][2].intentId, "string")
    assert.match(actions[0][2].intentId, /^claw_[a-f0-9]{32}$/)
    await named.focus()
    await named.press("Enter")
    await page.waitForFunction("window.markdownFixture.calls.filter(row=>row[0]==='link').length===2")
    actions = await linkCalls(page)
    assert.notEqual(actions[0][2].intentId, actions[1][2].intentId)
    await page.getByRole("button", { name: "Original button", exact: true }).click()
    assert.deepEqual(await page.evaluate("window.markdownFixture.calls.filter(row=>row[0]==='old-act')"),
      [["old-act", "old-button", "press"]])
    pass("nested real tree paths send the exact native sidecar once for click and keyboard while preserving old Button actions")

    await page.evaluate("window.markdownFixture.failSynchronously()")
    await named.click()
    await page.getByRole("alert").waitFor()
    assert.equal((await linkCalls(page)).length, 2)
    await named.click()
    await page.waitForFunction("window.markdownFixture.calls.filter(row=>row[0]==='link').length===3")
    await page.getByRole("alert").waitFor({ state: "hidden" })
    assert.equal(await page.getByRole("alert").count(), 0)
    pass("a synchronous bridge failure is caught and releases only its own pending action so actual clicking again stays usable")

    await named.click({ modifiers: ["Control"] })
    await named.dispatchEvent("click", { detail: 2 })
    await named.dispatchEvent("auxclick", { button: 1 })
    await page.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector("[data-function-markdown] strong")!)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    await named.dispatchEvent("click", { detail: 1 })
    await settle(page)
    assert.equal((await linkCalls(page)).length, 3)
    await page.evaluate("window.getSelection().removeAllRanges();window.markdownFixture.receipt(false)")
    await page.waitForFunction("document.querySelectorAll('[data-function-markdown] a').length===0")
    assert((await page.locator("#root").innerText()).includes("Report"))
    pass("modified, repeated and selected-text clicks do not bypass native actions; absent matching leaf receipts leave formatted text inert")

    await page.evaluate("window.markdownFixture.receipt(true);window.markdownFixture.holdLink()")
    await named.waitFor()
    await named.click()
    await page.waitForFunction("window.markdownFixture.held().links===1")
    await page.evaluate("window.markdownFixture.text('[new](https://example.test/new)');window.markdownFixture.generation('g2')")
    const currentLink = page.getByRole("link", { name: "new", exact: true })
    await currentLink.waitFor()
    await page.evaluate("window.markdownFixture.holdLink()")
    await currentLink.click()
    await page.waitForFunction("window.markdownFixture.held().links===2")
    await page.evaluate("window.markdownFixture.releaseLinkOne('old-linked')")
    await settle(page)
    assert.equal(await page.locator("[data-function-protected-preview]").count(), 0)
    await currentLink.dispatchEvent("click", { detail: 1 })
    await settle(page)
    assert.equal((await linkCalls(page)).length, 5)
    assert.deepEqual(await page.evaluate("window.markdownFixture.observed"), [])
    await page.evaluate("window.markdownFixture.releaseLinkOne('current-linked')")
    await page.getByText("SAFE_NATIVE_SNAPSHOT current-linked", { exact: true }).waitFor()
    pass("old drawing actions cannot block the current frame, open stale previews or release another frame's pending action")
    await page.evaluate("window.markdownFixture.unmount()")

    await fixture(page)
    await page.evaluate("window.markdownFixture.holdLink()")
    await page.getByRole("link", { name: "named", exact: true }).click()
    await page.waitForFunction("window.markdownFixture.held().links===1")
    await page.evaluate("window.markdownFixture.suspendCandidate()")
    await page.waitForFunction("window.markdownFixture.suspendedCandidates()>0")
    assert.equal(await page.getByText("Uncommitted candidate", { exact: true }).count(), 0)
    assert(await page.getByRole("link", { name: "named", exact: true }).isVisible())
    await page.evaluate("window.markdownFixture.releaseLinkOne('committed-frame')")
    await page.getByText("SAFE_NATIVE_SNAPSHOT committed-frame", { exact: true })
      .waitFor({ timeout: 4000 })
    assert.deepEqual((await linkCalls(page))[0][2].address,
      { kind: "pane", pane: "actual-pane", generation: "g1" })
    await page.evaluate("window.markdownFixture.discardCandidate();window.markdownFixture.rerender()")
    await settle(page)
    assert(await page.getByText("SAFE_NATIVE_SNAPSHOT committed-frame", { exact: true }).isVisible())
    assert.deepEqual(await page.evaluate("window.markdownFixture.observed"), [])
    pass("a truly suspended uncommitted React frame cannot retire the current drawing or discard its actual pending reply")
    await page.evaluate("window.markdownFixture.unmount()")

    await fixture(page)
    await page.evaluate("window.markdownFixture.failSynchronously()")
    await page.getByRole("link", { name: "named", exact: true }).click()
    await page.getByRole("alert").waitFor()
    assert.equal((await linkCalls(page)).length, 0)
    await page.evaluate("window.markdownFixture.generation('error-g2')")
    await page.getByRole("alert").waitFor({ state: "hidden" })
    await page.getByRole("link", { name: "named", exact: true }).click()
    await page.waitForFunction("window.markdownFixture.calls.filter(row=>row[0]==='refresh').length===1")
    assert.equal((await linkCalls(page)).length, 1)
    assert.equal((await linkCalls(page))[0][2].address.generation, "error-g2")
    assert.equal(await page.getByRole("alert").count(), 0)
    pass("a real synchronous bridge failure stays on its original frame; a fresh committed frame hides it and invokes exactly once")
    await page.evaluate("window.markdownFixture.unmount()")

    await fixture(page)
    await page.evaluate("window.markdownFixture.holdLink()")
    await page.getByRole("link").first().click()
    await page.waitForFunction("window.markdownFixture.held().links===1")
    await page.evaluate("window.markdownFixture.hidden(true);window.markdownFixture.releaseHandled()")
    await settle(page)
    assert.equal(await page.evaluate("window.markdownFixture.calls.filter(row=>row[0]==='refresh').length"), 0)
    await page.evaluate("window.markdownFixture.hidden(false)")
    await page.waitForFunction("window.markdownFixture.calls.filter(row=>row[0]==='refresh').length===1")
    assert.equal((await linkCalls(page)).length, 1)
    await page.evaluate("window.markdownFixture.unmount()")
    pass("hidden handled Markdown action defers one read until visible and never replays the action")
    await fixture(page, "site")
    await page.getByRole("link", { name: "site", exact: true }).waitFor()
    await page.evaluate("window.markdownFixture.holdSite();window.markdownFixture.working(true)")
    await page.waitForFunction("document.querySelector('[data-function-site] [inert]')!==null")
    assert.equal(await page.getByRole("link", { name: "site", exact: true }).getAttribute("aria-disabled"), "true")
    await page.getByRole("link", { name: "site", exact: true }).dispatchEvent("click")
    assert.equal((await linkCalls(page)).length, 0)
    await page.evaluate("window.markdownFixture.releaseSite()")
    await page.waitForFunction("document.querySelector('[data-function-site] [inert]')===null")
    pass("retained working progress marks Markdown links disabled and rejects cached dispatches")
    await page.evaluate("window.markdownFixture.hidden(true);document.querySelector('[data-function-site] a').click()")
    await settle(page)
    assert.equal((await linkCalls(page)).length, 0)
    assert(await page.getByRole("link", { name: "site", exact: true }).isVisible())
    await page.evaluate("window.markdownFixture.hidden(false)")
    await page.evaluate("const link=document.querySelector('[data-function-site] a');window.markdownFixture.revoke();link.click()")
    await settle(page)
    assert.equal((await linkCalls(page)).length, 0)
    pass("retained hidden links and synchronously revoked cached links cannot call native Markdown actions")
    await page.getByRole("link", { name: "site", exact: true }).click()
    actions = await linkCalls(page)
    assert.equal(actions.length, 1)
    assert.deepEqual(actions[0][2].address, { kind: "site", owner: "actual-site-owner",
      pane: "actual-site-pane", generation: "site-g1" })
    assert.equal(actions[0][2].nonce, "actual-site-nonce")
    await page.evaluate("window.markdownFixture.holdLink()")
    await page.getByRole("link", { name: "site", exact: true }).click()
    await page.waitForFunction("window.markdownFixture.held().links===1")
    await page.evaluate("window.markdownFixture.hidden(true);window.markdownFixture.releaseLink()")
    await settle(page)
    assert.equal(await page.evaluate("window.markdownFixture.calls.filter(row=>row[0]==='preview').length"), 0)
    assert.equal(await page.locator("[data-function-protected-preview]").count(), 0)
    await page.evaluate("window.markdownFixture.hidden(false)")
    pass("a link completion received while hidden cannot publish a protected preview")
    await page.evaluate("window.markdownFixture.unmount()")
    await page.waitForFunction("window.markdownFixture.calls.some(row=>row[0]==='site-unmount')")
    pass("actual FunctionSite mount supplies the native owner and publication path and closes its real lifecycle")

    await fixture(page, "client")
    await page.getByRole("link", { name: "client", exact: true }).click()
    actions = await linkCalls(page)
    assert.equal(actions.length, 1)
    assert.deepEqual(actions[0][2].address, { kind: "client", pane: "parent-pane",
      instance: "actual-client", generation: "g1" })
    assert.equal(actions[0][2].nonce, "actual-client-nonce")
    await page.getByRole("button", { name: "Original client button", exact: true }).click()
    await page.waitForFunction("window.markdownFixture.calls.some(row=>row[0]==='client'&&row[2].kind==='press')")
    // A real browser pointer acquires its actual capture ID; a synthetic event cannot prove it.
    await page.locator("[data-function-markdown] p").click({ position: { x: 5, y: 8 } })
    await page.waitForFunction("window.markdownFixture.calls.some(row=>row[0]==='client'&&row[2].kind==='pointer')")
    const clientActions: Array<[string, string, { kind: string; handle?: number }]> =
      await page.evaluate("window.markdownFixture.calls.filter(row=>row[0]==='client')")
    assert.equal(clientActions.filter((row) => row[2].kind === "press").length, 1)
    const press = clientActions.find((row) => row[2].kind === "press")
    assert(press)
    assert.equal(press[2].handle, 8)
    pass("Client Markdown uses its independent root receipt while existing native pointer and Button routes remain intact")
    await page.evaluate("window.markdownFixture.unmount()")

    await fixture(page, "pane", true)
    await page.evaluate("window.markdownFixture.open('protected-one')")
    await page.waitForFunction("window.markdownFixture.held().previews===1")
    assert.equal(await page.locator("[data-function-protected-preview-content]").count(), 0)
    assert.deepEqual(await page.evaluate("window.markdownFixture.observed"), [])
    await page.evaluate("window.markdownFixture.releasePreview()")
    await page.getByText("SAFE_NATIVE_SNAPSHOT protected-one", { exact: true }).waitFor()
    await page.evaluate("window.markdownFixture.rerender()")
    await settle(page)
    assert(await page.getByText("SAFE_NATIVE_SNAPSHOT protected-one", { exact: true }).isVisible())
    await page.screenshot({ path: resolve(output, "protected-native-snapshot.png") })
    pass("protected preview waits for the actual receipt snapshot and never displays event-provided raw text or title")
    await page.evaluate("window.markdownFixture.retainClosed();window.markdownFixture.holdPreview()")
    await page.waitForFunction("window.markdownFixture.held().previews===1")
    await page.evaluate("window.markdownFixture.invalidate('protected-one')")
    await page.waitForFunction("document.querySelectorAll('[data-function-protected-preview-content]').length===0")
    await page.evaluate("window.markdownFixture.releasePreview()")
    await settle(page)
    assert.equal(await page.locator("[data-function-protected-preview-content]").count(), 0)
    assert.deepEqual(await page.evaluate("window.markdownFixture.observed"), [])
    pass("native invalidation clears the displayed snapshot immediately and a held poll cannot revive it")
    await page.evaluate("window.markdownFixture.unmount()")

    await fixture(page)
    await page.evaluate("window.markdownFixture.open('protected-two')")
    await page.getByText("SAFE_NATIVE_SNAPSHOT protected-two", { exact: true }).waitFor()
    await page.evaluate("window.markdownFixture.nullPreview()")
    await page.waitForFunction("document.querySelectorAll('[data-function-protected-preview]').length===0")
    await page.waitForFunction("window.markdownFixture.calls.some(row=>row[0]==='preview-close'&&row[2]==='protected-two')")
    pass("a null native keepalive closes the preview and releases the exact native receipt")
    await page.evaluate("window.markdownFixture.unmount()")

    await fixture(page)
    await page.evaluate("window.markdownFixture.open('protected-three')")
    await page.getByText("SAFE_NATIVE_SNAPSHOT protected-three", { exact: true }).waitFor()
    await page.evaluate("window.markdownFixture.closeOwner()")
    await page.waitForFunction("document.querySelectorAll('[data-function-protected-preview]').length===0")
    await page.evaluate("window.markdownFixture.open('protected-four')")
    await page.getByText("SAFE_NATIVE_SNAPSHOT protected-four", { exact: true }).waitFor()
    await page.evaluate("window.markdownFixture.thread('different-thread')")
    await page.waitForFunction("document.querySelectorAll('[data-function-protected-preview]').length===0")
    assert.equal(await page.evaluate("window.markdownFixture.calls.some(row=>row[0]==='FORBIDDEN_RAW_FILE_READ')"), false)
    assert.deepEqual(await page.evaluate("window.markdownFixture.observed"), [])
    pass("source closure and thread switches clear protected previews without falling back to raw workspace reads")
    await page.evaluate("window.markdownFixture.unmount()")
    assert.deepEqual(errors, [])
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
    await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => {})
    throw error
  } finally {
    const actual = await page.evaluate("({calls:window.markdownFixture?.calls," +
      "held:window.markdownFixture?.held(),ready:window.markdownFixture?.ready?.()," +
      "visiblePreviews:document.querySelectorAll('[data-function-protected-preview]').length})")
      .catch(() => null)
    writeFileSync(resolve(output, "report.json"), JSON.stringify({
      complete: !failure, checks, errors, requests, failure, actual,
      scope: "Real React DOM, renderer publication paths and controlled IPC lifecycle. " +
        "Does not prove native file authorization, source permissions, VM callback ownership or OS opening."
    }, null, 2))
    console.log("EVIDENCE " + output)
    await browser.close()
  }
}

if (process.argv[1]?.includes("mods-markdown-browser")) {
  void main().catch((error) => { console.error(error); process.exitCode = 1 })
}
