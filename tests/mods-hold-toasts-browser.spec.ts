import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { mount } from "./mods-flow-browser.spec"
import { browserWorkerPlugin } from "./support/browser-worker-plugin.mjs"

async function main() {
  const output = resolve("output/mods-hold-toasts-browser")
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
  const errors: string[] = [],
    checks: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const pass = (label: string) => {
    checks.push(label)
    console.log("PASS " + label)
  }
  try {
    await mount(
      page,
      `
      import {ModsChatScope} from ${JSON.stringify(resolve("src/renderer/src/lib/mods-chat-scope.tsx"))};
      import {FunctionFeedback} from ${JSON.stringify(resolve("src/renderer/src/components/chat/FunctionFeedback.tsx"))};
      import {useChatTransientToasts} from ${JSON.stringify(resolve("src/renderer/src/lib/use-chat-transient-toasts.tsx"))};
      import {Toaster,toast as globalToast} from "sonner";
      crypto.randomUUID??=()=> 'hold-fixture-'+Math.random().toString(16).slice(2);
      const reports=[],published=[],cards=new Set(),callbacks=[],config=new Set();let deferDismiss=false,finishDismiss,deferPublication=false,finishPublication,publicationWaiting=false,receipt='',failPublication=false,publicationFailures=0;
      let entries=[{id:"toast-one",plugin:"other-mod",kind:"toast",text:"Plugin waiting",timeoutMs:200},
        {id:"status-one",plugin:"other-mod",kind:"status",text:"Status remains"}];
      window.api.mods.desktopAttach=async()=>{};window.api.mods.desktopDetach=async()=>{};
      window.api.mods.onDesktopRequest=()=>()=>{};
      window.api.mods.feedback=async()=>structuredClone(entries);
      window.api.mods.desktopFeedback=async(thread,owner)=>{receipt='';if(deferPublication){deferPublication=false;publicationWaiting=true;await new Promise(resolve=>finishPublication=resolve);publicationWaiting=false}if(failPublication){failPublication=false;publicationFailures++;throw Error('publication failed')}const value={receipt:receipt=crypto.randomUUID(),entries:thread==='a'?entries:[]};published.push(value);return structuredClone(value)};
      window.api.mods.desktopPresent=async report=>{reports.push(structuredClone(report));if(report.dismissed.length){if(deferDismiss){deferDismiss=false;await new Promise(resolve=>finishDismiss=resolve)}if(report.receipt!==receipt)return;entries=entries.filter(row=>!report.dismissed.includes(row.id));for(const fn of cards)fn({threadId:report.threadId})}};
      window.api.mods.onCardsChanged=fn=>{cards.add(fn);return()=>cards.delete(fn)};
      window.api.mods.onConfigurationChanged=fn=>{config.add(fn);return()=>config.delete(fn)};
      function Fixture(){
        const root=useRef(null),[thread,setThread]=useState('a'),[hold,setHold]=useState(true),[clipped,setClipped]=useState(false),[enabled,setEnabled]=useState(true),[readOnly,setReadOnly]=useState(false);
        useFunctionDesktop(thread,enabled&&!readOnly,root,false);
        const engine=useChatTransientToasts(thread,enabled&&!readOnly);
        window.holdFixture={reports,published,callbacks,hold:setHold,clip:setClipped,thread:setThread,enabled:setEnabled,readOnly:setReadOnly,
          native:()=>globalToast.getToasts(),deferDismiss:()=>deferDismiss=true,finishDismiss:()=>finishDismiss?.(),
          deferPublication:()=>deferPublication=true,publicationWaiting:()=>publicationWaiting,finishPublication:()=>finishPublication?.(),
          failPublication:()=>failPublication=true,publicationFailures:()=>publicationFailures,
          addToast:(id='toast-failed',text='Cancellation survives protection failure')=>{entries.push({id,kind:'toast',plugin:'notifier',text,timeoutMs:4000});for(const fn of cards)fn({threadId:thread})},
          refresh:()=>{for(const fn of cards)fn({threadId:thread})},
          engine:(id,text,duration=200)=>engine.toast.success(text,{id,duration,onAutoClose:()=>callbacks.push(['auto',id]),onDismiss:()=>callbacks.push(['dismiss',id])}),
          action:(id,text,cancel=false)=>engine.toast.info(text,{id,duration:2000,[cancel?'cancel':'action']:{label:cancel?'Cancel owned':'Action owned',onClick:()=>callbacks.push(['action',id])}}),
          dismiss:id=>engine.toast.dismiss(id),global:()=>globalToast.warning('Global stays visible',{duration:2000}),
          rebind:()=>{for(const fn of config)fn()}};
        return <><Toaster position="top-center" richColors duration={2200}/>
          <main ref={root} data-chat-thread-id={thread} style={{width:600,minHeight:150}}>
          <p>Ordinary chat</p><textarea aria-label="Composer"/>
          <ModsChatScope.Provider value={{threadId:thread,enabled}}><FunctionFeedback threadId={thread}/></ModsChatScope.Provider>
          {engine.toaster}</main>
          <aside data-claw-sidebar-host={thread} style={{height:clipped?40:160,overflowY:'auto'}}><div data-claw-results>
            <section hidden={!hold} style={{marginTop:clipped?300:0,height:80}}
              data-function-pane-key="author:board" data-function-pane-generation="current" data-function-hold-toasts="true">Reading panel</section>
          </div></aside></>;
      }
      host.render(<Fixture/>);
    `,
      [browserWorkerPlugin()]
    )
    await page.waitForFunction("window.holdFixture?.reports.some(r=>r.panes.some(p=>p.isShown))")
    assert.equal(await page.getByText("Plugin waiting", { exact: true }).count(), 0)
    assert.equal(await page.getByText("Status remains", { exact: true }).count(), 1)
    pass("actually visible panel holds another mod toast while status and composer remain")
    await page.evaluate(
      "window.holdFixture.engine('one','Engine first',350);window.holdFixture.engine('two','Engine second',350);window.holdFixture.global()"
    )
    await page.waitForTimeout(600)
    assert.equal(await page.getByText("Engine first", { exact: true }).count(), 0)
    assert.equal(await page.getByText("Engine second", { exact: true }).count(), 0)
    assert(await page.getByText("Global stays visible", { exact: true }).isVisible())
    pass(
      "engine waits beyond duration and its hidden dedicated stack leaves global notifications visible"
    )
    await page.evaluate("window.holdFixture.hold(false)")
    await page.waitForFunction("window.holdFixture.reports.some(r=>r.shown.includes('toast-one'))")
    await page.getByText("Engine first", { exact: true }).waitFor({ state: "visible" })
    assert.equal(await page.getByText("Engine second", { exact: true }).count(), 0)
    pass("closing panel releases plugin and only first FIFO engine toast")
    await page.getByText("Engine first", { exact: true }).hover()
    await page.waitForTimeout(550)
    assert(await page.getByText("Engine first", { exact: true }).isVisible())
    await page.getByLabel("Composer").hover()
    await page.getByText("Engine second", { exact: true }).waitFor({ state: "visible" })
    await page.waitForFunction("window.holdFixture.callbacks.filter(r=>r[0]==='auto').length===2")
    assert.deepEqual(await page.evaluate("window.holdFixture.callbacks"), [
      ["auto", "one"],
      ["auto", "two"]
    ])
    pass("hover pauses real Sonner display; FIFO release and auto-close callbacks occur once")
    await page.evaluate(
      "Object.assign(document.querySelector('[data-chat-thread-id]').style,{marginTop:'200px',height:'200px',overflow:'hidden'});window.holdFixture.engine('geometry','Fixed toast still expires',200)"
    )
    await page.getByText("Fixed toast still expires", { exact: true }).waitFor({ state: "visible" })
    await page.getByLabel("Composer").hover()
    await page.waitForFunction(
      "window.holdFixture.callbacks.some(row=>row[1]==='geometry')",
      null,
      { timeout: 2000 }
    )
    await page.evaluate(
      "Object.assign(document.querySelector('[data-chat-thread-id]').style,{marginTop:'',height:'',overflow:''})"
    )
    pass("fixed Sonner outside a normal clipped chat root expires and releases FIFO")
    await page.evaluate("window.holdFixture.engine('hidden','Hidden does not expire',350)")
    await page.getByText("Hidden does not expire", { exact: true }).waitFor({ state: "visible" })
    await page.evaluate(
      "window.savedFrame=window.requestAnimationFrame;window.requestAnimationFrame=()=>999;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))"
    )
    await page.waitForTimeout(550)
    assert.equal(
      await page.evaluate("window.holdFixture.callbacks.filter(row=>row[1]==='hidden').length"),
      0
    )
    assert.equal(await page.evaluate("window.holdFixture.reports.at(-1).present"), false)
    await page.evaluate(
      "window.requestAnimationFrame=window.savedFrame;delete document.visibilityState;document.dispatchEvent(new Event('visibilitychange'))"
    )
    await page.waitForFunction("window.holdFixture.callbacks.some(row=>row[1]==='hidden')")
    pass(
      "visibility hiding pauses synchronously even when animation frames stop; native report says absent"
    )
    await page.evaluate(
      "window.holdFixture.action('action','Action releases FIFO');window.holdFixture.engine('after-action','Action successor',350)"
    )
    await page.getByRole("button", { name: "Action owned", exact: true }).click()
    await page.getByText("Action successor", { exact: true }).waitFor({ state: "visible" })
    await page.waitForFunction("window.holdFixture.callbacks.some(row=>row[1]==='after-action')")
    await page.evaluate(
      "window.holdFixture.action('cancel-action','Cancel releases FIFO',true);window.holdFixture.engine('after-cancel','Cancel successor',350)"
    )
    await page.getByRole("button", { name: "Cancel owned", exact: true }).click()
    await page.getByText("Cancel successor", { exact: true }).waitFor({ state: "visible" })
    await page.waitForFunction("window.holdFixture.callbacks.some(row=>row[1]==='after-cancel')")
    pass("actual Sonner action and cancel consume their own item and do not block FIFO successors")
    const before = await page.evaluate("window.holdFixture.published.length")
    await page.evaluate("window.holdFixture.refresh()")
    await page.waitForFunction(
      "window.holdFixture.reports.at(-1).receipt===window.holdFixture.published.at(-1).receipt"
    )
    assert.equal(await page.evaluate("window.holdFixture.published.length"), before + 1)
    pass("identical layout with new publication receipt still receives a fresh ACK")
    await page.evaluate("window.holdFixture.hold(true);window.holdFixture.clip(true)")
    await page.waitForFunction("window.holdFixture.reports.at(-1).panes[0]?.isShown===false")
    assert(await page.getByText("Plugin waiting", { exact: true }).isVisible())
    pass("panel outside scroll clipping does not hold unseen toasts")
    await page.evaluate("window.holdFixture.clip(false)")
    await page.waitForFunction("window.holdFixture.reports.at(-1).panes[0]?.isShown===true")
    await page.evaluate(
      "window.holdFixture.engine('cancel','Canceled pending');window.holdFixture.dismiss('cancel')"
    )
    await page.evaluate("window.holdFixture.hold(false)")
    await page.waitForTimeout(150)
    assert.equal(await page.getByText("Canceled pending", { exact: true }).count(), 0)
    assert.equal(
      await page.evaluate("window.holdFixture.callbacks.filter(r=>r[1]==='cancel').length"),
      1
    )
    pass("queued cancellation does not create Sonner or replay after release")
    await page.evaluate("window.holdFixture.deferDismiss()")
    await page.getByRole("button", { name: "关闭提示" }).click()
    await page.waitForFunction(
      "window.holdFixture.reports.some(r=>r.dismissed.includes('toast-one'))"
    )
    await page.evaluate("window.holdFixture.deferPublication();window.holdFixture.refresh()")
    await page.waitForFunction("window.holdFixture.publicationWaiting()")
    await page.waitForTimeout(100)
    assert.equal(await page.getByText("Plugin waiting", { exact: true }).count(), 0)
    await page.evaluate("window.holdFixture.finishDismiss()")
    await page.waitForTimeout(50)
    await page.evaluate("window.holdFixture.finishPublication()")
    await page.waitForTimeout(150)
    assert.equal(await page.getByText("Plugin waiting", { exact: true }).count(), 0)
    assert(await page.getByText("Status remains", { exact: true }).isVisible())
    pass("private dismiss consumes only published transient id and retains pinned status")
    await page.evaluate("window.holdFixture.addToast()")
    await page
      .getByText("Cancellation survives protection failure", { exact: true })
      .waitFor({ state: "visible" })
    await page.evaluate("window.holdFixture.deferDismiss()")
    await page.getByRole("button", { name: "关闭提示" }).click()
    await page.waitForFunction(
      "window.holdFixture.reports.some(r=>r.dismissed.includes('toast-failed'))"
    )
    await page.evaluate("window.holdFixture.failPublication();window.holdFixture.refresh()")
    await page.waitForFunction("window.holdFixture.publicationFailures()===1")
    await page.evaluate("window.holdFixture.finishDismiss()")
    await page.waitForTimeout(50)
    await page.evaluate("window.holdFixture.refresh()")
    await page.waitForTimeout(150)
    assert.equal(
      await page.getByText("Cancellation survives protection failure", { exact: true }).count(),
      0
    )
    pass(
      "publication failure cannot clear cancellation or revive it on the next protected snapshot"
    )
    await page.evaluate(
      "window.holdFixture.addToast('toast-rebind','Cancellation survives configuration rebind')"
    )
    await page
      .getByText("Cancellation survives configuration rebind", { exact: true })
      .waitFor({ state: "visible" })
    await page.evaluate("window.holdFixture.deferDismiss()")
    await page.getByRole("button", { name: "关闭提示" }).click()
    await page.waitForFunction(
      "window.holdFixture.reports.some(r=>r.dismissed.includes('toast-rebind'))"
    )
    await page.evaluate("window.holdFixture.deferPublication();window.holdFixture.rebind()")
    await page.waitForFunction("window.holdFixture.publicationWaiting()")
    await page.evaluate("window.holdFixture.finishDismiss()")
    await page.waitForTimeout(50)
    await page.evaluate("window.holdFixture.finishPublication()")
    await page.waitForTimeout(150)
    assert.equal(
      await page.getByText("Cancellation survives configuration rebind", { exact: true }).count(),
      0
    )
    pass("configuration rebind retains cancellation while the same real session remains resident")
    await page.evaluate("window.holdFixture.readOnly(true)")
    await page.waitForTimeout(100)
    assert(await page.getByText("Status remains", { exact: true }).isVisible())
    assert.equal(await page.locator("[data-feedback-kind='toast']").count(), 0)
    pass(
      "readonly chat keeps its original resident status without creating a desktop owner or starting toast clocks"
    )
    await page.evaluate("window.holdFixture.readOnly(false)")
    await page.waitForTimeout(50)
    await page.evaluate(
      "window.holdFixture.hold(true);window.holdFixture.engine('old','Old thread pending');window.holdFixture.thread('b')"
    )
    await page.waitForTimeout(150)
    await page.evaluate("window.holdFixture.hold(false)")
    await page.waitForTimeout(150)
    assert.equal(await page.getByText("Old thread pending", { exact: true }).count(), 0)
    pass(
      "thread owner unmount discards pending notifications and never releases them into a new chat"
    )
    await page.evaluate("window.holdFixture.enabled(false)")
    await page.waitForTimeout(50)
    await page.evaluate("window.holdFixture.engine('legacy','Original global behavior')")
    await page.getByText("Original global behavior", { exact: true }).waitFor({ state: "visible" })
    pass("Mods disabled uses original global Sonner path")
    assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(output, "held-notifications.png") })
    writeFileSync(
      resolve(output, "report.json"),
      JSON.stringify(
        {
          checks,
          errors,
          scope: "Real React/DOM/Sonner; private IPC mocked, no native authority or OS paint claim"
        },
        null,
        2
      )
    )
  } catch (error) {
    writeFileSync(
      resolve(output, "failed-report.json"),
      JSON.stringify(
        {
          checks,
          errors,
          state: await page.evaluate(
            "({fixture:typeof window.holdFixture, reports:window.holdFixture?.reports,published:window.holdFixture?.published,html:document.body.innerHTML})"
          )
        },
        null,
        2
      )
    )
    throw error
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
