/** Actual DOM geometry for cold-mount scheduling, including display:contents and scroll clips. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const bundle = await build({
    entryPoints: ["src/renderer/src/lib/function-site-visibility.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "FunctionSiteVisibility"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`<style>body{margin:0}.row{height:24px;width:400px}</style>
      <section id="visible" class="row">visible</section>
      <section id="contents" style="display:contents"><span>visible contents</span></section>
      <section id="offscreen" class="row" style="position:absolute;top:1500px">offscreen</section>
      <div style="position:absolute;top:1600px;height:40px;width:400px">
        <section id="scroll-contents" style="display:contents"><span>scrolling text</span></section>
        <section id="shared-contents" style="display:contents"><span>second text</span></section>
      </div>
      <section style="height:30px;overflow:hidden"><div style="height:100px"></div>
        <section id="clipped" style="display:contents"><span>clipped contents</span></section>
      </section>
      <div style="opacity:0"><section id="transparent" class="row">transparent</section></div>
      <section id="hidden" class="row" style="visibility:hidden">hidden</section>
      <div id="transcript" data-radix-scroll-area-viewport style="height:100px;overflow:auto">
        <div id="transcript-presentation">
        <div style="height:400px"></div>
        <div id="transcript-row" data-chat-message-row style="height:50px">
          <section id="transcript-site" style="display:contents">protected transcript</section>
          <section id="transcript-companion" style="display:contents">another site</section>
        </div>
        </div>
      </div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(() => {
      const api = (
        window as unknown as {
          FunctionSiteVisibility: {
            isFunctionSiteInViewport(element: HTMLElement | null): boolean
          }
        }
      ).FunctionSiteVisibility
      return ["visible", "contents", "offscreen", "clipped", "transparent", "hidden"].map((id) => [
        id,
        api.isFunctionSiteInViewport(document.getElementById(id))
      ])
    })
    assert.deepEqual(result, [
      ["visible", true],
      ["contents", true],
      ["offscreen", false],
      ["clipped", false],
      ["transparent", false],
      ["hidden", false]
    ])
    await page.evaluate(`window.visibilityProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
      document.getElementById('offscreen'))`)
    assert.equal(await page.evaluate("window.visibilityProbe.visible()"), false)
    await page.evaluate(`window.contentsProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
      document.getElementById('scroll-contents'));
      window.sharedProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
      document.getElementById('shared-contents'));window.scrollTo(0,0)`)
    await page.waitForFunction("!window.contentsProbe.visible() && !window.sharedProbe.visible()")
    await page.evaluate("window.scrollTo(0,1400)")
    await page.waitForFunction("window.contentsProbe.visible() && window.sharedProbe.visible()")
    await page.evaluate("window.contentsProbe.close();window.scrollTo(0,0)")
    await page.waitForFunction("!window.sharedProbe.visible()")
    await page.evaluate("window.sharedProbe.close()")
    await page.evaluate("window.scrollTo(0, 1200)")
    await page.waitForFunction("window.visibilityProbe.visible()")
    await page.evaluate("window.scrollTo(0, 0)")
    await page.waitForFunction("!window.visibilityProbe.visible()")
    await page.evaluate("window.visibilityProbe.close();window.scrollTo(0,1200)")
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    assert.equal(await page.evaluate("window.visibilityProbe.visible()"), false)
    await page.evaluate(`window.scrollTo(0,0);window.transcriptVisibilityChanges=0;window.transcriptProbe =
      FunctionSiteVisibility.observeFunctionSiteVisibility(document.getElementById('transcript-site'),
        () => { window.transcriptVisibilityChanges++ })`)
    assert.equal(await page.evaluate("window.transcriptProbe.visible()"), false)
    // Scroll restoration can still be settling while the user scrolls. Newly visible
    // messages must be promoted in the read queue during that window too.
    await page.locator("#transcript-presentation").evaluate(node =>
      node.setAttribute("data-chat-initial-presentation", "pending"))
    await page.evaluate("document.getElementById('transcript').scrollTop=400")
    await page.waitForFunction("window.transcriptProbe.visible()")
    assert.equal(await page.evaluate("window.transcriptVisibilityChanges"), 1)
    await page.evaluate("document.getElementById('transcript').scrollTop=0")
    await page.waitForFunction("!window.transcriptProbe.visible()")
    assert.equal(await page.evaluate("window.transcriptVisibilityChanges"), 2)
    await page.evaluate("window.transcriptProbe.close()")
    await page.evaluate("document.getElementById('transcript').scrollTop=400")
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    assert.equal(await page.evaluate("window.transcriptVisibilityChanges"), 2)
    await page.evaluate(`
      const presentation = document.getElementById('transcript-presentation');
      presentation.style.visibility = 'hidden';
      window.hiddenProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
        document.getElementById('transcript-site'));
      window.hiddenProbeAtMount = window.hiddenProbe.visible();
      const nativeObserver = new IntersectionObserver(([entry]) => {
        window.hiddenProbeIntersects = entry.isIntersecting && entry.intersectionRatio > 0;
        nativeObserver.disconnect();
      });
      nativeObserver.observe(document.getElementById('transcript-row'));
    `)
    await page.waitForFunction("window.hiddenProbeIntersects===true")
    assert.equal(await page.evaluate("window.hiddenProbeAtMount"), false, "Hidden probe has no cold visible priority")
    assert.equal(await page.evaluate("window.hiddenProbe.visible()"), false, "Geometry IO must not promote a hidden probe")
    await page.evaluate("document.getElementById('transcript-presentation').style.visibility = ''")
    await page.waitForFunction("window.hiddenProbe.visible()")
    await page.evaluate("window.hiddenProbe.close()")
    await page.evaluate(`
      const viewport = document.getElementById('transcript');
      document.getElementById('transcript-presentation')
        .setAttribute("data-chat-initial-presentation", "ready");
      let reads = 0;
      for (const node of [viewport, document.getElementById('transcript-row')]) {
        const read = node.getBoundingClientRect.bind(node);
        node.getBoundingClientRect = () => { reads++; return read() };
      }
      window.settledRectReads = () => reads;
      window.settledFirst = FunctionSiteVisibility.observeFunctionSiteVisibility(
        document.getElementById('transcript-site'));
    `)
    await page.waitForFunction("window.settledFirst.visible()")
    assert.equal(await page.evaluate(`
      window.settledSecond = FunctionSiteVisibility.observeFunctionSiteVisibility(
        document.getElementById('transcript-companion'));
      window.settledSecond.visible();
    `), true, "A second site reuses the row's sampled visibility")
    assert.equal(await page.evaluate("window.settledRectReads()"), 0,
      "Settled transcript mounts never force row or viewport geometry")
    await page.evaluate("window.settledFirst.close();document.getElementById('transcript').scrollTop=0")
    await page.waitForFunction("!window.settledSecond.visible()")
    await page.evaluate("window.settledSecond.close()")
    console.log("PASS actual contents/ancestor-clipping/viewport scheduling geometry")

    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await mount(page, `
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {functionSiteQueue} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-queue.ts"))};
      import {observeFunctionSiteVisibility} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-visibility.ts"))};
      const reads=[], renders=[], cancellations=[], releasedOwners=[], owners=new Map(), pending=new Map(), cardListeners=new Set();
      let durationReadSequence=0, admissions=0, probe;
      const originalRun=functionSiteQueue.run;
      functionSiteQueue.run=function(...args){admissions++;return Reflect.apply(originalRun,this,args)};
      window.api.mods.onCardsChanged=fn=>{cardListeners.add(fn);return()=>cardListeners.delete(fn)};
      window.api.mods.onConfigurationChanged=()=>()=>{};
      window.api.mods.nextSiteReadId=()=>String(++durationReadSequence);
      window.api.mods.cancelSiteRead=async id=>{cancellations.push(id)};
      window.api.mods.siteUnmount=async (_thread,owner)=>{releasedOwners.push(owner);owners.delete(owner)};
      const snapshot=(id,component,props,owner)=>({key:owner,id:owner,plugin:"engine",
        generation:owner,title:"label",rows:2,closeOnEscape:false,
        tree:{type:"Text",props:{},children:["SAFE "+id]},
        nativeContent:{component,entries:[{ref:0,props}]}});
      window.api.mods.siteRead=async (_thread,component,props,id,_message,_expected,_ownerRequired,readId)=>{
        reads.push([id,readId]);
        await new Promise(resolve=>pending.set(id,resolve));
        owners.set(readId,{id,component});
        return {state:"mounted",owner:readId,snapshot:snapshot(id,component,props,readId)};
      };
      window.api.mods.siteRender=async (_thread,owner,props,readId)=>{
        const {id,component}=owners.get(owner);
        renders.push([id,owner,readId]);
        await new Promise(resolve=>pending.set(id,resolve));
        return snapshot(id,component,props,owner);
      };
      const row=(id,top,component="TurnDuration")=><div key={id} id={id} data-chat-message-row
        style={{position:"absolute",top,height:32,width:300}}><FunctionSite threadId="duration"
        component={component} presentationId={id} facts={component==="TurnDuration"?{durationMs:100,word:"time"}:{text:"body"}}
        fallback={<span>RAW {id}</span>}/></div>;
      function DurationFixture(){
        const [enabled,setEnabled]=useState(true),[doomed,setDoomed]=useState(true);
        const [lateOnly,setLateOnly]=useState(false);
        window.duration.disable=()=>setEnabled(false);
        window.duration.showLate=()=>{setLateOnly(true);setEnabled(true)};
        window.duration.removeDoomed=()=>setDoomed(false);
        return <ModsChatScope.Provider value={{threadId:"duration",enabled,ready:true,isCurrent:()=>enabled}}>
          <div id="duration-viewport" data-radix-scroll-area-viewport style={{height:120,width:320,overflow:"auto"}}>
            <div style={{height:740,position:"relative"}}>
              {lateOnly?row("late-duration",0):<>
                {row("blocker",0)}{row("queued-duration",40)}{row("deferred-duration",400)}
                {row("ordinary-body",520,"AssistantMessage")}{doomed&&row("doomed-duration",590)}
              </>}
            </div>
          </div>
        </ModsChatScope.Provider>;
      }
      window.duration={reads,renders,cancellations,releasedOwners,admissions:()=>admissions,
        held:id=>pending.has(id),release:id=>{const done=pending.get(id);pending.delete(id);done()},
        scroll:top=>{document.getElementById("duration-viewport").scrollTop=top},
        observeRow:id=>{probe?.close();probe=observeFunctionSiteVisibility(document.getElementById(id).querySelector("section"))},
        observedVisible:()=>probe.visible(),
        hidden:value=>{
          if(value)Object.defineProperty(document,"hidden",{configurable:true,value:true});
          else delete document.hidden;
          document.dispatchEvent(new Event("visibilitychange"));
        },
        invalidate:id=>{
          const owner=reads.filter(read=>read[0]===id).at(-1)[1];
          for(const notify of cardListeners)notify({threadId:"duration",scope:"site-invalidated:"+owner});
        },
        close:()=>{probe?.close();functionSiteQueue.run=originalRun;host.unmount()}
      };
      host.render(<DurationFixture/>);
    `, [browserWorkerPlugin()])
    const reads = () => page.evaluate("window.duration.reads.map(read=>read[0])")
    const durationSite = (id: string, busy?: boolean) => page.locator(
      `#${id} [data-function-site="TurnDuration"]` +
      (busy === undefined ? "" : busy ? '[aria-busy="true"]' : ":not([aria-busy])")
    )
    const assertParked = async (id: string) => {
      const site = durationSite(id, false)
      await site.waitFor({ state: "attached" })
      assert.equal((await site.textContent())?.trim(), "", `No unverified content for ${id}`)
      assert.equal(await site.locator("[data-function-site-pending]").count(), 0,
        `No visual placeholder for ${id}`)
    }
    const assertProtectedIdle = async (id: string) => {
      const site = durationSite(id, false)
      await site.getByText(`SAFE ${id}`, { exact: true }).waitFor({ state: "attached" })
      assert.equal(await site.locator("[data-function-site-pending]").count(), 0)
    }
    const settle = () => page.evaluate(() => new Promise<void>(done =>
      requestAnimationFrame(() => requestAnimationFrame(() => done()))))
    await page.waitForFunction("window.duration.held('blocker') && window.duration.admissions() >= 3")
    assert.equal(await page.evaluate("window.duration.admissions()"), 3,
      "Two visible labels and the ordinary offscreen body reach the queue")
    assert.deepEqual(await reads(), ["blocker"], "The first visible duration reads immediately")
    await durationSite("blocker", true).waitFor({ state: "attached" })
    await durationSite("queued-duration", true).waitFor({ state: "attached" })
    await settle()
    assert.equal(
      await durationSite("deferred-duration").getAttribute("aria-busy"),
      null,
      "A cold offscreen duration is idle until its row enters the viewport"
    )
    await assertParked("deferred-duration")
    await assertParked("doomed-duration")
    await page.evaluate("window.duration.observeRow('queued-duration')")
    assert.equal(await page.evaluate("window.duration.observedVisible()"), true)
    await page.evaluate("window.duration.scroll(200)")
    await page.waitForFunction("!window.duration.observedVisible()")
    await page.evaluate("window.duration.removeDoomed()")
    await page.locator("#doomed-duration").waitFor({ state: "detached" })
    assert.deepEqual(await page.evaluate("window.duration.cancellations"), [])
    assert.deepEqual(await reads(), ["blocker"], "Leaving the viewport retains the started background slot")
    await page.evaluate("window.duration.release('blocker')")
    await page.waitForFunction("window.duration.held('ordinary-body')")
    await assertParked("queued-duration")
    assert.deepEqual(await reads(), ["blocker", "ordinary-body"],
      "The queued duration is rechecked and ordinary offscreen text still reads")
    await page.getByText("SAFE blocker", { exact: true }).waitFor({ state: "attached" })
    await assertProtectedIdle("blocker")
    await page.evaluate("window.duration.release('ordinary-body')")
    await page.getByText("SAFE ordinary-body", { exact: true }).waitFor({ state: "attached" })
    await page.evaluate("window.duration.hidden(true);window.duration.scroll(0)")
    await page.waitForFunction("window.duration.observedVisible()")
    await settle()
    assert.deepEqual(await reads(), ["blocker", "ordinary-body"], "A hidden document keeps the wake pending")
    await page.evaluate("window.duration.hidden(false)")
    await page.waitForFunction("window.duration.held('queued-duration')")
    await durationSite("queued-duration", true).waitFor({ state: "attached" })
    await page.evaluate("window.duration.release('queued-duration')")
    await page.getByText("SAFE queued-duration", { exact: true }).waitFor()
    await assertProtectedIdle("queued-duration")
    await page.evaluate("window.duration.scroll(400)")
    await page.waitForFunction("window.duration.held('deferred-duration')")
    await durationSite("deferred-duration", true).waitFor({ state: "attached" })
    await page.evaluate("window.duration.release('deferred-duration')")
    await page.getByText("SAFE deferred-duration", { exact: true }).waitFor()
    await assertProtectedIdle("deferred-duration")
    assert.deepEqual(await reads(), ["blocker", "ordinary-body", "queued-duration", "deferred-duration"])
    await page.evaluate("window.duration.observeRow('deferred-duration');window.duration.scroll(0)")
    await page.waitForFunction("!window.duration.observedVisible()")
    await page.evaluate("window.duration.invalidate('deferred-duration')")
    await page.waitForFunction("window.duration.held('deferred-duration')")
    await durationSite("deferred-duration", true).waitFor({ state: "attached" })
    const redraw = await page.evaluate("window.duration.renders.at(-1)") as [string, string, string]
    const originalOwner = await page.evaluate("window.duration.reads.at(-1)[1]")
    assert.equal(redraw[0], "deferred-duration")
    assert.equal(redraw[1], originalOwner, "A started offscreen label redraws using its existing owner")
    assert.notEqual(redraw[2], originalOwner)
    assert.deepEqual(await reads(), ["blocker", "ordinary-body", "queued-duration", "deferred-duration"])
    await page.evaluate("window.duration.disable()")
    await page.getByText("RAW blocker", { exact: true }).waitFor()
    await page.waitForFunction("window.duration.cancellations.length===1")
    assert.deepEqual(await page.evaluate("window.duration.cancellations"), [redraw[2]])
    const admissionCount = await page.evaluate("window.duration.admissions()") as number
    await page.evaluate("window.duration.showLate()")
    await page.waitForFunction(`window.duration.admissions()===${admissionCount + 1}`)
    assert.equal(await page.evaluate("window.duration.held('deferred-duration')"), true)
    assert.equal((await reads()).includes("late-duration"), false,
      "The cancelled redraw holds the background slot until its physical response")
    await page.evaluate("window.duration.release('deferred-duration')")
    await page.waitForFunction("window.duration.held('late-duration')")
    const lateRead = await page.evaluate("window.duration.reads.at(-1)[1]") as string
    await page.evaluate("window.duration.disable()")
    await page.getByText("RAW late-duration", { exact: true }).waitFor()
    await page.waitForFunction("window.duration.cancellations.length===2")
    assert.deepEqual(await page.evaluate("window.duration.cancellations"), [redraw[2], lateRead])
    assert.equal(await page.evaluate("window.duration.held('late-duration')"), true)
    assert.equal(await page.evaluate(`window.duration.releasedOwners.includes(${JSON.stringify(lateRead)})`), false)
    await page.evaluate("window.duration.release('late-duration')")
    await page.waitForFunction(id => (window as unknown as { duration: { releasedOwners: string[] } })
      .duration.releasedOwners.includes(id), lateRead)
    assert.deepEqual(await reads(), ["blocker", "ordinary-body", "queued-duration", "deferred-duration", "late-duration"])
    await page.evaluate("window.duration.close()")
    assert.deepEqual(errors, [])
    console.log("PASS initial elapsed-time reads respect real row visibility and preserve physical cancellation")

    await mount(page, `
      import {ChatVirtualPrependLayout} from ${JSON.stringify(resolve("src/renderer/src/components/chat/chat-virtual-prepend-layout.tsx"))};
      import {FunctionSite} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionSite.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {functionSiteQueue} from ${JSON.stringify(resolve("src/renderer/src/lib/function-site-queue.ts"))};
      const reads = [];
      let admissions = 0;
      const run = functionSiteQueue.run;
      functionSiteQueue.run = function (...args) {
        admissions++;
        return Reflect.apply(run, this, args);
      };
      window.api.mods.onCardsChanged = () => () => {};
      window.api.mods.onConfigurationChanged = () => () => {};
      window.api.mods.nextSiteReadId = () => String(reads.length + 1);
      window.api.mods.siteUnmount = async () => {};
      window.api.mods.siteRead = async (_thread, component, props, id, _message, _expected, _owner, readId) => {
        reads.push(id);
        return {state:"mounted",owner:readId,snapshot:{key:readId,id:readId,plugin:"engine",
          generation:readId,title:"probe",rows:2,closeOnEscape:false,
          tree:{type:"Text",props:{},children:["SAFE "+id]},
          nativeContent:{component,entries:[{ref:0,props}]}}};
      };
      const row = (id, top, history=true) => <div key={id} id={id} data-chat-message-row
        style={{position:"absolute",top,height:32,width:300}}><FunctionSite threadId="probe"
        component="AssistantMessage" presentationId={id} facts={{text:"body"}} allowUnboundHistory={history}
        fallback={<span>RAW {id}</span>}/></div>;
      function ProbeFixture() {
        const [phase, setPhase] = useState("hidden");
        window.virtualProbe = { wrongWindow:() => setPhase("wrong"), reveal:() => setPhase("ready"),
          reads, admissions:() => admissions };
        return <ModsChatScope.Provider value={{threadId:"probe",enabled:true,ready:true,
          isCurrent:() => true,prefetchHistory:true}}>
          <div data-radix-scroll-area-viewport style={{height:120,width:320,overflow:"auto"}}>
            <ChatVirtualPrependLayout forwardedRef={null}
              context={{windowKey:"probe",firstItemIndex:0,scrollParent:null,initialHistoryReadPending:phase==="wrong"}}
              style={{position:"relative",height:500,visibility:phase==="hidden" ? "hidden" : undefined}}>
              {phase==="hidden" && row("discarded-probe", 30)}
              {phase==="wrong" && <>{row("wrong-window", 30)}{row("live-row", 65, false)}</>}
              {phase!=="hidden" && row("visible-row", 0)}
              {phase!=="hidden" && row("overscan-row", 400)}
            </ChatVirtualPrependLayout>
          </div>
        </ModsChatScope.Provider>;
      }
      host.render(<ProbeFixture/>);
    `, [browserWorkerPlugin()])
    await page.locator("#discarded-probe [data-function-site-pending]").waitFor({ state: "attached" })
    await settle()
    assert.equal(await page.evaluate("window.virtualProbe.admissions()"), 0,
      "The hidden positioning layer must not use display queue capacity")
    assert.equal(await page.getByText("RAW", { exact: false }).count(), 0)
    await page.evaluate("window.virtualProbe.wrongWindow()")
    await page.getByText("SAFE live-row", { exact: true }).waitFor({ timeout: 5_000 })
    await settle()
    assert.deepEqual(await page.evaluate("window.virtualProbe.reads"), ["live-row"],
      "Even when the temporary historical rows appear visible, they do not dispatch before the true position")
    assert.equal(await page.getByText("RAW", { exact: false }).count(), 0)
    await page.evaluate("window.virtualProbe.reveal()")
    await page.getByText("SAFE visible-row", { exact: true }).waitFor({ timeout: 5_000 })
    await page.getByText("SAFE overscan-row", { exact: true }).waitFor({ state: "attached", timeout: 5_000 })
    assert.deepEqual(
      (await page.evaluate("window.virtualProbe.reads") as string[]).toSorted(),
      ["live-row", "overscan-row", "visible-row"]
    )
    assert.equal(await page.getByText("RAW", { exact: false }).count(), 0)
    assert.deepEqual(errors, [])
    console.log("PASS hidden positioning rows stay out of the display queue and retain fallback protection")

    await mount(page, `
      import {ChatVirtualPrependLayout} from ${JSON.stringify(resolve("src/renderer/src/components/chat/chat-virtual-prepend-layout.tsx"))};
      import {FunctionMessageText} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionMessageText.tsx"))};
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      const reads = [];
      const held = new Map();
      let maxActive = 0;
      window.api.mods.onCardsChanged = () => () => {};
      window.api.mods.onConfigurationChanged = () => () => {};
      window.api.mods.nextSiteReadId = () => String(reads.length + 1);
      window.api.mods.siteUnmount = async () => {};
      window.api.mods.siteRead = async (_thread, component, props, id, _message, _expected, _owner, readId) => {
        reads.push(id);
        await new Promise(resolve => {
          held.set(id, resolve);
          maxActive = Math.max(maxActive, held.size);
        });
        return {state:"mounted",owner:readId,snapshot:{key:readId,id:readId,plugin:"engine",
          generation:readId,title:"tail",rows:2,closeOnEscape:false,
          tree:{type:"Text",props:{},children:["SAFE "+id]},
          nativeContent:{component,entries:[{ref:0,props:{...props,text:"SAFE "+id}}]}}};
      };
      const release = id => {
        const complete = held.get(id);
        held.delete(id);
        complete?.();
      };
      const text = (messageId, block=0) => {
        const id = messageId+":"+block;
        return <FunctionMessageText key={id} threadId="tail" messageId={messageId}
          presentationId={id} isFirstText={block===0} role="assistant" text={"RAW "+id}
          isExpanded={false} isFirstOfReply={false} isHistory fallback={<span>RAW {id}</span>}
          renderText={text => <span>{text}</span>}/>;
      };
      const tail = {messageId:"tail"};
      function TailFixture({phase}) {
        const [position, setPosition] = useState(phase);
        window.initialTail = { reads, release, maxActive:() => maxActive,
          showHiddenProbe:() => setPosition("hidden"),
          startEarly:() => setPosition("early"),
          position:() => setPosition("positioned"), takeover:() => setPosition("takeover"),
          reset:() => { reads.length=0; maxActive=0; host.render(<TailFixture key="takeover" phase="pending"/>); } };
        return <ModsChatScope.Provider value={{threadId:"tail",enabled:true,ready:true,
          isCurrent:() => true,prioritizeInitialHistory:true}}>
          <div data-radix-scroll-area-viewport style={{height:240,width:320,overflow:"auto"}}>
            <ChatVirtualPrependLayout forwardedRef={null}
              style={position==="hidden" ? {visibility:"hidden"} : undefined}
              context={{windowKey:"tail",firstItemIndex:0,
              scrollParent:null,initialHistoryReadPending:["pending","hidden","early"].includes(position),
              initialHistoryTailId:["hidden","early"].includes(position) ? tail.messageId : undefined,
              positionedHistoryTail:position==="positioned" ? tail : undefined}}>
              {["before-1","before-2","before-3","before-4","tail"].map(id =>
                <div key={id} data-chat-message-row style={{height:32,width:300}}>
                  {text(id)}{id==="tail" && text(id,1)}
                </div>)}
            </ChatVirtualPrependLayout>
          </div>
        </ModsChatScope.Provider>;
      }
      host.render(<TailFixture key="first" phase="pending"/>);
    `, [browserWorkerPlugin()])
    await page.locator("[data-chat-message-row] [data-function-site-pending]").last().waitFor({ state: "attached" })
    await settle()
    assert.deepEqual(await page.evaluate("window.initialTail.reads"), [])
    await page.evaluate("window.initialTail.showHiddenProbe()")
    await settle()
    assert.deepEqual(await page.evaluate("window.initialTail.reads"), [],
      "The hidden probe stays inert even when it contains the expected tail")
    await page.evaluate("window.initialTail.startEarly()")
    await page.waitForFunction("window.initialTail.reads.length===1")
    await settle()
    assert.deepEqual(await page.evaluate("window.initialTail.reads"), ["tail:0"],
      "Only the visible tail's first protected text can begin before position confirmation")
    assert.equal(await page.getByText("RAW", { exact: false }).count(), 0)
    await page.evaluate("window.initialTail.position()")
    await page.waitForFunction("window.initialTail.reads.length===4")
    assert.deepEqual(await page.evaluate("window.initialTail.reads"),
      ["tail:0", "before-1:0", "before-2:0", "before-3:0"],
      "The confirmed tail's first text reaches the existing four slots ahead of earlier rows")
    assert.equal(await page.getByText("RAW", { exact: false }).count(), 0)
    await page.evaluate("window.initialTail.reads.slice().forEach(window.initialTail.release)")
    await page.waitForFunction("window.initialTail.reads.length===6")
    assert.deepEqual(await page.evaluate("window.initialTail.reads.slice(4)"), ["before-4:0", "tail:1"],
      "Other blocks follow normal admission order")
    await page.evaluate("window.initialTail.reads.slice(4).forEach(window.initialTail.release)")
    await page.getByText("SAFE tail:1", { exact: true }).waitFor()
    assert.equal(await page.evaluate("window.initialTail.maxActive()"), 4)
    await page.evaluate("window.initialTail.reset()")
    await page.getByText("SAFE tail:1", { exact: true }).waitFor({ state: "detached" })
    await page.evaluate("window.initialTail.takeover()")
    await page.waitForFunction("window.initialTail.reads.length===4")
    assert.deepEqual(await page.evaluate("window.initialTail.reads"),
      ["before-1:0", "before-2:0", "before-3:0", "before-4:0"],
      "A user takeover without a confirmed position cannot award tail priority")
    await page.evaluate("window.initialTail.reads.slice().forEach(window.initialTail.release)")
    await page.waitForFunction("window.initialTail.reads.length===6")
    await page.evaluate("window.initialTail.reads.slice(4).forEach(window.initialTail.release)")
    await page.getByText("SAFE tail:1", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log("PASS only the visible tail's first static text leads cold display admission")
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
